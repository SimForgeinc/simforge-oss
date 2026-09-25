//! Video encoding for native render sources, ported from
//! `oss/packages/render/src/native/video-encoder.ts`: one ffmpeg per
//! source, raw RGBA frames on stdin, the reference argument vectors verbatim.
//!
//! Quality equivalence: `libx264 -preset fast -crf 18` is the reference.
//! NVENC runs `-preset p5 -tune hq` in constant-quality VBR at
//! [`NVENC_EQUIVALENT_CQ`], the value measured to match or exceed the
//! reference's SSIM. Both write yuv420p through the same swscale conversion.
//!
//! Differences from the platform worker, all explicit:
//! - the CLI encodes libx264 unless NVENC is asked for
//!   ([`VideoEncoderPreference`]); `h264_nvenc` without a usable session is
//!   an error, never a silent switch;
//! - an NVENC session that dies before its first encoded frame (the
//!   per-system session cap) restarts on libx264 and replays the frames,
//!   as the platform does, and the result says so (`fellBack`);
//! - no ffmpeg at all is not an error here: the render itself succeeded, so
//!   [`resolve_ffmpeg`] reports it and the caller records the video as
//!   skipped ([`skipped_video`]). A configured or found ffmpeg that does not
//!   run is an error.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use serde::Serialize;
use serde_json::{json, Value};

use crate::contract::CliError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum VideoCodec {
    #[serde(rename = "h264_nvenc")]
    H264Nvenc,
    #[serde(rename = "libx264")]
    Libx264,
}

impl VideoCodec {
    pub fn as_str(self) -> &'static str {
        match self {
            VideoCodec::H264Nvenc => "h264_nvenc",
            VideoCodec::Libx264 => "libx264",
        }
    }
}

/// `auto` (NVENC where the device can open a session, else libx264), or a fixed codec.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VideoEncoderPreference {
    Auto,
    Fixed(VideoCodec),
}

pub const NVENC_EQUIVALENT_CQ: u32 = 19;
/// GeForce drivers cap concurrent NVENC sessions per system; a job leaves headroom.
pub const DEFAULT_NVENC_MAX_SESSIONS: usize = 6;
/// Frames retained for a libx264 replay while an NVENC session is unconfirmed.
const NVENC_REPLAY_FRAMES: usize = 48;

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoFormat {
    pub width: u32,
    pub height: u32,
    pub frames_per_second: f64,
}

/// ECMAScript `String(number)` for the values the arguments carry (sizes and
/// frame rates: finite, well inside the range printed without an exponent).
pub fn js_number_string(value: f64) -> String {
    if value == value.trunc() && value.abs() < 1e21 {
        format!("{}", value as i64)
    } else {
        // Shortest round-trip digits, as both runtimes print them.
        format!("{value}")
    }
}

pub fn encoder_codec_args(codec: VideoCodec) -> Vec<String> {
    let args: &[&str] = match codec {
        VideoCodec::H264Nvenc => &[
            "-c:v",
            "h264_nvenc",
            "-preset",
            "p5",
            "-tune",
            "hq",
            "-rc",
            "vbr",
            "-cq",
            "19",
            "-b:v",
            "0",
            "-profile:v",
            "high",
            "-spatial-aq",
            "1",
            "-bf",
            "2",
        ],
        VideoCodec::Libx264 => &["-c:v", "libx264", "-preset", "fast", "-crf", "18"],
    };
    debug_assert_eq!(NVENC_EQUIVALENT_CQ, 19);
    args.iter().map(|s| (*s).to_owned()).collect()
}

/// `ffmpegEncodeArgs`: raw RGBA on stdin to an mp4 at `output_path`.
pub fn ffmpeg_encode_args(
    codec: VideoCodec,
    format: VideoFormat,
    output_path: &str,
) -> Vec<String> {
    let mut args: Vec<String> = [
        "-y",
        "-loglevel",
        "error",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgba",
        "-s",
    ]
    .iter()
    .map(|s| (*s).to_owned())
    .collect();
    args.push(format!("{}x{}", format.width, format.height));
    args.push("-r".into());
    args.push(js_number_string(format.frames_per_second));
    args.push("-i".into());
    args.push("pipe:0".into());
    args.extend(encoder_codec_args(codec));
    for s in ["-pix_fmt", "yuv420p", "-movflags", "+faststart"] {
        args.push(s.into());
    }
    args.push(output_path.into());
    args
}

/// The one-frame NVENC probe arguments (`nvencAvailable`).
pub fn nvenc_probe_args() -> Vec<String> {
    let mut args: Vec<String> = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=256x144:r=24:d=0.1",
        "-frames:v",
        "1",
    ]
    .iter()
    .map(|s| (*s).to_owned())
    .collect();
    args.extend(encoder_codec_args(VideoCodec::H264Nvenc));
    for s in ["-pix_fmt", "yuv420p", "-f", "null", "-"] {
        args.push(s.into());
    }
    args
}

/// Whether this ffmpeg can open an NVENC session on the visible GPU right now:
/// a one-frame encode to the null muxer (bounded at 20 s, as in the platform).
pub fn nvenc_available(ffmpeg: &Path) -> bool {
    let Ok(mut child) = Command::new(ffmpeg)
        .args(nvenc_probe_args())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    else {
        return false;
    };
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(50))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

/// Which codec each source gets (`assignVideoCodecs`): NVENC for the first
/// `max_sessions` sources in the given (priority) order when available and
/// preferred, libx264 for the rest. A fixed `h264_nvenc` preference without
/// NVENC is an error.
pub fn assign_video_codecs(
    source_ids: &[String],
    preference: VideoEncoderPreference,
    nvenc: bool,
    max_sessions: usize,
) -> Result<Vec<(String, VideoCodec)>, CliError> {
    if preference == VideoEncoderPreference::Fixed(VideoCodec::H264Nvenc) && !nvenc {
        return Err(CliError::new(
            "native_video_encoder_unavailable",
            "h264_nvenc was required but this ffmpeg cannot open an NVENC session",
        ));
    }
    let mut sessions = 0;
    Ok(source_ids
        .iter()
        .map(|id| {
            let use_nvenc = preference != VideoEncoderPreference::Fixed(VideoCodec::Libx264)
                && nvenc
                && sessions < max_sessions;
            if use_nvenc {
                sessions += 1;
            }
            let codec = if use_nvenc {
                VideoCodec::H264Nvenc
            } else {
                VideoCodec::Libx264
            };
            (id.clone(), codec)
        })
        .collect())
}

/// Where ffmpeg was found, and why.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum FfmpegResolution {
    #[serde(rename = "found")]
    Found {
        path: PathBuf,
        /// `env:SIMFORGE_FFMPEG_BINARY` or `path`.
        source: String,
        version: String,
    },
    #[serde(rename = "missing")]
    Missing { searched: String },
}

/// `SIMFORGE_FFMPEG_BINARY`, then PATH. An explicitly configured binary that
/// does not exist or does not run is an error; one found on PATH that does
/// not run is an error too (a broken install is not "no ffmpeg").
pub fn resolve_ffmpeg() -> Result<FfmpegResolution, CliError> {
    let explicit = std::env::var("SIMFORGE_FFMPEG_BINARY")
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty());
    let (path, source) = match explicit {
        Some(path) => (PathBuf::from(path), "env:SIMFORGE_FFMPEG_BINARY"),
        None => {
            let exe = if cfg!(windows) {
                "ffmpeg.exe"
            } else {
                "ffmpeg"
            };
            let found = std::env::var_os("PATH").and_then(|paths| {
                std::env::split_paths(&paths)
                    .map(|dir| dir.join(exe))
                    .find(|p| p.is_file())
            });
            match found {
                Some(path) => (path, "path"),
                None => {
                    return Ok(FfmpegResolution::Missing {
                        searched: "SIMFORGE_FFMPEG_BINARY, PATH".into(),
                    })
                }
            }
        }
    };
    let version = ffmpeg_version(&path).map_err(|reason| {
        CliError::new(
            "ffmpeg_broken",
            format!("{} ({source}) does not run: {reason}", path.display()),
        )
        .with_path(path.display().to_string())
    })?;
    Ok(FfmpegResolution::Found {
        path,
        source: source.into(),
        version,
    })
}

/// The first line of `ffmpeg -version` (`nativeEncoderVersion`).
pub fn ffmpeg_version(ffmpeg: &Path) -> Result<String, String> {
    let out = Command::new(ffmpeg)
        .args(["-hide_banner", "-version"])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!(
            "-version exited with {}: {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()
        .unwrap_or_default()
        .trim()
        .to_owned())
}

/// The results record for a video that was not encoded because no ffmpeg
/// is installed: explicit, never an absent key.
pub fn skipped_video(source_id: &str, reason: &str) -> Value {
    json!({ "sourceId": source_id, "status": "skipped", "reason": reason })
}

/// What an encoder produced.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EncodedVideo {
    pub path: PathBuf,
    pub codec: VideoCodec,
    /// True when the source started on NVENC and restarted on libx264.
    pub fell_back: bool,
    pub frames: u64,
    pub format: VideoFormat,
}

struct Running {
    child: Child,
    stdin: Option<ChildStdin>,
    stderr: JoinHandle<()>,
}

/// One ffmpeg fed raw RGBA frames in order (`VideoEncoder`).
pub struct VideoEncoder {
    ffmpeg: PathBuf,
    path: PathBuf,
    format: VideoFormat,
    codec: VideoCodec,
    running: Running,
    /// Frames written but not yet confirmed encoded (NVENC start-up window).
    retained: Option<Vec<Vec<u8>>>,
    confirmed: Arc<AtomicBool>,
    stderr_tail: Arc<Mutex<Vec<String>>>,
    fell_back: bool,
    frames: u64,
}

fn spawn(
    ffmpeg: &Path,
    output: &Path,
    format: VideoFormat,
    codec: VideoCodec,
    confirmed: Arc<AtomicBool>,
    tail: Arc<Mutex<Vec<String>>>,
) -> Result<Running, CliError> {
    let mut args = ffmpeg_encode_args(codec, format, &output.to_string_lossy());
    // `-progress` on fd 2 alongside errors: `frame=N` lines confirm encoding.
    if codec == VideoCodec::H264Nvenc {
        let insert = ["-progress", "pipe:2", "-stats_period", "0.25"].map(String::from);
        args.splice(2..2, insert);
    }
    let mut child = Command::new(ffmpeg)
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            CliError::new(
                "ffmpeg_broken",
                format!("cannot start {}: {e}", ffmpeg.display()),
            )
        })?;
    let stdin = child.stdin.take();
    let mut stderr = child.stderr.take().expect("stderr is piped");
    let watch_progress = codec == VideoCodec::H264Nvenc;
    let reader = std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut pending = String::new();
        loop {
            let n = match stderr.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            pending.push_str(&String::from_utf8_lossy(&buf[..n]));
            while let Some(end) = pending.find('\n') {
                let line: String = pending.drain(..=end).collect();
                let line = line.trim_end_matches('\n');
                if watch_progress
                    && line
                        .strip_prefix("frame=")
                        .and_then(|rest| rest.chars().next())
                        .is_some_and(|c| ('1'..='9').contains(&c))
                {
                    confirmed.store(true, Ordering::SeqCst);
                }
                let is_progress = line.split_once('=').is_some_and(|(key, _)| {
                    !key.is_empty() && key.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
                });
                if line.is_empty() || is_progress {
                    continue;
                }
                let mut tail = tail.lock().expect("stderr tail lock");
                tail.push(line.to_owned());
                if tail.len() > 32 {
                    tail.remove(0);
                }
            }
        }
    });
    Ok(Running {
        child,
        stdin,
        stderr: reader,
    })
}

impl VideoEncoder {
    pub fn new(
        ffmpeg: &Path,
        output_path: &Path,
        format: VideoFormat,
        codec: VideoCodec,
    ) -> Result<Self, CliError> {
        if let Some(parent) = output_path.parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent).map_err(|e| {
                CliError::new(
                    "write_failed",
                    format!("cannot create {}: {e}", parent.display()),
                )
            })?;
        }
        let confirmed = Arc::new(AtomicBool::new(false));
        let tail = Arc::new(Mutex::new(Vec::new()));
        let running = spawn(
            ffmpeg,
            output_path,
            format,
            codec,
            confirmed.clone(),
            tail.clone(),
        )?;
        Ok(Self {
            ffmpeg: ffmpeg.to_path_buf(),
            path: output_path.to_path_buf(),
            format,
            codec,
            running,
            retained: (codec == VideoCodec::H264Nvenc).then(Vec::new),
            confirmed,
            stderr_tail: tail,
            fell_back: false,
            frames: 0,
        })
    }

    pub fn codec(&self) -> VideoCodec {
        self.codec
    }

    fn tail(&self) -> String {
        self.stderr_tail
            .lock()
            .expect("stderr tail lock")
            .join("\n")
    }

    fn write_raw(&mut self, frame: &[u8]) -> std::io::Result<()> {
        match self.running.stdin.as_mut() {
            Some(stdin) => stdin.write_all(frame),
            None => Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "stdin closed",
            )),
        }
    }

    fn wait(&mut self) -> Result<ExitStatus, CliError> {
        drop(self.running.stdin.take());
        let status = self
            .running
            .child
            .wait()
            .map_err(|e| CliError::new("ffmpeg_broken", format!("waiting for ffmpeg: {e}")))?;
        // The reader thread ends with the process's stderr.
        let reader = std::mem::replace(&mut self.running.stderr, std::thread::spawn(|| {}));
        let _ = reader.join();
        Ok(status)
    }

    fn fall_back(&mut self) -> Result<(), CliError> {
        let replay = self.retained.take().unwrap_or_default();
        self.fell_back = true;
        self.codec = VideoCodec::Libx264;
        self.confirmed.store(true, Ordering::SeqCst);
        self.running = spawn(
            &self.ffmpeg,
            &self.path,
            self.format,
            VideoCodec::Libx264,
            self.confirmed.clone(),
            self.stderr_tail.clone(),
        )?;
        for frame in &replay {
            self.write_raw(frame).map_err(|e| {
                CliError::new(
                    "video_encode_failed",
                    format!(
                        "ffmpeg (libx264) stopped accepting frames: {e}\n{}",
                        self.tail()
                    ),
                )
            })?;
        }
        Ok(())
    }

    /// Write one RGBA frame (`width * height * 4` bytes); blocks on ffmpeg's backpressure.
    pub fn write(&mut self, rgba: &[u8]) -> Result<(), CliError> {
        let expected = self.format.width as usize * self.format.height as usize * 4;
        if rgba.len() != expected {
            return Err(CliError::new(
                "video_frame_size_mismatch",
                format!(
                    "{}: frame of {} bytes, the {}x{} video takes {expected}",
                    self.path.display(),
                    rgba.len(),
                    self.format.width,
                    self.format.height
                ),
            ));
        }
        if self.confirmed.load(Ordering::SeqCst) {
            self.retained = None;
        }
        if let Some(retained) = self.retained.as_mut() {
            retained.push(rgba.to_vec());
            // An encoder that accepted this many frames has an open session.
            if retained.len() > NVENC_REPLAY_FRAMES {
                self.retained = None;
                self.confirmed.store(true, Ordering::SeqCst);
            }
        }
        if let Err(error) = self.write_raw(rgba) {
            if self.codec == VideoCodec::H264Nvenc && !self.confirmed.load(Ordering::SeqCst) {
                self.wait()?;
                // The replay includes this frame (it was retained above).
                self.fall_back()?;
            } else {
                return Err(CliError::new(
                    "video_encode_failed",
                    format!(
                        "ffmpeg ({}) stopped accepting frames: {error}\n{}",
                        self.codec.as_str(),
                        self.tail()
                    ),
                ));
            }
        }
        self.frames += 1;
        Ok(())
    }

    /// Flush and wait for the file; an NVENC start-up failure is retried on libx264.
    pub fn finish(mut self) -> Result<EncodedVideo, CliError> {
        let mut status = self.wait()?;
        if !status.success()
            && self.codec == VideoCodec::H264Nvenc
            && !self.confirmed.load(Ordering::SeqCst)
        {
            self.fall_back()?;
            status = self.wait()?;
        }
        if !status.success() {
            return Err(CliError::new(
                "video_encode_failed",
                format!(
                    "ffmpeg ({}) exited {status}\n{}",
                    self.codec.as_str(),
                    self.tail()
                ),
            )
            .with_path(self.path.display().to_string()));
        }
        Ok(EncodedVideo {
            path: self.path.clone(),
            codec: self.codec,
            fell_back: self.fell_back,
            frames: self.frames,
            format: self.format,
        })
    }
}

impl Drop for VideoEncoder {
    fn drop(&mut self) {
        // An encoder dropped without `finish` (an error elsewhere) is aborted.
        if let Ok(None) = self.running.child.try_wait() {
            drop(self.running.stdin.take());
            let _ = self.running.child.kill();
            let _ = self.running.child.wait();
        }
    }
}

/// Decode one of the job's RGB artifacts (`<tick:08>.rgb.png`, RGBA8, padding
/// stripped) into the raw RGBA the encoder takes.
pub fn decode_rgba_png(path: &Path) -> Result<(u32, u32, Vec<u8>), CliError> {
    let bad = |reason: String| {
        CliError::findings(
            "render_frame_invalid",
            format!("{}: {reason}", path.display()),
        )
        .with_path(path.display().to_string())
    };
    let file = std::fs::File::open(path).map_err(|e| bad(e.to_string()))?;
    let mut decoder = png::Decoder::new(std::io::BufReader::new(file));
    decoder.set_transformations(png::Transformations::IDENTITY);
    let mut reader = decoder.read_info().map_err(|e| bad(e.to_string()))?;
    let size = reader
        .output_buffer_size()
        .ok_or_else(|| bad("image too large".into()))?;
    let mut buf = vec![0; size];
    let info = reader
        .next_frame(&mut buf)
        .map_err(|e| bad(e.to_string()))?;
    if info.color_type != png::ColorType::Rgba || info.bit_depth != png::BitDepth::Eight {
        return Err(bad(format!(
            "expected RGBA8, found {:?} {:?}",
            info.color_type, info.bit_depth
        )));
    }
    buf.truncate(info.buffer_size());
    Ok((info.width, info.height, buf))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gives_nvenc_to_the_first_sources_up_to_the_session_cap_and_libx264_to_the_rest() {
        let ids: Vec<String> = ["cam-a", "cam-b", "cam-c", "lidar"]
            .map(String::from)
            .to_vec();
        let codecs = |p, nvenc, max| -> Vec<VideoCodec> {
            assign_video_codecs(&ids, p, nvenc, max)
                .unwrap()
                .into_iter()
                .map(|(_, c)| c)
                .collect()
        };
        use VideoCodec::*;
        assert_eq!(
            codecs(VideoEncoderPreference::Auto, true, 2),
            vec![H264Nvenc, H264Nvenc, Libx264, Libx264]
        );
        assert_eq!(
            codecs(VideoEncoderPreference::Auto, false, 8),
            vec![Libx264; 4]
        );
        assert_eq!(
            codecs(VideoEncoderPreference::Fixed(Libx264), true, 8),
            vec![Libx264; 4]
        );
        let err = assign_video_codecs(&ids, VideoEncoderPreference::Fixed(H264Nvenc), false, 8)
            .unwrap_err();
        assert_eq!(err.code, "native_video_encoder_unavailable");
    }

    #[test]
    fn number_strings_follow_ecmascript() {
        assert_eq!(js_number_string(24.0), "24");
        assert_eq!(js_number_string(29.97), "29.97");
        assert_eq!(js_number_string(0.1 + 0.2), "0.30000000000000004");
        assert_eq!(js_number_string(12.5), "12.5");
    }

    #[cfg(unix)]
    fn fake_ffmpeg(dir: &Path) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let binary = dir.join("ffmpeg");
        std::fs::write(
            &binary,
            "#!/bin/sh\nfor arg in \"$@\"; do out=\"$arg\"; done\ncase \" $* \" in *h264_nvenc*) echo \"OpenEncodeSessionEx failed: out of memory (10)\" >&2; exit 1;; esac\ncat > \"$out\"\n",
        )
        .unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
        binary
    }

    #[cfg(unix)]
    #[test]
    fn falls_back_to_libx264_and_replays_every_frame_when_an_nvenc_session_cannot_open() {
        let dir = tempfile::tempdir().unwrap();
        let binary = fake_ffmpeg(dir.path());
        let output = dir.path().join("out.raw");
        let format = VideoFormat {
            width: 2,
            height: 1,
            frames_per_second: 24.0,
        };
        let mut encoder =
            VideoEncoder::new(&binary, &output, format, VideoCodec::H264Nvenc).unwrap();
        let mut frame = [0u8; 8];
        for index in 0..5u8 {
            frame.fill(index);
            encoder.write(&frame).unwrap();
        }
        let done = encoder.finish().unwrap();
        assert_eq!(done.codec, VideoCodec::Libx264);
        assert!(done.fell_back);
        assert_eq!(done.frames, 5);
        let bytes = std::fs::read(&output).unwrap();
        let expected: Vec<u8> = (0..5u8).flat_map(|v| [v; 8]).collect();
        assert_eq!(bytes, expected);
    }

    #[cfg(unix)]
    #[test]
    fn a_libx264_encoder_that_fails_is_an_error_with_its_stderr() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let binary = dir.path().join("ffmpeg");
        std::fs::write(
            &binary,
            "#!/bin/sh\ncat >/dev/null\necho 'Unknown encoder libx264' >&2\nexit 1\n",
        )
        .unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
        let format = VideoFormat {
            width: 1,
            height: 1,
            frames_per_second: 10.0,
        };
        let mut encoder = VideoEncoder::new(
            &binary,
            &dir.path().join("o.mp4"),
            format,
            VideoCodec::Libx264,
        )
        .unwrap();
        encoder.write(&[1, 2, 3, 4]).unwrap();
        let err = encoder.finish().unwrap_err();
        assert_eq!(err.code, "video_encode_failed");
        assert!(
            err.reason.contains("Unknown encoder libx264"),
            "{}",
            err.reason
        );
        // A frame of the wrong size is refused before it reaches ffmpeg.
        let mut encoder = VideoEncoder::new(
            &binary,
            &dir.path().join("p.mp4"),
            format,
            VideoCodec::Libx264,
        )
        .unwrap();
        assert_eq!(
            encoder.write(&[0; 8]).unwrap_err().code,
            "video_frame_size_mismatch"
        );
    }
}
