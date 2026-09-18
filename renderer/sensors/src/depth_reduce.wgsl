// Bevy PerspectiveProjection uses an infinite reverse-Z matrix: d = near / z.
// The nearest foreground surface wins a reduced cell (not a centre sample).
override SCALE: u32 = 4u;
@group(0) @binding(0) var depth: texture_depth_2d;
@group(0) @binding(1) var<storage, read_write> packed: array<u32>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let size = textureDimensions(depth) / SCALE;
    if (id.x >= size.x || id.y >= size.y) { return; }
    var nearest = 0.0;
    for (var y = 0u; y < SCALE; y++) {
        for (var x = 0u; x < SCALE; x++) {
            nearest = max(nearest, textureLoad(depth, vec2<i32>(id.xy * SCALE + vec2<u32>(x, y)), 0));
        }
    }
    let z = 0.5 / nearest;
    let valid = nearest > 0.0 && z >= 1.0 && z <= 120.0;
    // One little-endian u32 carries f16 depth and the separate validity byte.
    // Storage rows are tight; unlike texture copies they need no 256B padding.
    packed[id.y * size.x + id.x] = select(0u, pack2x16float(vec2<f32>(z, 0.0)) | 65536u, valid);
}
