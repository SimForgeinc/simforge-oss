#import bevy_pbr::{forward_io::{VertexOutput, FragmentOutput}, mesh_functions::get_tag}
#import bevy_render::color_operations::srgb_to_linear_rgb

@fragment
fn fragment(in: VertexOutput) -> FragmentOutput {
    let tag = get_tag(in.instance_index);
    let bytes = vec3<f32>(f32(tag & 255u), f32((tag >> 8u) & 255u), f32((tag >> 16u) & 255u));
    var out: FragmentOutput;
    out.color = vec4<f32>(srgb_to_linear_rgb(bytes / 255.0), 1.0);
    return out;
}
