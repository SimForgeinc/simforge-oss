// Dash-cam camera model: instant histogram metering and a WDR tone curve.
// See `render_core::camera_model` for the model and every constant.
//
// 1. `histogram`: every pixel of the pre-exposed HDR frame adds its metering
//    weight (0..16, integer) to one of 128 log2-luminance bins. Integer
//    atomics make the result independent of invocation order.
// 2. `average`: one invocation reads the histogram, drops the darkest and
//    brightest `trim` of the weighted samples, and turns the weighted mean
//    log2 luminance into the frame's exposure adjustment (stops), clamped to
//    the sensor's EV100 range. It clears the histogram for the next frame and
//    writes `result` (final EV100, adjustment, metered log2 luminance).
// 3. `apply` (camera_model_apply.wgsl) tone-maps the frame with it.
//
// The histogram pass also counts the frame's non-finite pixels (any channel
// NaN or infinite, by its exponent bits: NaN compares are not reliable in
// WGSL). A shading bug that writes NaN would otherwise print as black and
// go unnoticed; the count is read back with the exposure (`result[4]`).

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

const BINS: u32 = 128u;
const LUMA = vec3<f32>(0.2126, 0.7152, 0.0722);

@group(0) @binding(0) var<uniform> params: CameraParams;
@group(0) @binding(1) var frame: texture_2d<f32>;
// Bins 0..127; element 128 counts non-finite pixels.
@group(0) @binding(2) var<storage, read_write> histogram: array<atomic<u32>, 129>;
// EV100, adjustment, metered log2 luminance, weight, non-finite pixels, 0, 0, 0.
@group(0) @binding(3) var<storage, read_write> result: array<f32, 8>;

var<workgroup> local_bins: array<atomic<u32>, 128>;
var<workgroup> local_non_finite: atomic<u32>;

fn non_finite(color: vec3<f32>) -> bool {
    let bits = bitcast<vec3<u32>>(color) & vec3<u32>(0x7f800000u);
    return any(bits == vec3<u32>(0x7f800000u));
}

fn metering_weight(uv: vec2<f32>) -> u32 {
    let mode = u32(params.metering.y + 0.5);
    if mode == 0u {
        return 16u;
    }
    // Center weighting: full weight inside the central ellipse, 1/4 at the
    // corners.
    let d = length((uv - vec2<f32>(0.5, 0.55)) * vec2<f32>(1.0, 1.3));
    var w = mix(1.0, 0.25, smoothstep(0.2, 0.7, d));
    if mode == 2u {
        // Dash-cam: the sky band at the top of the frame counts 1/4.
        w = w * mix(0.25, 1.0, smoothstep(0.25, 0.5, uv.y));
    }
    return u32(round(w * 16.0));
}

fn bin_of(luminance: f32) -> u32 {
    let t = (log2(max(luminance, 1.0e-12)) - params.misc.y) / params.misc.z;
    return u32(clamp(t, 0.0, 0.999999) * f32(BINS));
}

@compute @workgroup_size(16, 16, 1)
fn histogram_pass(
    @builtin(global_invocation_id) id: vec3<u32>,
    @builtin(local_invocation_index) local: u32,
) {
    if local < BINS {
        atomicStore(&local_bins[local], 0u);
    }
    if local == 0u {
        atomicStore(&local_non_finite, 0u);
    }
    workgroupBarrier();
    let dims = vec2<u32>(u32(params.misc.w), u32(params.size.x));
    if id.x < dims.x && id.y < dims.y {
        let color = textureLoad(frame, vec2<i32>(id.xy), 0).rgb;
        let uv = (vec2<f32>(id.xy) + 0.5) / vec2<f32>(dims);
        if non_finite(color) {
            atomicAdd(&local_non_finite, 1u);
        } else {
            atomicAdd(&local_bins[bin_of(dot(max(color, vec3(0.0)), LUMA))], metering_weight(uv));
        }
    }
    workgroupBarrier();
    if local < BINS {
        let count = atomicLoad(&local_bins[local]);
        if count > 0u {
            atomicAdd(&histogram[local], count);
        }
    }
    if local == 0u {
        let count = atomicLoad(&local_non_finite);
        if count > 0u {
            atomicAdd(&histogram[BINS], count);
        }
    }
}

@compute @workgroup_size(1, 1, 1)
fn average_pass() {
    var total = 0.0;
    var counts: array<f32, 128>;
    for (var i = 0u; i < BINS; i += 1u) {
        counts[i] = f32(atomicLoad(&histogram[i]));
        total += counts[i];
        atomicStore(&histogram[i], 0u);
    }
    let low = total * params.metering.z;
    let high = total * (1.0 - params.metering.z);
    var seen = 0.0;
    var weight = 0.0;
    var sum = 0.0;
    let bin_width = params.misc.z / f32(BINS);
    for (var i = 0u; i < BINS; i += 1u) {
        let lo = max(seen, low);
        let hi = min(seen + counts[i], high);
        if hi > lo {
            let center = params.misc.y + (f32(i) + 0.5) * bin_width;
            weight += hi - lo;
            sum += (hi - lo) * center;
        }
        seen += counts[i];
    }
    var metered = log2(params.metering.w);
    if weight > 0.0 {
        metered = sum / weight;
    }
    var adjust = params.exposure.y;
    if params.metering.x > 0.5 {
        adjust += log2(params.metering.w) - metered;
    }
    // A brighter picture is a lower EV100; the sensor limits bound the EV.
    let ev = clamp(params.exposure.x - adjust, params.exposure.z, params.exposure.w);
    result[0] = ev;
    result[1] = params.exposure.x - ev;
    result[2] = metered;
    result[3] = weight;
    result[4] = f32(atomicLoad(&histogram[BINS]));
    atomicStore(&histogram[BINS], 0u);
    result[5] = 0.0;
    result[6] = 0.0;
    result[7] = 0.0;
}

