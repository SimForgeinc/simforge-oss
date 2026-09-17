//! Opt-in hardware first-hit rays, not raster depth sampling.
//!
//! The static BLAS/TLAS is immutable. Dynamic actor intersections use the same
//! CPU triangle routine as the reference; hardware hits are merged in beam
//! order with strict nearest distance. GPU distance/tie arithmetic can differ
//! from CPU, including rare large first-hit range differences, not just ULPs.
//! This backend is explicit rather than a silent default change; the exhaustive
//! verification option reports hit, class, instance, distance and intensity errors.
use crate::bvh::{Hit, InstancedScene, Raycast, RaycastScene};
use crate::lidar::{LidarConfig, LidarPoint};
use crate::taxonomy::{lidar_albedo, SemanticClass};
use bevy::math::{Quat, Vec3};
use bevy::render::renderer::{RenderDevice, RenderQueue};
use std::time::Instant;
use wgpu::util::DeviceExt;

pub(crate) struct Request {
    pub config: LidarConfig,
    pub origin: Vec3,
    pub rotation: Quat,
}

pub(crate) struct GpuLidar {
    device: RenderDevice,
    queue: RenderQueue,
    tlas: wgpu::Tlas,
    vertices: wgpu::Buffer,
    instances: wgpu::Buffer,
    pipeline: wgpu::ComputePipeline,
    profile: bool,
}

fn floats(bytes: &mut Vec<u8>, values: impl IntoIterator<Item = f32>) {
    for value in values { bytes.extend_from_slice(&value.to_le_bytes()); }
}

impl GpuLidar {
    pub(crate) fn new(scene: &InstancedScene, device: RenderDevice, queue: RenderQueue, profile: bool) -> Self {
        let started = Instant::now();
        assert!(device.features().contains(wgpu::Features::EXPERIMENTAL_RAY_QUERY),
            "--lidar-backend gpu requires Vulkan hardware ray-query support");
        let gpu = device.wgpu_device();
        let mut vertex_bytes = Vec::with_capacity(scene.unique_tri_count() * 48);
        let mut sizes = Vec::new();
        let mut offsets = Vec::new();
        let mut blases = Vec::new();
        for tris in scene.gpu_meshes() {
            offsets.push((vertex_bytes.len() / 16) as u32);
            for tri in tris {
                for v in [tri.a, tri.b, tri.c] { floats(&mut vertex_bytes, [v.x, v.y, v.z, 0.0]); }
            }
            let size = wgpu::BlasTriangleGeometrySizeDescriptor {
                vertex_format: wgpu::VertexFormat::Float32x3,
                vertex_count: (tris.len() * 3) as u32,
                index_format: None, index_count: None,
                flags: wgpu::AccelerationStructureGeometryFlags::OPAQUE,
            };
            blases.push(if tris.is_empty() { None } else { Some(gpu.create_blas(
                &wgpu::CreateBlasDescriptor {
                    label: Some("lidar mesh"), flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
                    update_mode: wgpu::AccelerationStructureUpdateMode::Build,
                },
                wgpu::BlasGeometrySizeDescriptors::Triangles { descriptors: vec![size.clone()] },
            )) });
            sizes.push(size);
        }
        let vertices = gpu.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("lidar vertices"), contents: &vertex_bytes,
            usage: wgpu::BufferUsages::BLAS_INPUT | wgpu::BufferUsages::STORAGE,
        });
        let scene_instances: Vec<_> = scene.gpu_instances().collect();
        let mut tlas = gpu.create_tlas(&wgpu::CreateTlasDescriptor {
            label: Some("lidar static world"), max_instances: scene_instances.len() as u32,
            flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
            update_mode: wgpu::AccelerationStructureUpdateMode::Build,
        });
        let mut instance_bytes = Vec::with_capacity(scene_instances.len() * 8);
        for (index, &(mesh, world, id)) in scene_instances.iter().enumerate() {
            let rows = world.transpose().to_cols_array();
            tlas[index] = Some(wgpu::TlasInstance::new(
                blases[mesh].as_ref().expect("nonempty instanced mesh"), rows[..12].try_into().unwrap(), index as u32, 255,
            ));
            instance_bytes.extend_from_slice(&offsets[mesh].to_le_bytes());
            instance_bytes.extend_from_slice(&id.to_le_bytes());
        }
        let instances = gpu.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("lidar instance ids"), contents: &instance_bytes, usage: wgpu::BufferUsages::STORAGE,
        });
        let entries: Vec<_> = blases.iter().enumerate().filter_map(|(i, blas)| {
            Some(wgpu::BlasBuildEntry {
                blas: blas.as_ref()?,
                geometry: wgpu::BlasGeometries::TriangleGeometries(vec![wgpu::BlasTriangleGeometry {
                    size: &sizes[i], vertex_buffer: &vertices, first_vertex: offsets[i], vertex_stride: 16,
                    index_buffer: None, first_index: None, transform_buffer: None, transform_buffer_offset: None,
                }]),
            })
        }).collect();
        let mut encoder = gpu.create_command_encoder(&Default::default());
        encoder.build_acceleration_structures(&entries, [&tlas]);
        let submission = queue.submit([encoder.finish()]);
        device.poll(wgpu::PollType::Wait { submission_index: Some(submission), timeout: None }).expect("build lidar acceleration");
        let shader = gpu.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("lidar hardware rays"), source: wgpu::ShaderSource::Wgsl(include_str!("gpu_lidar.wgsl").into()),
        });
        let pipeline = gpu.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("lidar hardware rays"), layout: None, module: &shader, entry_point: Some("main"),
            compilation_options: Default::default(), cache: None,
        });
        println!("PROF gpuLidarBuildMs={:.3} meshes={} instances={} vertexBytes={}", started.elapsed().as_secs_f64()*1e3, entries.len(), scene_instances.len(), vertex_bytes.len());
        Self { device, queue, tlas, vertices, instances, pipeline, profile }
    }

    pub(crate) fn scan_batch(
        &self, requests: &[Request], actors: &RaycastScene,
        class_of: &(dyn Fn(u32) -> SemanticClass + Sync),
        reference: Option<&dyn Raycast>,
        statics: &InstancedScene,
    ) -> Vec<Vec<LidarPoint>> {
        if requests.is_empty() { return Vec::new(); }
        let started = Instant::now();
        let mut ranges = Vec::with_capacity(requests.len());
        let count: usize = requests.iter().map(|r| (r.config.channels.max(1) * r.config.azimuth_steps()) as usize).sum();
        let mut directions = Vec::with_capacity(count);
        let mut ray_bytes = Vec::with_capacity(count * 32);
        for request in requests {
            let cfg = &request.config;
            let first = directions.len();
            let channels = cfg.channels.max(1);
            let steps = cfg.azimuth_steps();
            let span = if cfg.hfov_deg >= 359.999 { 360.0 } else { cfg.hfov_deg };
            let offset = if cfg.hfov_deg >= 359.999 { 0.0 } else { span.to_radians() * 0.5 };
            for ch in 0..channels {
                let frac = if channels > 1 { ch as f32 / (channels - 1) as f32 } else { 0.5 };
                let elev = (cfg.vfov_deg * (0.5 - frac)).to_radians();
                for step in 0..steps {
                    let az = (step as f32 / steps as f32) * span.to_radians() - offset;
                    let dir = request.rotation.mul_vec3(Vec3::new(elev.cos()*az.cos(), elev.sin(), elev.cos()*az.sin()));
                    directions.push(dir);
                    floats(&mut ray_bytes, [request.origin.x, request.origin.y, request.origin.z, cfg.range_m, dir.x, dir.y, dir.z, 0.0]);
                }
            }
            ranges.push(first..directions.len());
        }
        let gpu = self.device.wgpu_device();
        let rays = gpu.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("lidar beam batch"), contents: &ray_bytes, usage: wgpu::BufferUsages::STORAGE,
        });
        let bytes = directions.len() as u64 * 32;
        let timestamps = self.profile.then(|| gpu.create_query_set(&wgpu::QuerySetDescriptor {
            label: Some("lidar trace timestamps"), ty: wgpu::QueryType::Timestamp, count: 2,
        }));
        let query_buffer = self.profile.then(|| gpu.create_buffer(&wgpu::BufferDescriptor {
            label: Some("lidar trace timestamps"), size: 16,
            usage: wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        }));
        let output = gpu.create_buffer(&wgpu::BufferDescriptor {
            label: Some("lidar hits"), size: bytes, usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let staging = gpu.create_buffer(&wgpu::BufferDescriptor {
            label: Some("lidar hit readback"), size: bytes + if self.profile { 16 } else { 0 }, usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let bind_group = gpu.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("lidar batch"), layout: &self.pipeline.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: self.tlas.as_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: self.vertices.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: self.instances.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 3, resource: rays.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 4, resource: output.as_entire_binding() },
            ],
        });
        let mut encoder = gpu.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("lidar trace"),
                timestamp_writes: timestamps.as_ref().map(|query_set| wgpu::ComputePassTimestampWrites {
                    query_set, beginning_of_pass_write_index: Some(0), end_of_pass_write_index: Some(1),
                }),
            });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &bind_group, &[]);
            pass.dispatch_workgroups((directions.len() as u32).div_ceil(64), 1, 1);
        }
        encoder.copy_buffer_to_buffer(&output, 0, &staging, 0, bytes);
        if let (Some(queries), Some(buffer)) = (&timestamps, &query_buffer) {
            encoder.resolve_query_set(queries, 0..2, buffer, 0);
            encoder.copy_buffer_to_buffer(buffer, 0, &staging, bytes, 16);
        }
        let submitted_at = Instant::now();
        let submission = self.queue.submit([encoder.finish()]);
        let (tx, rx) = crossbeam_channel::bounded(1);
        staging.slice(..).map_async(wgpu::MapMode::Read, move |result| { tx.send(result).expect("lidar readback receiver"); });
        self.device.poll(wgpu::PollType::Wait { submission_index: Some(submission), timeout: None }).expect("lidar frame fence");
        rx.recv().expect("lidar callback").expect("lidar buffer map");
        let mapped_at = Instant::now();
        let mapped = staging.slice(..).get_mapped_range();
        if self.profile {
            let start = u64::from_le_bytes(mapped[bytes as usize..bytes as usize+8].try_into().unwrap());
            let end = u64::from_le_bytes(mapped[bytes as usize+8..bytes as usize+16].try_into().unwrap());
            println!("PROF gpuLidarDevice traceMs={:.3}", (end-start) as f64 * f64::from(self.queue.get_timestamp_period())/1e6);
        }
        let mut scans = Vec::with_capacity(requests.len());
        let mut checked = 0usize;
        let mut hit_mismatches = 0usize;
        let mut id_mismatches = 0usize;
        let mut class_mismatches = 0usize;
        let mut max_id_distance_error = 0.0f32;
        let mut max_intensity_error = 0.0f32;
        let mut max_distance_error = 0.0f32;
        let mut squared_distance_error = 0.0f64;
        let mut distance_threshold_counts = [0usize; 4];
        let mut matched = 0usize;
        for (request, range) in requests.iter().zip(ranges) {
            let mut points = Vec::with_capacity(range.len());
            for index in range {
                let raw = &mapped[index * 32..index * 32 + 32];
                let f = |offset| f32::from_le_bytes(raw[offset..offset+4].try_into().unwrap());
                let id = u32::from_le_bytes(raw[16..20].try_into().unwrap());
                let dir = directions[index];
                let mut hit = (id != 0 && f(12) < request.config.range_m).then(|| Hit {
                    distance: f(12), point: request.origin + dir * f(12), instance_id: id,
                    normal: Vec3::new(f(0), f(4), f(8)),
                });
                if let Some(actor) = actors.cast(request.origin, dir, hit.as_ref().map_or(request.config.range_m, |h| h.distance)) { hit = Some(actor); }
                if let Some(reference) = reference {
                    checked += 1;
                    let cpu = reference.cast(request.origin, dir, request.config.range_m);
                    match (&hit, cpu) {
                        (Some(gpu), Some(cpu)) => {
                            matched += 1;
                            let error = (gpu.distance - cpu.distance).abs();
                            for (count, threshold) in distance_threshold_counts.iter_mut().zip([0.001, 0.01, 0.1, 1.0]) {
                                *count += usize::from(error > threshold);
                            }
                            if error > 0.01 && distance_threshold_counts[1] <= 8 {
                                println!("PROF gpuLidarOutlier ray={index} gpuDistance={} cpuDistance={} gpuId={} cpuId={} origin={:?} direction={:?}",
                                    gpu.distance, cpu.distance, gpu.instance_id, cpu.instance_id, request.origin, dir);
                            }
                            if error > 1.0 && id == gpu.instance_id {
                                let custom = u32::from_le_bytes(raw[20..24].try_into().unwrap()) as usize;
                                let primitive = u32::from_le_bytes(raw[24..28].try_into().unwrap()) as usize;
                                let gpu_tri = statics.gpu_hit_triangle(custom, primitive);
                                let cpu_tri = statics.closest_triangle_in_instance(cpu.instance_id, request.origin, dir);
                                let exact = |tri: crate::bvh::Tri| {
                                    let origin = request.origin.as_dvec3();
                                    let direction = dir.as_dvec3();
                                    let a = tri.a.as_dvec3();
                                    let e1 = tri.b.as_dvec3()-a;
                                    let e2 = tri.c.as_dvec3()-a;
                                    let p = direction.cross(e2);
                                    let inv_det = 1.0/e1.dot(p);
                                    let delta = origin-a;
                                    let q = delta.cross(e1);
                                    let u = delta.dot(p)*inv_det;
                                    let v = direction.dot(q)*inv_det;
                                    [e2.dot(q)*inv_det, u, v, 1.0-u-v]
                                };
                                println!("PROF gpuLidarBoundary ray={index} gpuExactTUVW={:?} cpuExactTUVW={:?} gpuTriangle={:?} cpuTriangle={:?}",
                                    exact(gpu_tri), cpu_tri.map(exact), gpu_tri, cpu_tri);
                            }
                            max_distance_error = max_distance_error.max(error);
                            squared_distance_error += f64::from(error).powi(2);
                            id_mismatches += usize::from(gpu.instance_id != cpu.instance_id);
                            if gpu.instance_id != cpu.instance_id {
                                max_id_distance_error = max_id_distance_error.max(error);
                            }
                            class_mismatches += usize::from(class_of(gpu.instance_id) != class_of(cpu.instance_id));
                            let intensity = |hit: &Hit| {
                                let cosine = hit.normal.dot(-dir.normalize_or_zero()).abs();
                                lidar_albedo(class_of(hit.instance_id)).mul_add(0.25 + 0.75*cosine, 0.0).clamp(0.0,1.0)
                            };
                            max_intensity_error = max_intensity_error.max((intensity(gpu)-intensity(&cpu)).abs());
                        }
                        (None, None) => {}
                        _ => hit_mismatches += 1,
                    }
                }
                if let Some(hit) = hit {
                    let cosine = hit.normal.dot(-dir.normalize_or_zero()).abs();
                    let intensity = lidar_albedo(class_of(hit.instance_id)).mul_add(0.25 + 0.75*cosine, 0.0).clamp(0.0,1.0);
                    points.push(LidarPoint { x: hit.point.x-request.origin.x, y: hit.point.y-request.origin.y,
                        z: hit.point.z-request.origin.z, intensity, instance_id: hit.instance_id });
                }
            }
            scans.push(points);
        }
        drop(mapped); staging.unmap();
        println!("PROF gpuLidar rays={} uploadMs={:.3} queueWaitMs={:.3} decodeMs={:.3}", directions.len(), submitted_at.duration_since(started).as_secs_f64()*1e3, mapped_at.duration_since(submitted_at).as_secs_f64()*1e3, mapped_at.elapsed().as_secs_f64()*1e3);
        if reference.is_some() {
            println!("PROF gpuLidarAccuracy checked={checked} hitMismatches={hit_mismatches} idMismatches={id_mismatches} classMismatches={class_mismatches} matched={matched} maxDistanceErrorM={max_distance_error:.8} rmsDistanceErrorM={:.8} maxIdDistanceErrorM={max_id_distance_error:.8} maxIntensityError={max_intensity_error:.8}", (squared_distance_error / matched.max(1) as f64).sqrt());
            println!("PROF gpuLidarErrorCounts over1mm={} over1cm={} over10cm={} over1m={}",
                distance_threshold_counts[0], distance_threshold_counts[1], distance_threshold_counts[2], distance_threshold_counts[3]);
        }
        scans
    }
}
