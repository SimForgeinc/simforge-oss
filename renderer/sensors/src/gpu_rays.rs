//! Hardware (RT-core) first-hit rays, bit-identical to [`InstancedScene::cast`].
//!
//! The acceleration structures are only a candidate generator: each mesh
//! triangle goes into its BLAS slightly inflated in its own plane and
//! non-opaque, so the hardware reports every triangle the reference could
//! accept (plus a margin of near misses). `gpu_rays.wgsl` re-evaluates each
//! candidate with the reference's exact f32 arithmetic and tie-break and
//! returns `(instance, triangle, t)`; the `Hit` itself is built on the CPU by
//! [`InstancedScene::hit_from`], the same constructor the CPU walk uses.
//!
//! The result therefore does not depend on the GPU, the driver, the BLAS
//! builder or traversal order, only on IEEE f32 add/sub/mul (which Vulkan
//! requires to be correctly rounded) and on the absence of FMA contraction
//! (prevented in the shader). Residual assumptions, checked by the parity
//! test rather than by the type system: denormal f32 values are preserved
//! (they do not occur at map scales) and the hardware's own ray/triangle
//! error stays below the inflation margin.
use crate::bvh::{Hit, InstancedScene};
use bevy::math::{Mat4, Vec3};
use wgpu::util::DeviceExt;

/// In-plane inflation of every BLAS triangle: `REL` of the triangle's
/// largest coordinate magnitude plus `ABS` metres, applied as an outward
/// offset of each edge. Far larger than the hardware's single-precision
/// intersection error, far smaller than any geometry.
const INFLATE_REL: f32 = 1.0 / 16384.0;
const INFLATE_ABS: f32 = 1.0e-5;
/// Safety factor over the analytic bound `eps * R / MIN_INCIDENCE_COS` on
/// how far outside its triangle an accepted f32 hit can land (R: largest
/// world coordinate magnitude in the scene).
const OVERSHOOT_FACTOR: f32 = 16.0;
/// Miter cap for the vertex offset of very sharp corners (multiples of the
/// edge offset). Below about 3.6 degrees the corner tip beyond the cap is
/// not inflated; see the module notes.
const MITER_CAP: f32 = 32.0;
/// Pass-2 window around the winner: covers the difference between the
/// hardware's t for an inflated triangle and the exact t of the original.
const WINDOW_REL: f32 = 1.0 / 4096.0;

/// One ray: origin, direction (need not be unit), exclusive maximum t.
#[derive(Clone, Copy, Debug)]
pub struct Ray {
    pub origin: Vec3,
    pub dir: Vec3,
    pub t_max: f32,
}

/// The first hit of one ray as indices into the [`InstancedScene`] the
/// device scene was built from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RawHit {
    pub instance: u32,
    pub triangle: u32,
    /// `t` as f32 bits (compare bit-exactly).
    pub t_bits: u32,
}

impl RawHit {
    pub fn t(&self) -> f32 {
        f32::from_bits(self.t_bits)
    }
}

/// The device copy of one [`InstancedScene`]: BLAS per mesh, TLAS over its
/// instances, and the exact local vertices and instance table the shader
/// re-evaluates candidates with.
pub struct GpuRayScene {
    device: wgpu::Device,
    queue: wgpu::Queue,
    tlas: wgpu::Tlas,
    _blases: Vec<wgpu::Blas>,
    vertices: wgpu::Buffer,
    prims: wgpu::Buffer,
    instances: wgpu::Buffer,
    params: wgpu::Buffer,
    pipeline: wgpu::ComputePipeline,
    pub build_ms: f64,
    pub unique_triangles: usize,
    pub instance_count: usize,
    /// Triangles represented by an envelope (slivers, degenerates).
    pub envelope_triangles: usize,
}

/// A headless Vulkan device with hardware ray queries, for tests and tools
/// (`None` when the machine has none). The service uses Bevy's device.
pub fn headless_device() -> Option<(wgpu::Device, wgpu::Queue, String)> {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::VULKAN,
        ..wgpu::InstanceDescriptor::new_without_display_handle_from_env()
    });
    let adapter = bevy::tasks::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        ..Default::default()
    }))
    // fallback-ok: a capability probe; None tells the caller there is no such device
    .ok()?;
    if !adapter
        .features()
        .contains(wgpu::Features::EXPERIMENTAL_RAY_QUERY)
    {
        return None;
    }
    let name = adapter.get_info().name;
    let (device, queue) = bevy::tasks::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("gpu rays headless"),
        required_features: wgpu::Features::EXPERIMENTAL_RAY_QUERY,
        required_limits:
            wgpu::Limits::default().using_minimum_supported_acceleration_structure_values(),
        // SAFETY: ray queries are an experimental wgpu feature; this device
        // only runs the ray pipeline of this module.
        experimental_features: unsafe { wgpu::ExperimentalFeatures::enabled() },
        ..Default::default()
    }))
    // fallback-ok: a capability probe; None tells the caller there is no such device
    .ok()?;
    Some((device, queue, name))
}

/// Whether `device` can run [`GpuRayScene`].
pub fn supported(device: &wgpu::Device) -> bool {
    device
        .features()
        .contains(wgpu::Features::EXPERIMENTAL_RAY_QUERY)
}

/// Offset each edge of `tri` outward by `margin` within its plane and return
/// the enlarged triangle (miter vertices, capped for sharp corners).
fn inflate(tri: [Vec3; 3], extra: f32) -> [Vec3; 3] {
    let scale = tri
        .iter()
        .flat_map(|v| [v.x.abs(), v.y.abs(), v.z.abs()])
        .fold(0.0f32, f32::max);
    let margin = scale * INFLATE_REL + INFLATE_ABS + extra;
    let normal = (tri[1] - tri[0]).cross(tri[2] - tri[0]);
    if !(normal.length_squared() > 0.0) || !normal.is_finite() {
        // Degenerate: the reference rejects it (|det| < EPS for any ray), so
        // a zero-area BLAS entry is harmless.
        return tri;
    }
    let n = normal.normalize();
    // Outward in-plane normal of edge i (from vertex i to i+1).
    let outward = |i: usize| -> Vec3 {
        let edge = tri[(i + 1) % 3] - tri[i];
        let out = edge.cross(n).normalize_or_zero();
        // Make sure it points away from the opposite vertex.
        if out.dot(tri[(i + 2) % 3] - tri[i]) > 0.0 {
            -out
        } else {
            out
        }
    };
    let o = [outward(0), outward(1), outward(2)];
    let mut result = tri;
    for v in 0..3 {
        // Vertex v joins edges (v-1) and v.
        let a = o[(v + 2) % 3];
        let b = o[v];
        let bisector = a + b;
        let cos_half_sq = (1.0 + a.dot(b)) * 0.5;
        let offset = if cos_half_sq > 1.0e-12 {
            // Miter: move along a+b so both offset edges pass through it.
            let length = (margin / cos_half_sq.sqrt()).min(margin * MITER_CAP);
            bisector.normalize_or_zero() * length
        } else {
            Vec3::ZERO
        };
        // Also push the vertex outward along its own direction from the
        // centroid, so the enlarged triangle strictly contains the original
        // even where rounding of the miter would shave it.
        let centroid = (tri[0] + tri[1] + tri[2]) / 3.0;
        let away = (tri[v] - centroid).normalize_or_zero() * margin;
        result[v] = tri[v] + offset + away;
    }
    result
}

/// Shape factor above which a triangle is treated as a sliver: longest edge
/// over its shortest height. A sliver's plane is ill-defined in f32, so the
/// reference can accept rays that cross a *tilted* version of it, with t
/// off by centimetres; an in-plane inflation cannot cover that.
const SLIVER_SHAPE: f32 = 64.0;
/// Envelope faces are traversed in their own pass that never commits
/// (an envelope face's hardware t says nothing useful about the exact t,
/// and a ray can start inside an envelope), so they cannot prune anything.
/// TLAS instance masks of the two candidate groups.
const MASK_PLAIN: u8 = 0x01;
const MASK_ENVELOPE: u8 = 0x02;
/// Safety factor on a sliver's plane-tilt displacement bound.
const SLIVER_FACTOR: f32 = 16.0;

/// Candidate primitives for one mesh triangle: the in-plane inflated
/// triangle, or for slivers and degenerates a closed envelope (an
/// axis-aligned box grown by the sliver's error bound) that every ray the
/// reference could accept on it must start in or cross.
fn candidates(tri: [Vec3; 3], margin: f32, plane_error: f32) -> (Vec<[Vec3; 3]>, bool) {
    let longest = (tri[1] - tri[0])
        .length()
        .max((tri[2] - tri[1]).length())
        .max((tri[0] - tri[2]).length());
    let cross = (tri[1] - tri[0]).cross(tri[2] - tri[0]);
    let area2 = cross.length();
    let well_shaped = area2.is_finite() && area2 > 0.0 && longest * longest <= SLIVER_SHAPE * area2;
    if well_shaped {
        return (vec![inflate(tri, margin)], false);
    }
    // A sliver's f32 plane can tilt by ~(coordinate rounding / height), which
    // displaces an accepted hit by up to that tilt times the sliver's
    // length: `plane_error * shape` (plane_error ~ eps * R, in local units).
    let shape = if area2 > 0.0 {
        longest * longest / area2
    } else {
        f32::INFINITY
    };
    let pad = margin
        + tri
            .iter()
            .map(|v| v.abs().max_element())
            .fold(0.0f32, f32::max)
            * INFLATE_REL
        + INFLATE_ABS
        + (plane_error * shape).min(longest.max(margin) * 4.0 + plane_error * 1.0e4);
    // A box around the triangle grown by `pad` contains every point within
    // `pad` of it, whatever the sliver's (ill-defined) plane.
    let min = tri
        .iter()
        .fold(Vec3::splat(f32::INFINITY), |m, v| m.min(*v))
        - Vec3::splat(pad);
    let max = tri
        .iter()
        .fold(Vec3::splat(f32::NEG_INFINITY), |m, v| m.max(*v))
        + Vec3::splat(pad);
    let corner = |i: u32| {
        Vec3::new(
            if i & 1 == 0 { min.x } else { max.x },
            if i & 2 == 0 { min.y } else { max.y },
            if i & 4 == 0 { min.z } else { max.z },
        )
    };
    let quads = [
        [0, 1, 3, 2],
        [4, 6, 7, 5],
        [0, 4, 5, 1],
        [2, 3, 7, 6],
        [0, 2, 6, 4],
        [1, 5, 7, 3],
    ];
    let mut faces = Vec::with_capacity(12);
    for q in quads {
        faces.push([corner(q[0]), corner(q[1]), corner(q[2])]);
        faces.push([corner(q[0]), corner(q[2]), corner(q[3])]);
    }
    (faces, true)
}

/// Diagnostics: the candidate faces [`GpuRayScene::new`] builds for a
/// local triangle with the given margins, and whether it is an envelope.
#[doc(hidden)]
pub fn debug_candidates(tri: [Vec3; 3], margin: f32, plane_error: f32) -> (Vec<[Vec3; 3]>, bool) {
    candidates(tri, margin, plane_error)
}

/// Diagnostics: `(overshoot, plane_error)` margins [`GpuRayScene::new`]
/// uses for mesh `mesh` of `scene`.
#[doc(hidden)]
pub fn debug_margins(scene: &InstancedScene, mesh: usize) -> (f32, f32) {
    let (world_radius, min_scale) = radius_and_scale(scene);
    let s = if min_scale[mesh].is_finite() && min_scale[mesh] > 0.0 {
        min_scale[mesh]
    } else {
        1.0
    };
    let overshoot =
        OVERSHOOT_FACTOR * f32::EPSILON * world_radius.max(1.0) / crate::bvh::MIN_INCIDENCE_COS;
    (
        overshoot / s,
        SLIVER_FACTOR * f32::EPSILON * world_radius.max(1.0) / s,
    )
}

fn radius_and_scale(scene: &InstancedScene) -> (f32, Vec<f32>) {
    let mut world_radius = 0.0f32;
    let mesh_count = scene.gpu_meshes().count();
    let mut min_scale = vec![f32::INFINITY; mesh_count];
    for (mesh, world, _, _) in scene.instance_records() {
        let (min, max) = scene.mesh_bounds(mesh);
        for x in [min.x, max.x] {
            for y in [min.y, max.y] {
                for z in [min.z, max.z] {
                    world_radius = world_radius.max(
                        world
                            .transform_point3(Vec3::new(x, y, z))
                            .abs()
                            .max_element(),
                    );
                }
            }
        }
        let scale = world
            .x_axis
            .truncate()
            .length()
            .min(world.y_axis.truncate().length())
            .min(world.z_axis.truncate().length());
        min_scale[mesh] = min_scale[mesh].min(scale);
    }
    (world_radius, min_scale)
}

impl GpuRayScene {
    /// Build the device scene for `scene` (which must already be built).
    pub fn new(
        scene: &InstancedScene,
        device: wgpu::Device,
        queue: wgpu::Queue,
    ) -> anyhow::Result<Self> {
        let started = std::time::Instant::now();
        anyhow::ensure!(
            supported(&device),
            "GPU ray scene: the device has no hardware ray-query support"
        );
        // World overshoot bound (see OVERSHOOT_FACTOR), then per mesh in its
        // own units: divided by the smallest scale any instance applies.
        let records: Vec<(usize, Mat4, u32, u32)> = scene.instance_records().collect();
        let (world_radius, min_scale) = radius_and_scale(scene);
        let overshoot =
            OVERSHOOT_FACTOR * f32::EPSILON * world_radius.max(1.0) / crate::bvh::MIN_INCIDENCE_COS;
        let window_abs = 2.0 * overshoot;
        // Exact local vertices (shader) and candidate faces (BLAS input).
        // Every mesh gets up to two BLASes: `PLAIN` (in-plane inflated
        // triangles, safe to prune on) and `ENVELOPE` (sliver/degenerate
        // envelopes, traversed separately and never pruned on).
        let mut exact = Vec::<u8>::new();
        let mut inflated = Vec::<u8>::new();
        let mut first_vertex = Vec::new();
        let push = |bytes: &mut Vec<u8>, v: Vec3| {
            for value in [v.x, v.y, v.z, 0.0] {
                bytes.extend_from_slice(&value.to_le_bytes());
            }
        };
        let mut prim_map = Vec::<u8>::new();
        // Per mesh and group: (first prim-map entry, first BLAS vertex, prims).
        let mut groups: Vec<[(u32, u32, usize); 2]> = Vec::new();
        let mut envelopes = 0usize;
        let mut tri_total = 0usize;
        for (mesh, tris) in scene.gpu_meshes().enumerate() {
            first_vertex.push((exact.len() / 16) as u32);
            tri_total += tris.len();
            let scale = if min_scale[mesh].is_finite() && min_scale[mesh] > 0.0 {
                min_scale[mesh]
            } else {
                1.0
            };
            let extra = overshoot / scale;
            let plane_error = SLIVER_FACTOR * f32::EPSILON * world_radius.max(1.0) / scale;
            let mut faces_by_group: [Vec<(u32, [Vec3; 3])>; 2] = [Vec::new(), Vec::new()];
            for (index, tri) in tris.iter().enumerate() {
                for v in [tri.a, tri.b, tri.c] {
                    push(&mut exact, v);
                }
                let (faces, envelope) = candidates([tri.a, tri.b, tri.c], extra, plane_error);
                envelopes += usize::from(envelope);
                for face in faces {
                    faces_by_group[usize::from(envelope)].push((index as u32, face));
                }
            }
            let mut entry = [(0u32, 0u32, 0usize); 2];
            for (group, faces) in faces_by_group.iter().enumerate() {
                entry[group] = (
                    (prim_map.len() / 4) as u32,
                    (inflated.len() / 16) as u32,
                    faces.len(),
                );
                for (index, face) in faces {
                    for v in face {
                        push(&mut inflated, *v);
                    }
                    prim_map.extend_from_slice(&index.to_le_bytes());
                }
            }
            groups.push(entry);
        }
        let unique_triangles = tri_total;
        anyhow::ensure!(unique_triangles > 0, "GPU ray scene: no triangles");
        let vertices = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("gpu rays exact vertices"),
            contents: &exact,
            usage: wgpu::BufferUsages::STORAGE,
        });
        let prims = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("gpu rays primitive map"),
            contents: &prim_map,
            usage: wgpu::BufferUsages::STORAGE,
        });
        let blas_vertices = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("gpu rays candidate vertices"),
            contents: &inflated,
            usage: wgpu::BufferUsages::BLAS_INPUT,
        });
        let size_of = |count: usize| wgpu::BlasTriangleGeometrySizeDescriptor {
            vertex_format: wgpu::VertexFormat::Float32x3,
            vertex_count: (count * 3) as u32,
            index_format: None,
            index_count: None,
            // Non-opaque: every candidate reaches the shader.
            flags: wgpu::AccelerationStructureGeometryFlags::empty(),
        };
        let sizes: Vec<[wgpu::BlasTriangleGeometrySizeDescriptor; 2]> = groups
            .iter()
            .map(|g| [size_of(g[0].2), size_of(g[1].2)])
            .collect();
        let blases: Vec<[Option<wgpu::Blas>; 2]> = groups
            .iter()
            .zip(&sizes)
            .map(|(g, size)| {
                std::array::from_fn(|group| {
                    (g[group].2 > 0).then(|| {
                        device.create_blas(
                            &wgpu::CreateBlasDescriptor {
                                label: Some(if group == 0 {
                                    "gpu rays mesh"
                                } else {
                                    "gpu rays envelopes"
                                }),
                                flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
                                update_mode: wgpu::AccelerationStructureUpdateMode::Build,
                            },
                            wgpu::BlasGeometrySizeDescriptors::Triangles {
                                descriptors: vec![size[group].clone()],
                            },
                        )
                    })
                })
            })
            .collect();
        anyhow::ensure!(
            records.len() < (1 << 24),
            "GPU ray scene: {} instances exceed the 24-bit custom index",
            records.len()
        );
        let tlas_entries: usize = records
            .iter()
            .map(|(mesh, ..)| blases[*mesh].iter().filter(|b| b.is_some()).count())
            .sum();
        let mut tlas = device.create_tlas(&wgpu::CreateTlasDescriptor {
            label: Some("gpu rays world"),
            max_instances: tlas_entries.max(1) as u32,
            flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
            update_mode: wgpu::AccelerationStructureUpdateMode::Build,
        });
        let mut instance_bytes = Vec::with_capacity(records.len() * 96);
        let mut slot = 0usize;
        for (index, &(mesh, world, instance_id, order)) in records.iter().enumerate() {
            let rows = world.transpose().to_cols_array();
            for (group, blas) in blases[mesh].iter().enumerate() {
                if let Some(blas) = blas {
                    let mask = if group == 0 {
                        MASK_PLAIN
                    } else {
                        MASK_ENVELOPE
                    };
                    tlas[slot] = Some(wgpu::TlasInstance::new(
                        blas,
                        rows[..12].try_into().unwrap(),
                        index as u32,
                        mask,
                    ));
                    slot += 1;
                }
            }
            for value in world.to_cols_array() {
                instance_bytes.extend_from_slice(&value.to_le_bytes());
            }
            for value in [
                first_vertex[mesh],
                instance_id,
                order,
                groups[mesh][0].0,
                groups[mesh][1].0,
                0,
                0,
                0,
            ] {
                instance_bytes.extend_from_slice(&value.to_le_bytes());
            }
        }
        let instances = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("gpu rays instances"),
            contents: &instance_bytes,
            usage: wgpu::BufferUsages::STORAGE,
        });
        let mut entries: Vec<wgpu::BlasBuildEntry> = Vec::new();
        for (mesh, pair) in blases.iter().enumerate() {
            for (group, blas) in pair.iter().enumerate() {
                // fallback-ok: a mesh without slivers has no envelope BLAS to build
                let Some(blas) = blas else { continue };
                entries.push(wgpu::BlasBuildEntry {
                    blas,
                    geometry: wgpu::BlasGeometries::TriangleGeometries(vec![
                        wgpu::BlasTriangleGeometry {
                            size: &sizes[mesh][group],
                            vertex_buffer: &blas_vertices,
                            first_vertex: groups[mesh][group].1,
                            vertex_stride: 16,
                            index_buffer: None,
                            first_index: None,
                            transform_buffer: None,
                            transform_buffer_offset: None,
                        },
                    ]),
                });
            }
        }
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("gpu rays build"),
        });
        encoder.build_acceleration_structures(&entries, [&tlas]);
        let submission = queue.submit([encoder.finish()]);
        device
            .poll(wgpu::PollType::Wait {
                submission_index: Some(submission),
                timeout: None,
            })
            .map_err(|error| anyhow::anyhow!("GPU ray scene build: {error}"))?;
        drop(entries);
        // The BLASes own their geometry now; the inflated input can go.
        drop(blas_vertices);
        let params = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("gpu rays params"),
            contents: &[
                0u32.to_le_bytes(),
                WINDOW_REL.to_le_bytes(),
                window_abs.to_le_bytes(),
                (crate::bvh::MIN_INCIDENCE_COS * crate::bvh::MIN_INCIDENCE_COS).to_le_bytes(),
            ]
            .concat(),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("gpu rays"),
            source: wgpu::ShaderSource::Wgsl(include_str!("gpu_rays.wgsl").into()),
        });
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("gpu rays"),
            layout: None,
            module: &shader,
            entry_point: Some("main"),
            compilation_options: Default::default(),
            cache: None,
        });
        Ok(Self {
            device,
            queue,
            tlas,
            _blases: blases.into_iter().flatten().flatten().collect(),
            vertices,
            prims,
            instances,
            params,
            pipeline,
            build_ms: started.elapsed().as_secs_f64() * 1e3,
            unique_triangles,
            instance_count: records.len(),
            envelope_triangles: envelopes,
        })
    }

    /// First hits of `rays`, in order. Blocks until the device has answered.
    pub fn cast_batch(&self, rays: &[Ray]) -> anyhow::Result<Vec<Option<RawHit>>> {
        let records: Vec<[f32; 8]> = rays
            .iter()
            .map(|r| {
                [
                    r.origin.x, r.origin.y, r.origin.z, r.t_max, r.dir.x, r.dir.y, r.dir.z, 0.0,
                ]
            })
            .collect();
        Ok(self
            .run(&self.pipeline, &records)?
            .into_iter()
            .map(|w| {
                (w[0] != 0).then(|| RawHit {
                    instance: w[0] - 1,
                    triangle: w[1],
                    t_bits: w[2],
                })
            })
            .collect())
    }

    /// Diagnostics: the shader's exact test for explicit `(ray, instance,
    /// triangle)` triples, as `(accepted, t bits)`.
    pub fn debug_exact(&self, queries: &[(Ray, u32, u32)]) -> anyhow::Result<Vec<(bool, u32)>> {
        let shader = self
            .device
            .create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("gpu rays debug"),
                source: wgpu::ShaderSource::Wgsl(include_str!("gpu_rays.wgsl").into()),
            });
        let pipeline = self
            .device
            .create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some("gpu rays debug"),
                layout: None,
                module: &shader,
                entry_point: Some("debug_exact"),
                compilation_options: Default::default(),
                cache: None,
            });
        let records: Vec<[f32; 8]> = queries
            .iter()
            .map(|(r, instance, triangle)| {
                [
                    r.origin.x,
                    r.origin.y,
                    r.origin.z,
                    f32::from_bits(*triangle),
                    r.dir.x,
                    r.dir.y,
                    r.dir.z,
                    f32::from_bits(*instance),
                ]
            })
            .collect();
        Ok(self
            .run(&pipeline, &records)?
            .into_iter()
            .map(|w| (w[0] != 0, w[1]))
            .collect())
    }

    fn run(
        &self,
        pipeline: &wgpu::ComputePipeline,
        records: &[[f32; 8]],
    ) -> anyhow::Result<Vec<[u32; 4]>> {
        if records.is_empty() {
            return Ok(Vec::new());
        }
        let groups = (records.len() as u32).div_ceil(64);
        anyhow::ensure!(
            groups <= 65535,
            "GPU ray batch of {} rays is too large for one dispatch",
            records.len()
        );
        let mut ray_bytes = Vec::with_capacity(records.len() * 32);
        for record in records {
            for value in record {
                ray_bytes.extend_from_slice(&value.to_bits().to_le_bytes());
            }
        }
        let device = &self.device;
        let ray_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("gpu rays batch"),
            contents: &ray_bytes,
            usage: wgpu::BufferUsages::STORAGE,
        });
        let bytes = records.len() as u64 * 16;
        let output = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("gpu rays hits"),
            size: bytes,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let staging = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("gpu rays readback"),
            size: bytes,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let layout = pipeline.get_bind_group_layout(0);
        let mut entries = vec![
            wgpu::BindGroupEntry {
                binding: 1,
                resource: self.vertices.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: self.instances.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 3,
                resource: ray_buffer.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 4,
                resource: output.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 5,
                resource: self.params.as_entire_binding(),
            },
        ];
        if std::ptr::eq(pipeline, &self.pipeline) {
            entries.push(wgpu::BindGroupEntry {
                binding: 6,
                resource: self.prims.as_entire_binding(),
            });
        }
        if std::ptr::eq(pipeline, &self.pipeline) {
            entries.insert(
                0,
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: self.tlas.as_binding(),
                },
            );
        }
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("gpu rays batch"),
            layout: &layout,
            entries: &entries,
        });
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("gpu rays trace"),
        });
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("gpu rays trace"),
                timestamp_writes: None,
            });
            pass.set_pipeline(pipeline);
            pass.set_bind_group(0, &bind_group, &[]);
            pass.dispatch_workgroups(groups, 1, 1);
        }
        encoder.copy_buffer_to_buffer(&output, 0, &staging, 0, bytes);
        let submission = self.queue.submit([encoder.finish()]);
        let (tx, rx) = std::sync::mpsc::channel();
        staging
            .slice(..)
            .map_async(wgpu::MapMode::Read, move |result| {
                // fallback-ok: the receiver outlives the map; a closed channel cannot occur
                let _ = tx.send(result);
            });
        device
            .poll(wgpu::PollType::Wait {
                submission_index: Some(submission),
                timeout: None,
            })
            .map_err(|error| anyhow::anyhow!("GPU ray batch: {error}"))?;
        rx.recv()
            .map_err(|_| anyhow::anyhow!("GPU ray batch: readback callback dropped"))?
            .map_err(|error| anyhow::anyhow!("GPU ray batch readback: {error}"))?;
        let mapped = staging.slice(..).get_mapped_range();
        let out = mapped
            .chunks_exact(16)
            .map(|record| {
                std::array::from_fn(|i| {
                    u32::from_le_bytes(record[i * 4..i * 4 + 4].try_into().unwrap())
                })
            })
            .collect();
        drop(mapped);
        staging.unmap();
        Ok(out)
    }

    /// [`Self::cast_batch`], resolved to reference [`Hit`]s through `scene`
    /// (the scene this device copy was built from).
    pub fn cast_hits(
        &self,
        scene: &InstancedScene,
        rays: &[Ray],
    ) -> anyhow::Result<Vec<Option<Hit>>> {
        Ok(self
            .cast_batch(rays)?
            .into_iter()
            .zip(rays)
            .map(|(raw, ray)| {
                raw.map(|raw| {
                    scene.hit_from(
                        raw.instance as usize,
                        raw.triangle as usize,
                        ray.origin,
                        ray.dir,
                        raw.t(),
                    )
                })
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inflation_contains_the_original_triangle_with_margin() {
        let tris = [
            [
                Vec3::new(0.0, 0.0, 0.0),
                Vec3::new(1.0, 0.0, 0.0),
                Vec3::new(0.0, 1.0, 0.0),
            ],
            // A sliver.
            [
                Vec3::new(100.0, 2.0, 5.0),
                Vec3::new(130.0, 2.0, 5.0),
                Vec3::new(115.0, 2.001, 5.0),
            ],
            // Tilted, far from the origin.
            [
                Vec3::new(-250.0, 10.0, 80.0),
                Vec3::new(-249.0, 11.0, 80.5),
                Vec3::new(-250.5, 10.2, 81.0),
            ],
        ];
        for tri in tris {
            let big = inflate(tri, 0.0);
            let n = (tri[1] - tri[0]).cross(tri[2] - tri[0]).normalize();
            // Same plane.
            for v in big {
                assert!(
                    (v - tri[0]).dot(n).abs() < 1e-4,
                    "{v:?} left the plane of {tri:?}"
                );
            }
            // Every original vertex lies strictly inside the enlarged one
            // (all three barycentrics positive).
            let bary = |p: Vec3| {
                let (a, b, c) = (big[0], big[1], big[2]);
                let area = (b - a).cross(c - a).dot(n);
                [
                    (c - b).cross(p - b).dot(n) / area,
                    (a - c).cross(p - c).dot(n) / area,
                    (b - a).cross(p - a).dot(n) / area,
                ]
            };
            for v in tri {
                assert!(
                    bary(v).iter().all(|w| *w > 0.0),
                    "{v:?} not strictly inside {big:?}"
                );
            }
        }
    }
}
