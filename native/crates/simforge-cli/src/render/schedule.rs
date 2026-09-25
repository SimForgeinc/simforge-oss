//! Fixed render schedules (`simforge.render-fixed-schedule/v1`): the port of
//! packages/render/src/schedule.ts. Every source renders at its own fixed
//! rate over the clip; frame times are index-derived (never accumulated) and
//! keyed on integer microseconds so several sources share one timeline. The
//! arithmetic follows the TypeScript statement for statement (ECMAScript
//! `Math.round`), so frame counts and microsecond keys are the platform's.
//! Also the sensor-video format decision that rides on the camera schedules.

use serde::Serialize;
use serde_json::json;
use simforge_core::math::js_round;

use super::rig::{Clip, RenderSource};
use crate::contract::CliError;

pub const FIXED_SCHEDULE_V1_SCHEMA: &str = "simforge.render-fixed-schedule/v1";

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FixedSchedule {
    pub schema: &'static str,
    pub source_id: String,
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub frames_per_second: f64,
    pub frame_count: u64,
}

fn invalid(message: String) -> CliError {
    CliError::findings("render_schedule_invalid", message)
}

impl FixedSchedule {
    /// `createFixedSchedules`' rule for one source: the frame count is the
    /// exact clip length times the rate, snapped to the nearest integer when
    /// within a few ULPs of it and rounded up otherwise.
    pub fn new(
        source_id: &str,
        start_seconds: f64,
        end_seconds: f64,
        frames_per_second: f64,
    ) -> Result<Self, CliError> {
        if source_id.is_empty() || source_id.len() > 128 {
            return Err(invalid(format!(
                "schedule source id {source_id:?} must be 1-128 characters"
            )));
        }
        if !(start_seconds.is_finite() && start_seconds >= 0.0) {
            return Err(invalid(format!(
                "{source_id}: startSeconds {start_seconds} must be finite and non-negative"
            )));
        }
        if !(end_seconds.is_finite() && end_seconds > 0.0) || end_seconds <= start_seconds {
            return Err(invalid(format!(
                "{source_id}: endSeconds {end_seconds} must be finite and greater than startSeconds {start_seconds}"
            )));
        }
        if !(frames_per_second.is_finite()
            && frames_per_second > 0.0
            && frames_per_second <= 1000.0)
        {
            return Err(invalid(format!(
                "{source_id}: framesPerSecond {frames_per_second} must be in (0, 1000]"
            )));
        }
        let exact = (end_seconds - start_seconds) * frames_per_second;
        let nearest = js_round(exact);
        let frame_count = if (exact - nearest).abs() <= f64::EPSILON * exact.max(1.0) * 8.0 {
            nearest
        } else {
            exact.ceil()
        };
        if !(1.0..=9_007_199_254_740_991.0).contains(&frame_count) {
            return Err(invalid(format!(
                "{source_id}: the clip holds no frame at {frames_per_second} fps"
            )));
        }
        Ok(Self {
            schema: FIXED_SCHEDULE_V1_SCHEMA,
            source_id: source_id.to_owned(),
            start_seconds,
            end_seconds,
            frames_per_second,
            frame_count: frame_count as u64,
        })
    }

    /// `frameTimestampSeconds`: `start + index / fps`, never accumulated.
    pub fn frame_timestamp_seconds(&self, index: u64) -> f64 {
        self.start_seconds + index as f64 / self.frames_per_second
    }

    /// `scheduleFrameMicros`: frame timestamps quantized to integer microseconds.
    pub fn frame_micros(&self) -> Vec<i64> {
        (0..self.frame_count)
            .map(|index| js_round(self.frame_timestamp_seconds(index) * 1_000_000.0) as i64)
            .collect()
    }
}

/// `unionFrameMicros`: the sorted union of every schedule's frame micros.
pub fn union_frame_micros<'a>(schedules: impl IntoIterator<Item = &'a FixedSchedule>) -> Vec<i64> {
    let mut all: Vec<i64> = schedules
        .into_iter()
        .flat_map(FixedSchedule::frame_micros)
        .collect();
    all.sort_unstable();
    all.dedup();
    all
}

fn source_rate(source: &RenderSource, video_fps: Option<f64>) -> Result<f64, CliError> {
    match source {
        RenderSource::Lidar(s) => Ok(s.attributes.rotation_frequency_hz),
        RenderSource::Radar(s) => video_fps.ok_or_else(|| {
            CliError::findings(
                "render_schedule_invalid",
                format!(
                    "radar source {} requires video.fps to define its fixed sample schedule",
                    s.common.output_name
                ),
            )
        }),
        RenderSource::Camera(s) => Ok(s.attributes.fps),
    }
}

/// `createFixedSchedules`: one schedule per source over `clip`.
pub fn create_fixed_schedules(
    sources: &[RenderSource],
    clip: &Clip,
    video_fps: Option<f64>,
) -> Result<Vec<FixedSchedule>, CliError> {
    if !(clip.start_seconds.is_finite() && clip.start_seconds >= 0.0) {
        return Err(invalid(format!(
            "clip.startSeconds {} must be finite and >= 0",
            clip.start_seconds
        )));
    }
    if !(clip.end_seconds.is_finite() && clip.end_seconds > clip.start_seconds) {
        return Err(invalid(format!(
            "clip.endSeconds {} must be greater than startSeconds {}",
            clip.end_seconds, clip.start_seconds
        )));
    }
    sources
        .iter()
        .map(|source| {
            let fps = source_rate(source, video_fps)?;
            FixedSchedule::new(
                source.output_name(),
                clip.start_seconds,
                clip.end_seconds,
                fps,
            )
        })
        .collect()
}

/// `frameTimestampSeconds`: the exact index-derived time.
pub fn frame_timestamp_seconds(schedule: &FixedSchedule, index: u64) -> f64 {
    schedule.frame_timestamp_seconds(index)
}

/// `scheduleFrameMicros`: frame times quantised to integer microseconds.
pub fn schedule_frame_micros(schedule: &FixedSchedule) -> Vec<i64> {
    schedule.frame_micros()
}

/// The union frame times in seconds, as the lowering samples them
/// (`micros / 1_000_000`).
pub fn union_frame_times_s(schedules: &[FixedSchedule]) -> Vec<f64> {
    union_frame_micros(schedules)
        .into_iter()
        .map(|us| us as f64 / 1_000_000.0)
        .collect()
}

pub fn schedules_json(schedules: &[FixedSchedule]) -> serde_json::Value {
    json!(schedules)
}

/// The video every lidar and radar source is encoded at
/// (`nativeSensorVideoFormat`): the first camera by output name sets the
/// frame size, the fastest camera schedule the rate, and the union of the
/// camera schedules the frame count, so sensor videos are frame-locked to
/// the cameras.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SensorVideoFormat {
    pub width: u32,
    pub height: u32,
    pub frames_per_second: f64,
    pub frame_count: u64,
}

/// One RGB camera as the format decision needs it.
#[derive(Debug, Clone, PartialEq)]
pub struct CameraFormat {
    pub output_name: String,
    pub width: u32,
    pub height: u32,
}

pub fn sensor_video_format(
    cameras: &[CameraFormat],
    schedules: &[FixedSchedule],
) -> Result<SensorVideoFormat, CliError> {
    let mut sorted: Vec<&CameraFormat> = cameras.iter().collect();
    sorted.sort_by(|a, b| locale_compare(&a.output_name, &b.output_name));
    let lead = sorted.first().ok_or_else(|| {
        CliError::findings(
            "render_rig_invalid",
            "a native render requires at least one RGB camera",
        )
    })?;
    let camera_schedules: Vec<&FixedSchedule> = schedules
        .iter()
        .filter(|s| cameras.iter().any(|c| c.output_name == s.source_id))
        .collect();
    let frames_per_second = camera_schedules
        .iter()
        .map(|s| s.frames_per_second)
        .fold(f64::NEG_INFINITY, f64::max);
    if camera_schedules.is_empty() {
        return Err(CliError::findings(
            "render_rig_invalid",
            "no RGB camera has a fixed schedule",
        )
        .with_detail(json!({ "cameras": cameras.iter().map(|c| &c.output_name).collect::<Vec<_>>() })));
    }
    Ok(SensorVideoFormat {
        width: lead.width,
        height: lead.height,
        frames_per_second,
        frame_count: union_frame_micros(camera_schedules).len() as u64,
    })
}

/// A requested video profile (`renderSpec.video`).
#[derive(Debug, Clone, PartialEq)]
pub struct VideoProfile {
    pub container: String,
    pub codec: String,
    pub quality: Option<String>,
}

/// `assertNativeVideoProfileSupported`: the native engine encodes mp4+h264
/// at the reference quality (libx264 CRF 18, or NVENC at its measured
/// equivalent), which meets `draft`, `standard` and `high`. Another
/// container or codec, or `lossless`, is refused rather than encoded as
/// something else.
pub fn assert_video_profile_supported(video: Option<&VideoProfile>) -> Result<(), CliError> {
    let Some(video) = video else {
        return Ok(());
    };
    if video.container != "mp4" || video.codec != "h264" {
        return Err(CliError::findings(
            "native_video_profile_unsupported",
            format!(
                "the native engine encodes mp4+h264; the render asks for {}+{}",
                video.container, video.codec
            ),
        ));
    }
    if video.quality.as_deref() == Some("lossless") {
        return Err(CliError::findings(
            "native_video_quality_unsupported",
            "the native engine encodes lossy H.264 (CRF 18); the render asks for lossless video",
        ));
    }
    Ok(())
}

/// ICU root collation order of printable ASCII, as V8's `localeCompare`
/// sorts it: whitespace, punctuation, symbols, digits, then letters with
/// case as a tertiary difference (lowercase first).
const ICU_ASCII_ORDER: &str =
    " _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$0123456789abcdefghijklmnopqrstuvwxyz";

fn primary(c: char) -> u32 {
    let folded = c.to_ascii_lowercase();
    match ICU_ASCII_ORDER.find(folded) {
        Some(index) => index as u32,
        // Outside printable ASCII: after every ASCII weight, by code point.
        None => 1000 + c as u32,
    }
}

/// `String.prototype.localeCompare` (Node's ICU root locale) for sensor ids:
/// exact on printable ASCII, code-point order beyond it.
pub fn locale_compare(a: &str, b: &str) -> std::cmp::Ordering {
    let primary_a = a.chars().map(primary);
    let primary_b = b.chars().map(primary);
    primary_a.cmp(primary_b).then_with(|| {
        // Tertiary: lowercase before uppercase at the first case difference.
        let case = |s: &str| {
            s.chars()
                .map(|c| c.is_ascii_uppercase())
                .collect::<Vec<_>>()
        };
        case(a).cmp(&case(b))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn schedule(fps: f64, seconds: f64) -> FixedSchedule {
        FixedSchedule {
            schema: FIXED_SCHEDULE_V1_SCHEMA,
            source_id: format!("rgb-{fps}"),
            start_seconds: 0.0,
            end_seconds: seconds,
            frames_per_second: fps,
            frame_count: js_round(fps * seconds) as u64,
        }
    }

    #[test]
    fn union_is_sorted_and_deduplicated_on_microseconds() {
        let union = union_frame_micros(&[schedule(24.0, 1.0), schedule(30.0, 1.0)]);
        assert_eq!(union.first(), Some(&0));
        assert!(union.windows(2).all(|w| w[0] < w[1]));
        // 0, 0.5 s are shared: 24 + 30 - 6 common instants (0, 1/6, ..., 5/6).
        assert_eq!(union.len(), 24 + 30 - 6);
        assert!(union.contains(&41_667) && union.contains(&33_333));
    }
}
