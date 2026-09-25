//! Whether a manual drive take can drive a clip, with the scenario schema's
//! messages (the compiler has its own check with its own wording; the
//! validator's findings keep the authoring wording).

use simforge_compiler::template::ManualDriveRecording;

use crate::jsfmt::js;

const RECORDING_VERSION: u32 = 1;
const INSTANCE_DT_S: f64 = 0.02;
const CLIP_SECONDS_MAX: f64 = 120.0;
const MIN_SAMPLES: usize = 2;
const TIME_TOLERANCE_S: f64 = 1e-6;

fn max_samples() -> usize {
    (CLIP_SECONDS_MAX / INSTANCE_DT_S).round() as usize + 1
}

/// `Err((relative path, message))` when the take cannot drive `clip_seconds`.
pub fn manual_drive_verdict(
    recording: &ManualDriveRecording,
    clip_seconds: f64,
) -> Result<(), (String, String)> {
    let reject = |path: &str, message: String| Err((path.to_owned(), message));
    if recording.version != RECORDING_VERSION {
        return reject(
            "version",
            format!(
                "unsupported manual drive recording version {}",
                recording.version
            ),
        );
    }
    if !recording.clip_seconds.is_finite() || recording.clip_seconds <= 0.0 {
        return reject(
            "clipSeconds",
            "recording clipSeconds must be a positive finite number".to_owned(),
        );
    }
    if (recording.clip_seconds - clip_seconds).abs() > TIME_TOLERANCE_S {
        return reject(
            "clipSeconds",
            format!(
                "take was driven against a {}s clip, but the choreography is {}s; re-record it",
                js(recording.clip_seconds),
                js(clip_seconds)
            ),
        );
    }
    let samples = &recording.samples;
    if samples.len() < MIN_SAMPLES {
        return reject(
            "samples",
            format!("a take needs at least {MIN_SAMPLES} samples"),
        );
    }
    if samples.len() > max_samples() {
        return reject(
            "samples",
            format!(
                "take has {} samples, above the {} supported for a {}s clip at {}s",
                samples.len(),
                max_samples(),
                js(CLIP_SECONDS_MAX),
                js(INSTANCE_DT_S)
            ),
        );
    }
    for (index, sample) in samples.iter().enumerate() {
        for (key, value) in [
            ("timeS", sample.time_s),
            ("x", sample.x),
            ("y", sample.y),
            ("z", sample.z),
            ("headingRad", sample.heading_rad),
            ("speedMps", sample.speed_mps),
        ] {
            if !value.is_finite() {
                return reject(
                    &format!("samples.{index}.{key}"),
                    format!("sample {key} must be finite"),
                );
            }
        }
        if sample.y != 0.0 {
            return reject(
                &format!("samples.{index}.y"),
                format!(
                    "unsupported recorded elevation {}: the planar engine has no height state, so recorded y must be 0 (render ground placement stays map-derived)",
                    js(sample.y)
                ),
            );
        }
        if index > 0 && sample.time_s <= samples[index - 1].time_s {
            return reject(
                &format!("samples.{index}.timeS"),
                "sample times must be strictly increasing".to_owned(),
            );
        }
    }
    if samples[0].time_s.abs() > TIME_TOLERANCE_S {
        return reject(
            "samples.0.timeS",
            format!("a take starts at t=0s, not t={}s", js(samples[0].time_s)),
        );
    }
    let last = samples.len() - 1;
    if (samples[last].time_s - recording.clip_seconds).abs() > TIME_TOLERANCE_S {
        return reject(
            &format!("samples.{last}.timeS"),
            format!(
                "a take ends at t={}s (the clip end), not t={}s",
                js(recording.clip_seconds),
                js(samples[last].time_s)
            ),
        );
    }
    Ok(())
}
