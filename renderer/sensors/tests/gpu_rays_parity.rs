//! Hardware rays must reproduce `InstancedScene::cast` bit for bit.
//!
//! Runs on any Vulkan adapter with hardware ray queries (RTX 20xx and
//! newer); prints a skip line and passes elsewhere, so CI without a GPU is
//! not blocked. The scenes are adversarial on purpose: exact coplanar
//! duplicates (instance-id ties), shared edges and vertices (rays aimed
//! at them with sub-micrometre jitter), slivers, map-scale coordinates and
//! scaled/rotated instances.
use bevy::math::{Mat4, Quat, Vec3};
use sensors::bvh::{Blas, InstancedScene, Tri};
use sensors::gpu_rays::{GpuRayScene, Ray};

fn device() -> Option<(wgpu::Device, wgpu::Queue, String)> {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::VULKAN,
        ..wgpu::InstanceDescriptor::new_without_display_handle_from_env()
    });
    let adapter = bevy::tasks::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        ..Default::default()
    }))
    .ok()?;
    if !adapter.features().contains(wgpu::Features::EXPERIMENTAL_RAY_QUERY) {
        return None;
    }
    let name = adapter.get_info().name;
    let (device, queue) = bevy::tasks::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("gpu rays parity"),
        required_features: wgpu::Features::EXPERIMENTAL_RAY_QUERY,
        required_limits: wgpu::Limits::default().using_minimum_supported_acceleration_structure_values(),
        experimental_features: unsafe { wgpu::ExperimentalFeatures::enabled() },
        ..Default::default()
    }))
    .ok()?;
    Some((device, queue, name))
}

/// Deterministic xorshift, so a failure reproduces.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn unit(&mut self) -> f32 {
        (self.next() >> 40) as f32 / (1u64 << 24) as f32
    }
    fn range(&mut self, lo: f32, hi: f32) -> f32 {
        lo + (hi - lo) * self.unit()
    }
    fn vec(&mut self, extent: f32) -> Vec3 {
        Vec3::new(self.range(-extent, extent), self.range(-extent, extent), self.range(-extent, extent))
    }
}

fn tri(a: Vec3, b: Vec3, c: Vec3) -> Tri {
    Tri { a, b, c, instance_id: 0 }
}

/// A "foliage card" mesh plus a terrain-like grid with shared edges.
fn meshes(rng: &mut Rng) -> Vec<Vec<Tri>> {
    let mut cards = Vec::new();
    for _ in 0..400 {
        let centre = rng.vec(4.0);
        let u = rng.vec(1.0).normalize_or_zero() * rng.range(0.05, 0.6);
        let v = rng.vec(1.0).normalize_or_zero() * rng.range(0.05, 0.6);
        cards.push(tri(centre, centre + u, centre + v));
        cards.push(tri(centre + u, centre + u + v, centre + v));
    }
    // Slivers.
    for _ in 0..50 {
        let a = rng.vec(4.0);
        let b = a + rng.vec(2.0);
        let c = a.lerp(b, rng.unit()) + rng.vec(1e-4);
        cards.push(tri(a, b, c));
    }
    let mut grid = Vec::new();
    let n = 24;
    for i in 0..n {
        for j in 0..n {
            let p = |x: usize, z: usize| Vec3::new(x as f32 * 2.0 - 24.0, ((x * 7 + z * 3) % 5) as f32 * 0.05, z as f32 * 2.0 - 24.0);
            grid.push(tri(p(i, j), p(i + 1, j), p(i, j + 1)));
            grid.push(tri(p(i + 1, j), p(i + 1, j + 1), p(i, j + 1)));
        }
    }
    vec![cards, grid]
}

fn scene(rng: &mut Rng, at_scale: f32) -> (InstancedScene, Vec<Tri>) {
    let meshes = meshes(rng);
    let blases: Vec<Blas> = meshes.iter().map(|tris| Blas::build(tris.iter().copied())).collect();
    let mut scene = InstancedScene::new();
    let ids: Vec<usize> = blases.iter().map(|blas| scene.add_blas(blas)).collect();
    let mut world_tris = Vec::new();
    let mut add = |scene: &mut InstancedScene, mesh: usize, world: Mat4, id: u32| {
        scene.add_instance(ids[mesh], world, id);
        for t in &meshes[mesh] {
            world_tris.push(Tri {
                a: world.transform_point3(t.a),
                b: world.transform_point3(t.b),
                c: world.transform_point3(t.c),
                instance_id: id,
            });
        }
    };
    // Terrain at map-scale offsets, then the same grid again: exact coplanar
    // duplicates whose winner is decided by the tie-break key alone.
    let terrain = Mat4::from_translation(Vec3::new(at_scale, 0.0, -at_scale));
    add(&mut scene, 1, terrain, 7);
    add(&mut scene, 1, terrain, 3);
    for k in 0..30u32 {
        let world = Mat4::from_scale_rotation_translation(
            Vec3::splat(rng.range(0.3, 1.5)),
            Quat::from_rotation_y(rng.range(0.0, 6.28)) * Quat::from_rotation_x(rng.range(-0.2, 0.2)),
            Vec3::new(at_scale + rng.range(-20.0, 20.0), rng.range(1.0, 6.0), -at_scale + rng.range(-20.0, 20.0)),
        );
        add(&mut scene, 0, world, 100 + k % 7);
    }
    scene.build();
    (scene, world_tris)
}

fn return_grazing(low: Vec3, dir: Vec3, slope: f32) -> Vec3 {
    low + dir * 10.0 + Vec3::new(0.0, slope * 10.0, 0.0)
}

fn rays(rng: &mut Rng, world_tris: &[Tri], at_scale: f32, count: usize) -> Vec<Ray> {
    let mut out = Vec::with_capacity(count);
    let centre = Vec3::new(at_scale, 3.0, -at_scale);
    for i in 0..count {
        let origin = centre + Vec3::new(rng.range(-15.0, 15.0), rng.range(1.0, 12.0), rng.range(-15.0, 15.0));
        let target = match i % 5 {
            // Random direction.
            0 => origin + rng.vec(1.0),
            // Grazing the terrain (around the incidence cut-off).
            4 => {
                let low = Vec3::new(origin.x, rng.range(0.0, 0.3), origin.z);
                let dir = Vec3::new(rng.range(-1.0, 1.0), 0.0, rng.range(-1.0, 1.0)).normalize_or_zero();
                return_grazing(low, dir, rng.range(-0.08, 0.02))
            }
            // A triangle edge, jittered by up to a few micrometres.
            1 | 2 => {
                let t = world_tris[(rng.next() % world_tris.len() as u64) as usize];
                let edge = match rng.next() % 3 { 0 => (t.a, t.b), 1 => (t.b, t.c), _ => (t.c, t.a) };
                edge.0.lerp(edge.1, rng.unit()) + rng.vec(3e-6)
            }
            // A vertex.
            _ => {
                let t = world_tris[(rng.next() % world_tris.len() as u64) as usize];
                t.a + rng.vec(2e-6)
            }
        };
        let dir = target - origin;
        if dir.length_squared() == 0.0 {
            continue;
        }
        out.push(Ray { origin, dir: dir.normalize(), t_max: rng.range(20.0, 200.0) });
    }
    out
}

#[test]
fn hardware_rays_match_the_cpu_reference_bit_for_bit() {
    let Some((device, queue, name)) = device() else {
        eprintln!("SKIP gpu_rays parity: no Vulkan adapter with hardware ray queries");
        return;
    };
    let mut total = 0usize;
    let mut hits = 0usize;
    // SIMFORGE_GPU_RAYS_SEEDS=n adds n more seeds (soak runs).
    let extra: u64 = std::env::var("SIMFORGE_GPU_RAYS_SEEDS").ok().and_then(|v| v.parse().ok()).unwrap_or(0);
    let mut cases = vec![(0x9e3779b97f4a7c15u64, 0.0f32), (0x2545f4914f6cdd1d, 300.0), (0xda942042e4dd58b5, 1200.0)];
    for k in 0..extra {
        cases.push((0x5851f42d4c957f2d ^ (k + 1).wrapping_mul(0x9e3779b97f4a7c15), [0.0, 80.0, 450.0, 2500.0][k as usize % 4]));
    }
    for (seed, at_scale) in cases {
        let mut rng = Rng(seed);
        let (scene, world_tris) = scene(&mut rng, at_scale);
        let batch = rays(&mut rng, &world_tris, at_scale, 200_000);
        let gpu = GpuRayScene::new(&scene, device.clone(), queue.clone()).expect("build gpu scene");
        let gpu_hits = gpu.cast_hits(&scene, &batch).expect("cast");
        let mut mismatches = Vec::new();
        for (index, (ray, got)) in batch.iter().zip(&gpu_hits).enumerate() {
            let want = scene.cast(ray.origin, ray.dir, ray.t_max);
            let same = match (&want, got) {
                (None, None) => true,
                (Some(w), Some(g)) => {
                    w.distance.to_bits() == g.distance.to_bits()
                        && w.instance_id == g.instance_id
                        && w.normal.to_array().map(f32::to_bits) == g.normal.to_array().map(f32::to_bits)
                        && w.point.to_array().map(f32::to_bits) == g.point.to_array().map(f32::to_bits)
                }
                _ => false,
            };
            hits += usize::from(want.is_some());
            if !same {
                mismatches.push((index, want, *got));
            }
        }
        total += batch.len();
        if !mismatches.is_empty() {
            // Diagnose: does the shader's exact test agree with the CPU on
            // the CPU's winning triangle?
            let queries: Vec<(Ray, u32, u32)> = mismatches
                .iter()
                .filter_map(|(index, _, _)| {
                    let ray = batch[*index];
                    let (i, t, _) = scene.cast_indexed(ray.origin, ray.dir, ray.t_max)?;
                    Some((ray, i as u32, t as u32))
                })
                .collect();
            let exact = gpu.debug_exact(&queries).expect("debug");
            let raw = gpu.cast_batch(&queries.iter().map(|q| q.0).collect::<Vec<_>>()).expect("raw");
            for ((query, (accepted, t_bits)), raw) in queries.iter().zip(&exact).zip(&raw).take(12) {
                let cpu = scene.cast_indexed(query.0.origin, query.0.dir, query.0.t_max).unwrap();
                let hit = scene.hit_from(cpu.0, cpu.1, query.0.origin, query.0.dir, cpu.2);
                // Barycentrics of the CPU hit point in f64 against the world triangle.
                let (_, world, _, _) = scene.instance_records_pub().nth(cpu.0).unwrap();
                let local = scene.mesh_triangle_pub(cpu.0, cpu.1);
                let w = |v: Vec3| world.transform_point3(v).as_dvec3();
                let (a, b, c) = (w(local.a), w(local.b), w(local.c));
                let _ = hit;
                let o = query.0.origin.as_dvec3();
                let d = query.0.dir.as_dvec3();
                let e1 = b - a;
                let e2 = c - a;
                let pv = d.cross(e2);
                let det = e1.dot(pv);
                let tv = o - a;
                let u = tv.dot(pv) / det;
                let qv = tv.cross(e1);
                let v = d.dot(qv) / det;
                let t = e2.dot(qv) / det;
                let cosi = det / (e1.cross(e2).length() * d.length());
                {
                    let mesh = scene.instance_records_pub().nth(cpu.0).unwrap().0;
                    let (margin, plane_error) = sensors::gpu_rays::debug_margins(&scene, mesh);
                    let (faces, envelope) = sensors::gpu_rays::debug_candidates([local.a, local.b, local.c], margin, plane_error);
                    // Hit the world-space faces with the ray in f64.
                    let mut entry: Option<f64> = None;
                    for f in &faces {
                        let (fa, fb, fc) = (w(f[0]), w(f[1]), w(f[2]));
                        let (e1, e2) = (fb - fa, fc - fa);
                        let pv = d.cross(e2);
                        let det = e1.dot(pv);
                        if det.abs() < 1e-18 { continue; }
                        let tv = o - fa;
                        let u = tv.dot(pv) / det;
                        let qv = tv.cross(e1);
                        let v = d.dot(qv) / det;
                        let tt = e2.dot(qv) / det;
                        if u >= 0.0 && v >= 0.0 && u + v <= 1.0 && tt > 0.0 {
                            entry = Some(entry.map_or(tt, |e: f64| e.min(tt)));
                        }
                    }
                    eprintln!("   envelope {envelope} faces {} margin {margin:e} plane_error {plane_error:e} entry {entry:?} (exact t {})", faces.len(), cpu.2);
                }
                eprintln!("   f64: t {t:.6} u {u:.6} v {v:.6} cos {cosi:.4} edges {:.3} {:.3} {:.3}", (b-a).length(), (c-b).length(), (a-c).length());
                {
                    let w32 = |v: Vec3| world.transform_point3(v);
                    let (a, b, c) = (w32(local.a), w32(local.b), w32(local.c));
                    let (o, d) = (query.0.origin, query.0.dir);
                    let e1 = b - a; let e2 = c - a; let pv = d.cross(e2); let det = e1.dot(pv);
                    let inv = 1.0 / det; let tv = o - a; let u = tv.dot(pv) * inv; let qv = tv.cross(e1);
                    let v = d.dot(qv) * inv; let t = e2.dot(qv) * inv;
                    eprintln!("   f32: t {t:.6} u {u:.6} v {v:.6} det {det:e} a {a:?} o {o:?} d {d:?}");
                }
                eprintln!(
                    "cpu winner inst {} tri {} t {:?} | gpu exact on it: accepted {accepted} t {:?} | gpu raw {:?}",
                    query.1, query.2, cpu.2, f32::from_bits(*t_bits), raw
                );
            }
        }
        assert!(
            mismatches.is_empty(),
            "{name}, scale {at_scale}: {} of {} rays differ; first: {:?}",
            mismatches.len(),
            batch.len(),
            &mismatches[..mismatches.len().min(5)]
        );
    }
    eprintln!("gpu_rays parity on {name}: {total} rays ({hits} hits) bit-identical to InstancedScene::cast");
}
