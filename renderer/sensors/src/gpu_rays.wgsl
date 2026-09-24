// Hardware first-hit rays that reproduce `InstancedScene::cast` bit for bit.
//
// The RT cores only *generate candidates*: every BLAS triangle is a slightly
// inflated, non-opaque copy of a mesh triangle, so the hardware reports a
// superset of the triangles the CPU reference could accept. Each candidate
// is then re-evaluated here with the reference's exact IEEE f32 arithmetic,
// in glam's operation order:
//
//   world = Mat4::transform_point3(local)      x*px, y*py + ., z*pz + ., w + .
//   t     = ray_tri_distance(origin, dir, tri) Moller-Trumbore, EPS = 1e-9
//
// and the winner is the reference's: smallest t, then the smallest
// (instance_id, triangle_index, order) on an exact tie. The CPU builds the
// `Hit` (normal, point) from the returned (instance, triangle, t).
//
// Exactness rests on three things:
// * f32 add/sub/mul are correctly rounded in Vulkan; the only licence the
//   compiler has is contraction into FMA. Every product and sum passes
//   through `k()`, an XOR with a runtime zero, so no two operations can be
//   fused.
// * f32 division is NOT correctly rounded in Vulkan (2.5 ulp). The single
//   division, `1.0 / det`, is replaced by `recip_rn()`: a Newton step and a
//   neighbour search driven by an exact residual (Dekker two-product).
// * Hardware traversal order and its own t never decide anything: pass 1
//   commits candidates only to prune, and pass 2 re-examines the narrow t
//   window around the winner without pruning, so a candidate whose hardware
//   t ordering disagrees with its exact t (near-coplanar surfaces) is still
//   compared exactly.
enable wgpu_ray_query;

struct Ray {
    origin_tmax: vec4<f32>,
    direction: vec4<f32>,
}

struct Instance {
    c0: vec4<f32>,
    c1: vec4<f32>,
    c2: vec4<f32>,
    c3: vec4<f32>,
    // first vertex (3 per triangle), instance id, insertion order,
    // first `prims` entry of the mesh's plain BLAS
    info: vec4<u32>,
    // first `prims` entry of the mesh's envelope BLAS
    info2: vec4<u32>,
}

struct Params {
    // Always 0; read at run time so the compiler cannot fold `k()`.
    zero: u32,
    // Pass-2 window: [t (1 - rel) - abs, t (1 + rel) + abs].
    window_rel: f32,
    window_abs: f32,
    // bvh::MIN_INCIDENCE_COS squared, the CPU's f32 bits (host supplied).
    min_cos2: f32,
}

@group(0) @binding(0) var scene: acceleration_structure;
@group(0) @binding(1) var<storage, read> vertices: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> instances: array<Instance>;
@group(0) @binding(3) var<storage, read> rays: array<Ray>;
@group(0) @binding(4) var<storage, read_write> hits: array<vec4<u32>>;
@group(0) @binding(5) var<uniform> params: Params;
// BLAS primitive -> mesh triangle index, per BLAS range.
@group(0) @binding(6) var<storage, read> prims: array<u32>;
const MASK_PLAIN: u32 = 0x01u;
const MASK_ENVELOPE: u32 = 0x02u;

const EPS: f32 = 1e-9;

const NONE: u32 = 0xffffffffu;

fn k(x: f32) -> f32 {
    return bitcast<f32>(bitcast<u32>(x) ^ params.zero);
}
fn mul(a: f32, b: f32) -> f32 { return k(a * b); }
fn add(a: f32, b: f32) -> f32 { return k(a + b); }
fn sub(a: f32, b: f32) -> f32 { return k(a - b); }

fn vsub(a: vec3<f32>, b: vec3<f32>) -> vec3<f32> {
    return vec3<f32>(sub(a.x, b.x), sub(a.y, b.y), sub(a.z, b.z));
}
// glam Vec3::cross: x = s.y*r.z - r.y*s.z, ...
fn cross3(s: vec3<f32>, r: vec3<f32>) -> vec3<f32> {
    return vec3<f32>(
        sub(mul(s.y, r.z), mul(r.y, s.z)),
        sub(mul(s.z, r.x), mul(r.z, s.x)),
        sub(mul(s.x, r.y), mul(r.x, s.y)),
    );
}
// glam Vec3::dot: (x*x' + y*y') + z*z'
fn dot3(a: vec3<f32>, b: vec3<f32>) -> f32 {
    return add(add(mul(a.x, b.x), mul(a.y, b.y)), mul(a.z, b.z));
}
// glam Mat4::transform_point3 (column-major, SSE2 order).
fn transform_point(inst: Instance, p: vec3<f32>) -> vec3<f32> {
    var r = vec3<f32>(mul(inst.c0.x, p.x), mul(inst.c0.y, p.x), mul(inst.c0.z, p.x));
    r = vec3<f32>(add(mul(inst.c1.x, p.y), r.x), add(mul(inst.c1.y, p.y), r.y), add(mul(inst.c1.z, p.y), r.z));
    r = vec3<f32>(add(mul(inst.c2.x, p.z), r.x), add(mul(inst.c2.y, p.z), r.y), add(mul(inst.c2.z, p.z), r.z));
    return vec3<f32>(add(inst.c3.x, r.x), add(inst.c3.y, r.y), add(inst.c3.z, r.z));
}

// Veltkamp split: a = hi + lo exactly, each with <= 12 significant bits.
fn split(a: f32) -> vec2<f32> {
    let c = mul(4097.0, a);
    let hi = sub(c, sub(c, a));
    return vec2<f32>(hi, sub(a, hi));
}
// Knuth two-sum: a + b = s + e exactly.
fn two_sum(a: f32, b: f32) -> vec2<f32> {
    let s = add(a, b);
    let bb = sub(s, a);
    return vec2<f32>(s, add(sub(a, sub(s, bb)), sub(b, bb)));
}
// 1 - q d, exactly, as a non-overlapping pair (hi, lo). Dekker's product
// error is exact for these magnitudes, and 1 - round(q d) is exact
// (Sterbenz) because q ~ 1/d puts q d in [0.5, 2].
fn residual(q: f32, d: f32) -> vec2<f32> {
    let p = mul(q, d);
    let qs = split(q);
    let ds = split(d);
    let e = add(add(add(sub(mul(qs.x, ds.x), p), mul(qs.x, ds.y)), mul(qs.y, ds.x)), mul(qs.y, ds.y));
    return two_sum(sub(1.0, p), -e);
}
fn abs_pair(v: vec2<f32>) -> vec2<f32> {
    if (v.x < 0.0 || (v.x == 0.0 && v.y < 0.0)) { return -v; }
    return v;
}
// Exact order of two non-overlapping pairs of the same sign.
fn pair_less(a: vec2<f32>, b: vec2<f32>) -> bool {
    return a.x < b.x || (a.x == b.x && a.y < b.y);
}
fn next_toward(x: f32, up: bool) -> f32 {
    let b = bitcast<u32>(x);
    // Positive x: +1 bit is up. Negative x: +1 bit is down.
    if ((x > 0.0) == up) {
        return bitcast<f32>(b + 1u);
    }
    return bitcast<f32>(b - 1u);
}
// Correctly rounded 1/d (IEEE round-to-nearest) for |d| in [1e-9, 1e30].
// The float nearest to 1/d is the one with the smallest exact |1 - q d|;
// 1/d is never a midpoint (it would need a 25-bit significand times a
// 24-bit one to equal a power of two), so there are no ties to break.
fn recip_rn(d: f32) -> f32 {
    var q = 1.0 / d;
    // One Newton step with the residual brings q within about an ulp.
    let r0 = residual(q, d);
    q = add(q, mul(q, add(r0.x, r0.y)));
    var best = q;
    var best_r = abs_pair(residual(q, d));
    let lo = next_toward(q, false);
    let hi = next_toward(q, true);
    let r_lo = abs_pair(residual(lo, d));
    let r_hi = abs_pair(residual(hi, d));
    if (pair_less(r_lo, best_r)) { best = lo; best_r = r_lo; }
    if (pair_less(r_hi, best_r)) { best = hi; best_r = r_hi; }
    return best;
}

// `ray_tri_distance` on the reference's world-space triangle. Returns
// (accepted as 1.0/0.0, t).
fn exact_hit(inst_index: u32, tri_index: u32, origin: vec3<f32>, dir: vec3<f32>) -> vec2<f32> {
    let inst = instances[inst_index];
    let first = inst.info.x + tri_index * 3u;
    let a = transform_point(inst, vertices[first].xyz);
    let b = transform_point(inst, vertices[first + 1u].xyz);
    let c = transform_point(inst, vertices[first + 2u].xyz);
    let e1 = vsub(b, a);
    let e2 = vsub(c, a);
    let pvec = cross3(dir, e2);
    let det = dot3(e1, pvec);
    if (!(abs(det) >= EPS)) { return vec2<f32>(0.0, 0.0); }
    // Grazing cut, `det * det < c2 * (|n|^2 * |dir|^2)` with n = e1 x e2.
    let normal = cross3(e1, e2);
    if (mul(det, det) < mul(params.min_cos2, mul(dot3(normal, normal), dot3(dir, dir)))) {
        return vec2<f32>(0.0, 0.0);
    }
    let inv_det = recip_rn(det);
    let tvec = vsub(origin, a);
    let u = mul(dot3(tvec, pvec), inv_det);
    if (!(u >= 0.0 && u <= 1.0)) { return vec2<f32>(0.0, 0.0); }
    let qvec = cross3(tvec, e1);
    let v = mul(dot3(dir, qvec), inv_det);
    if (v < 0.0 || add(u, v) > 1.0) { return vec2<f32>(0.0, 0.0); }
    let t = mul(dot3(e2, qvec), inv_det);
    if (!(t > EPS)) { return vec2<f32>(0.0, 0.0); }
    return vec2<f32>(1.0, t);
}

struct Best {
    t: f32,
    inst: u32,
    tri: u32,
}

// Reference acceptance: strictly nearer, or an exact tie won by the smaller
// (instance_id, triangle_index, order).
fn better(t: f32, inst: u32, tri: u32, best: Best) -> bool {
    if (t < best.t) { return true; }
    if (t != best.t || best.inst == NONE) { return false; }
    let m = instances[inst].info;
    let o = instances[best.inst].info;
    if (m.y != o.y) { return m.y < o.y; }
    if (tri != best.tri) { return tri < best.tri; }
    return m.z < o.z;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) invocation: vec3<u32>) {
    let index = invocation.x;
    if (index >= arrayLength(&rays)) { return; }
    let ray = rays[index];
    let origin = ray.origin_tmax.xyz;
    let dir = ray.direction.xyz;
    let tmax = ray.origin_tmax.w;
    var best = Best(tmax, NONE, 0u);
    let slack = tmax * params.window_rel + params.window_abs;
    // Hardware queries start a little behind the true origin (tmin must be
    // >= 0), so a candidate whose exact t is ~0 but whose inflated copy the
    // hardware would place at t < 0 is still reported. Hardware t values
    // are only used relative to each other, so the shift is harmless.
    let back = params.window_abs;
    let hw_origin = origin - dir * back;

    // Pass 1: plain candidates, pruned by committing exactly-accepted ones.
    var query: ray_query;
    rayQueryInitialize(&query, scene, RayDesc(0u, MASK_PLAIN, 0.0, tmax + slack + back, hw_origin, dir));
    while (rayQueryProceed(&query)) {
        let cand = rayQueryGetCandidateIntersection(&query);
        if (cand.kind != RAY_QUERY_INTERSECTION_TRIANGLE) { continue; }
        let inst = cand.instance_custom_data;
        let tri = prims[instances[inst].info.w + cand.primitive_index];
        let hit = exact_hit(inst, tri, origin, dir);
        if (hit.x > 0.5 && better(hit.y, inst, tri, best)) {
            best = Best(hit.y, inst, tri);
            rayQueryConfirmIntersection(&query);
        }
    }

    // Pass E: sliver envelopes, unbounded and never committed, so every
    // envelope the ray starts in or crosses is examined.
    var envelopes: ray_query;
    rayQueryInitialize(&envelopes, scene, RayDesc(0u, MASK_ENVELOPE, 0.0, 3.0e38, hw_origin, dir));
    while (rayQueryProceed(&envelopes)) {
        let cand = rayQueryGetCandidateIntersection(&envelopes);
        if (cand.kind != RAY_QUERY_INTERSECTION_TRIANGLE) { continue; }
        let inst = cand.instance_custom_data;
        let tri = prims[instances[inst].info2.x + cand.primitive_index];
        let hit = exact_hit(inst, tri, origin, dir);
        if (hit.x > 0.5 && better(hit.y, inst, tri, best)) {
            best = Best(hit.y, inst, tri);
        }
    }

    // Pass 2: plain candidates in the winner's t window, compared exactly.
    if (best.inst != NONE) {
        let lo = max(0.0, best.t * (1.0 - params.window_rel) - params.window_abs);
        let hi = best.t * (1.0 + params.window_rel) + params.window_abs;
        var window: ray_query;
        rayQueryInitialize(&window, scene, RayDesc(0u, MASK_PLAIN, lo + back, hi + back, hw_origin, dir));
        while (rayQueryProceed(&window)) {
            let cand = rayQueryGetCandidateIntersection(&window);
            if (cand.kind != RAY_QUERY_INTERSECTION_TRIANGLE) { continue; }
            let inst = cand.instance_custom_data;
            let tri = prims[instances[inst].info.w + cand.primitive_index];
            let hit = exact_hit(inst, tri, origin, dir);
            if (hit.x > 0.5 && better(hit.y, inst, tri, best)) {
                best = Best(hit.y, inst, tri);
            }
        }
    }

    if (best.inst == NONE) {
        hits[index] = vec4<u32>(0u, 0u, 0u, 0u);
    } else {
        hits[index] = vec4<u32>(best.inst + 1u, best.tri, bitcast<u32>(best.t), 0u);
    }
}

// Diagnostics: exact_hit for explicit (instance, triangle) pairs carried in
// `rays[i].direction.w` / `rays[i].origin_tmax.w` bit patterns.
@compute @workgroup_size(64)
fn debug_exact(@builtin(global_invocation_id) invocation: vec3<u32>) {
    let index = invocation.x;
    if (index >= arrayLength(&rays)) { return; }
    let ray = rays[index];
    let inst = bitcast<u32>(ray.direction.w);
    let tri = bitcast<u32>(ray.origin_tmax.w);
    let hit = exact_hit(inst, tri, ray.origin_tmax.xyz, ray.direction.xyz);
    hits[index] = vec4<u32>(u32(hit.x > 0.5), bitcast<u32>(hit.y), 0u, 0u);
}
