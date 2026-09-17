enable wgpu_ray_query;

struct Ray { origin_range: vec4<f32>, direction: vec4<f32> }
struct Hit { normal_distance: vec4<f32>, ids: vec4<u32> }
@group(0) @binding(0) var scene: acceleration_structure;
@group(0) @binding(1) var<storage, read> vertices: array<vec4<f32>>;
// Instance metadata is (first vertex, legend id).
@group(0) @binding(2) var<storage, read> instances: array<vec2<u32>>;
@group(0) @binding(3) var<storage, read> rays: array<Ray>;
@group(0) @binding(4) var<storage, read_write> hits: array<Hit>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) invocation: vec3<u32>) {
    let index = invocation.x;
    if index >= arrayLength(&rays) { return; }
    let ray = rays[index];
    var query: ray_query;
    rayQueryInitialize(&query, scene, RayDesc(0u, 255u, 1e-9, ray.origin_range.w, ray.origin_range.xyz, ray.direction.xyz));
    while rayQueryProceed(&query) {}
    let intersection = rayQueryGetCommittedIntersection(&query);
    var result = Hit(vec4<f32>(0.0), vec4<u32>(0u));
    if intersection.kind != RAY_QUERY_INTERSECTION_NONE {
        let instance = instances[intersection.instance_custom_data];
        let first = instance.x + intersection.primitive_index * 3u;
        let a = intersection.object_to_world * vec4<f32>(vertices[first].xyz, 1.0);
        let b = intersection.object_to_world * vec4<f32>(vertices[first + 1u].xyz, 1.0);
        let c = intersection.object_to_world * vec4<f32>(vertices[first + 2u].xyz, 1.0);
        result.normal_distance = vec4<f32>(normalize(cross(b - a, c - a)), intersection.t);
        result.ids = vec4<u32>(instance.y, intersection.instance_custom_data, intersection.primitive_index, 0u);
    }
    hits[index] = result;
}
