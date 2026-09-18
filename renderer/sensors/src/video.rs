//! Final-video sink, shared with the harness-side implementation.
//! Flights may complete out of order; only dense sequence indices reach ffmpeg.
use super::CaptureArgs;
use bevy::prelude::Resource;
use std::collections::{BTreeMap, HashMap};
use std::io::Write;
use std::path::Path;
use std::process::{Child, Command, Stdio};

struct Encoder {
    child: Child,
    frames: usize,
}

#[derive(Resource)]
pub(super) struct VideoSink {
    encoders: HashMap<String, Encoder>,
    pending: BTreeMap<usize, Vec<(String, Vec<u8>)>>,
    next_index: usize,
    frames_encoded: u64,
    cameras: usize,
    planned_ticks: usize,
}

impl VideoSink {
    pub(super) fn new(cameras: usize, planned_ticks: usize) -> Self {
        Self { encoders: HashMap::new(), pending: BTreeMap::new(), next_index: 0,
            frames_encoded: 0, cameras, planned_ticks }
    }

    pub(super) fn push(&mut self, index: usize, sensor: String, rgba: Vec<u8>) {
        assert!(index >= self.next_index && index < self.planned_ticks, "video sequence index out of range");
        let frames = self.pending.entry(index).or_default();
        assert!(!frames.iter().any(|(id, _)| id == &sensor), "duplicate video camera frame");
        frames.push((sensor, rgba));
    }

    fn encoder_for(&mut self, sensor: &str, args: &CaptureArgs, out_dir: &Path) -> &mut Encoder {
        self.encoders.entry(sensor.to_string()).or_insert_with(|| {
            let path = out_dir.join(format!("{sensor}.mp4"));
            let mut cmd = Command::new("ffmpeg");
            cmd.args(["-hide_banner", "-loglevel", "error", "-y"])
                .args(["-f", "rawvideo", "-pix_fmt", "rgba"])
                .args(["-s", &format!("{}x{}", args.width, args.height)])
                .args(["-r", &args.video_fps.unwrap_or(50.0).to_string()]).args(["-i", "-"]);
            match args.video_encoder.as_str() {
                "nvenc" => {
                    cmd.args(["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr"])
                        .args(["-cq", &args.video_crf.to_string()]);
                }
                "x264" => {
                    cmd.args(["-c:v", "libx264", "-preset", "medium"])
                        .args(["-crf", &args.video_crf.to_string()])
                        .args(["-g", "50", "-x264-params", "threads=4:sliced-threads=0:sync-lookahead=0:deterministic=1"]);
                }
                _ => unreachable!("video encoder is validated by clap"),
            }
            cmd.args(["-pix_fmt", "yuv420p", "-fflags", "+bitexact", "-flags:v", "+bitexact"]).arg(path)
                .stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::inherit());
            Encoder { child: cmd.spawn().expect("spawn ffmpeg"), frames: 0 }
        })
    }

    pub(super) fn drain(&mut self, args: &CaptureArgs, out_dir: &Path) {
        while let Some(frames) = self.pending.remove(&self.next_index) {
            assert_eq!(frames.len(), self.cameras, "incomplete video tick");
            for (sensor, rgba) in frames {
                let row = args.width as usize * 4;
                let padded = super::aligned_row(args.width as usize, 4);
                assert_eq!(rgba.len(), padded * args.height as usize, "video readback size");
                let encoder = self.encoder_for(&sensor, args, out_dir);
                let stdin = encoder.child.stdin.as_mut().expect("encoder stdin");
                if row == padded {
                    stdin.write_all(&rgba).expect("write frame to encoder");
                } else {
                    // wgpu row padding is not image data. Send tight rows without
                    // allocating a second frame (e.g. width=736 has padding).
                    for pixels in rgba.chunks_exact(padded) {
                        stdin.write_all(&pixels[..row]).expect("write row to encoder");
                    }
                }
                encoder.frames += 1;
                self.frames_encoded += 1;
            }
            self.next_index += 1;
        }
    }

    pub(super) fn finish(&mut self, enabled: bool) -> u64 {
        if enabled && self.cameras > 0 {
            assert!(self.pending.is_empty(), "video sequence has a missing predecessor");
            assert_eq!(self.next_index, self.planned_ticks, "incomplete video sequence");
            assert_eq!(self.encoders.len(), self.cameras, "video camera count changed");
            for (sensor, encoder) in &self.encoders {
                assert_eq!(encoder.frames, self.planned_ticks, "wrong frame count for {sensor}");
            }
        }
        // Close every input before waiting, so encoders drain concurrently.
        for encoder in self.encoders.values_mut() { drop(encoder.child.stdin.take()); }
        for (sensor, mut encoder) in self.encoders.drain() {
            match encoder.child.wait() {
                Ok(status) if status.success() => {}
                Ok(status) => panic!("encoder for {sensor} exited with {status}"),
                Err(err) => panic!("encoder for {sensor} failed: {err}"),
            }
        }
        std::mem::take(&mut self.frames_encoded)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    #[test]
    #[ignore = "requires ffmpeg with libx264"]
    fn padded_video_frames_are_reordered_without_extra_frames() {
        let directory = std::env::temp_dir().join(format!(
            "simforge-video-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(),
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let args = CaptureArgs::parse_from([
            "sensor-capture", "--rig-program", "unused", "--glbs", "/unused.gltf",
            "--out", directory.to_str().unwrap(), "--width", "66", "--height", "32", "--video",
        ]);
        let frame = |color: [u8; 4]| {
            let padded = super::super::aligned_row(66, 4);
            let mut pixels = vec![197; padded * 32];
            for row in pixels.chunks_exact_mut(padded) {
                for pixel in row[..66 * 4].chunks_exact_mut(4) { pixel.copy_from_slice(&color); }
            }
            pixels
        };
        let mut sink = VideoSink::new(1, 2);
        sink.push(1, "camera".into(), frame([0,255,0,255]));
        sink.drain(&args, &directory);
        sink.push(0, "camera".into(), frame([255,0,0,255]));
        sink.drain(&args, &directory);
        sink.finish(true);
        let decoded = Command::new("ffmpeg")
            .args(["-v", "error", "-i"]).arg(directory.join("camera.mp4"))
            .args(["-f", "rawvideo", "-pix_fmt", "rgb24", "-"]).output().unwrap();
        assert!(decoded.status.success(), "{}", String::from_utf8_lossy(&decoded.stderr));
        let size = 66 * 32 * 3;
        assert_eq!(decoded.stdout.len(), 2 * size, "padding must not become extra frames");
        let first = &decoded.stdout[(16 * 66 + 33) * 3..][..3];
        let second = &decoded.stdout[size + (16 * 66 + 33) * 3..][..3];
        assert!(first[0] > 240 && first[1] < 16 && first[2] < 16, "first frame {first:?}");
        assert!(second[0] < 16 && second[1] > 240 && second[2] < 16, "second frame {second:?}");
        std::fs::remove_dir_all(directory).unwrap();
    }
}
