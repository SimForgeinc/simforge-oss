// Dash-cam camera model, step 3: apply the metered exposure and the WDR tone
// curve `f(x) = log2(1 + c*x) / log2(1 + c*W)` to luminance, keeping chroma
// (with highlight desaturation), then saturation and contrast. See
// camera_model_meter.wgsl and `render_core::camera_model`.

#import bevy_core_pipeline::fullscreen_vertex_shader::FullscreenVertexOutput

struct CameraParams {
    // x: base EV100 (the incident meter), y: compensation (stops),
    // z: min EV100, w: max EV100
    exposure: vec4<f32>,
    // x: auto (1) / fixed (0), y: metering mode (0 average, 1 center,
    // 2 dashcam), z: trim fraction, w: key (display-linear mean target)
    metering: vec4<f32>,
    // x: curve c, y: 1 / log2(1 + c*W), z: saturation, w: contrast
    curve: vec4<f32>,
    // x: extra grading exposure (stops), y: bins min log2, z: bins log2
    // range, w: width in pixels
    misc: vec4<f32>,
    // x: height in pixels
    size: vec4<f32>,
};

const LUMA = vec3<f32>(0.2126, 0.7152, 0.0722);

@group(0) @binding(0) var<uniform> apply_params: CameraParams;
@group(0) @binding(1) var apply_frame: texture_2d<f32>;
@group(0) @binding(2) var<storage, read> apply_result: array<f32, 4>;

@fragment
fn apply_pass(in: FullscreenVertexOutput) -> @location(0) vec4<f32> {
    let texel = textureLoad(apply_frame, vec2<i32>(in.position.xy), 0);
    let scale = exp2(apply_result[1] + apply_params.misc.x);
    let color = max(texel.rgb, vec3(0.0)) * scale;
    let luminance = dot(color, LUMA);
    let c = apply_params.curve.x;
    let mapped = log2(1.0 + c * luminance) * apply_params.curve.y;
    var out = color * (mapped / max(luminance, 1.0e-9));
    // Highlights desaturate towards white instead of clipping a channel.
    let peak = max(out.r, max(out.g, out.b));
    if peak > 1.0 {
        let t = clamp((peak - 1.0) / peak, 0.0, 1.0);
        out = mix(out / peak, vec3(1.0), t);
    }
    out = mix(vec3(dot(out, LUMA)), out, apply_params.curve.z);
    // Contrast pivots on display mid grey in log space.
    let mid = 0.18;
    out = mid * pow(max(out, vec3(1.0e-6)) / mid, vec3(apply_params.curve.w));
    return vec4<f32>(clamp(out, vec3(0.0), vec3(1.0)), texel.a);
}
