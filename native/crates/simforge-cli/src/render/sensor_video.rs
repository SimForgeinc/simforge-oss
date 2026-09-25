//! Lidar and radar review videos, ported from
//! `oss/packages/render/src/native/sensor-video.ts`.
//!
//! The service publishes lidar frames as `ply-ascii` point clouds and radar
//! frames as `radar-csv` detections. Their video is a deterministic
//! rasterisation of that structure: a z-tested splat pass for a point cloud,
//! a top-down plot for a radar frame. Every frame is RGBA at the video size,
//! so it feeds the same ffmpeg pipe as an RGB camera.
//!
//! Byte-identical to the TypeScript for the same payload: the arithmetic is
//! kept in the same order, point fields are stored as `f32` exactly as the
//! TypeScript `Float32Array`s store them (and so is the z buffer), channel
//! writes follow `Uint8Array` assignment (truncation), and the
//! transcendentals are V8's (`simforge_core::math`: fdlibm `sin`/`cos`/`tan`,
//! Kahan-normalised `hypot`, ECMAScript `Math.round`).

use serde_json::json;
use simforge_core::math::{cos, js_round, sin, tan};

use crate::contract::CliError;

/// One lidar scan in the sensor frame: metres, x forward, y up, z left.
#[derive(Debug, Clone, PartialEq)]
pub struct LidarScan {
    pub count: usize,
    /// Interleaved xyz.
    pub xyz: Vec<f32>,
    pub intensity: Vec<f32>,
}

/// One radar frame's detections.
#[derive(Debug, Clone, PartialEq)]
pub struct RadarScan {
    pub count: usize,
    pub depth_m: Vec<f32>,
    /// Positive = left of forward.
    pub azimuth_rad: Vec<f32>,
    pub altitude_rad: Vec<f32>,
    /// Relative radial velocity, m/s; positive approaches the sensor.
    pub velocity_mps: Vec<f32>,
}

fn invalid_payload(sensor: &str, message: String) -> CliError {
    CliError::findings(
        "native_sensor_payload_invalid",
        format!("{sensor} frame {message}"),
    )
    .with_detail(json!({ "sensor": sensor }))
}

/// The exact header `renderer/sensors` `encode_lidar_ply` writes, after its `element vertex` line.
const LIDAR_PLY_PROPERTIES: [&str; 5] = [
    "property float x",
    "property float y",
    "property float z",
    "property float intensity",
    "property uint instance_id",
];

/// The exact header `renderer/sensors` `encode_radar_csv` writes.
const RADAR_CSV_HEADER: &str = "depth_m,azimuth_rad,altitude_rad,velocity_mps";

/// Latin-1 decoding (`Buffer#toString('latin1')`): one char per byte.
fn latin1(bytes: &[u8]) -> String {
    bytes.iter().map(|&b| b as char).collect()
}

fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0b}' | '\u{0c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// ECMAScript `Number(text)` for the payload fields: surrounding whitespace
/// is ignored, `0x`/`0o`/`0b` integers and decimal literals parse, anything
/// else is NaN. (`Infinity` parses; the caller refuses non-finite values.)
fn js_number(text: &str) -> f64 {
    let t = text.trim_matches(is_js_whitespace);
    if t.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(digits) = t.strip_prefix(prefix) {
            if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
                return f64::NAN;
            }
            return digits.chars().fold(0.0, |acc, c| {
                acc * radix as f64 + c.to_digit(radix).unwrap() as f64
            });
        }
    }
    let unsigned = t.strip_prefix(['+', '-']).unwrap_or(t);
    if unsigned == "Infinity" {
        return if t.starts_with('-') {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    }
    // StrDecimalLiteral: digits [. digits] [e[+-]digits], or . digits ...
    let bytes = unsigned.as_bytes();
    let mut i = 0;
    let int_digits = bytes.iter().take_while(|b| b.is_ascii_digit()).count();
    i += int_digits;
    let mut frac_digits = 0;
    if i < bytes.len() && bytes[i] == b'.' {
        i += 1;
        frac_digits = bytes[i..].iter().take_while(|b| b.is_ascii_digit()).count();
        i += frac_digits;
    }
    if int_digits + frac_digits == 0 {
        return f64::NAN;
    }
    if i < bytes.len() && (bytes[i] == b'e' || bytes[i] == b'E') {
        i += 1;
        if i < bytes.len() && (bytes[i] == b'+' || bytes[i] == b'-') {
            i += 1;
        }
        let exp_digits = bytes[i..].iter().take_while(|b| b.is_ascii_digit()).count();
        if exp_digits == 0 {
            return f64::NAN;
        }
        i += exp_digits;
    }
    if i != bytes.len() {
        return f64::NAN;
    }
    // Rust's float parser is correctly rounded like ECMAScript's for this grammar.
    t.parse::<f64>().unwrap_or(f64::NAN)
}

fn finite_field(text: &str, sensor: &str, row: usize, name: &str) -> Result<f64, CliError> {
    // `Number('')` is 0: an empty field is malformed, not the origin.
    let value = if text.is_empty() {
        f64::NAN
    } else {
        js_number(text)
    };
    if !value.is_finite() {
        return Err(invalid_payload(
            sensor,
            format!("row {row} has a non-finite {name} \"{text}\""),
        ));
    }
    Ok(value)
}

/// Parse the service's `encode_lidar_ply` output (ASCII, `x y z intensity
/// instance_id` per row). Strict: the header must be the service's exact
/// layout, every row must carry five finite fields, and the row count must
/// match `element vertex`; anything else fails the render
/// (`native_sensor_payload_invalid`) rather than dropping points.
pub fn parse_lidar_ply(bytes: &[u8], sensor: &str) -> Result<LidarScan, CliError> {
    let text = latin1(bytes);
    let header_end = text
        .find("end_header\n")
        .ok_or_else(|| invalid_payload(sensor, "is not an ASCII PLY document".into()))?;
    let header: Vec<&str> = text[..header_end]
        .split('\n')
        .filter(|line| !line.is_empty())
        .collect();
    let vertex = header
        .get(2)
        .and_then(|line| line.strip_prefix("element vertex "))
        .filter(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()));
    let layout_ok = header.first() == Some(&"ply")
        && header.get(1) == Some(&"format ascii 1.0")
        && vertex.is_some()
        && header.len() == 3 + LIDAR_PLY_PROPERTIES.len()
        && LIDAR_PLY_PROPERTIES
            .iter()
            .enumerate()
            .all(|(i, p)| header[3 + i] == *p);
    let Some(vertex) = vertex.filter(|_| layout_ok) else {
        return Err(invalid_payload(
            sensor,
            format!("has an unexpected PLY header: {}", header.join(" | ")),
        ));
    };
    // The regex-checked digits; a count the payload cannot hold fails on
    // the rows below ("ends after"), as in the TypeScript.
    let count: usize = vertex.parse().map_err(|_| {
        invalid_payload(
            sensor,
            format!("declares {vertex} points, more than it can hold"),
        )
    })?;
    let reserve = count.min(text.len());
    let mut xyz = Vec::with_capacity(reserve * 3);
    let mut intensity = Vec::with_capacity(reserve);
    let mut cursor = header_end + "end_header\n".len();
    for index in 0..count {
        let Some(line_len) = text[cursor..].find('\n') else {
            return Err(invalid_payload(
                sensor,
                format!("declares {count} points but ends after {index}"),
            ));
        };
        let fields: Vec<&str> = text[cursor..cursor + line_len].split(' ').collect();
        cursor += line_len + 1;
        if fields.len() != 5 {
            return Err(invalid_payload(
                sensor,
                format!("row {index} has {} fields, expected 5", fields.len()),
            ));
        }
        xyz.push(finite_field(fields[0], sensor, index, "x")? as f32);
        xyz.push(finite_field(fields[1], sensor, index, "y")? as f32);
        xyz.push(finite_field(fields[2], sensor, index, "z")? as f32);
        intensity.push(finite_field(fields[3], sensor, index, "intensity")? as f32);
        if fields[4].is_empty() || !fields[4].bytes().all(|b| b.is_ascii_digit()) {
            return Err(invalid_payload(
                sensor,
                format!("row {index} has a malformed instance_id \"{}\"", fields[4]),
            ));
        }
    }
    if cursor != text.len() {
        return Err(invalid_payload(
            sensor,
            format!("carries data after its {count} declared points"),
        ));
    }
    Ok(LidarScan {
        count,
        xyz,
        intensity,
    })
}

/// Parse the service's `encode_radar_csv` output. Strict like
/// [`parse_lidar_ply`]: the exact header and four finite fields per row.
pub fn parse_radar_csv(bytes: &[u8], sensor: &str) -> Result<RadarScan, CliError> {
    let text = latin1(bytes);
    let Some(body) = text.strip_suffix('\n') else {
        return Err(invalid_payload(
            sensor,
            "is not newline-terminated CSV".into(),
        ));
    };
    let lines: Vec<&str> = body.split('\n').collect();
    if lines[0] != RADAR_CSV_HEADER {
        return Err(invalid_payload(
            sensor,
            format!(
                "has an unexpected CSV header: {}",
                serde_json::to_string(lines[0]).expect("a string serializes")
            ),
        ));
    }
    let rows = &lines[1..];
    let mut scan = RadarScan {
        count: rows.len(),
        depth_m: Vec::with_capacity(rows.len()),
        azimuth_rad: Vec::with_capacity(rows.len()),
        altitude_rad: Vec::with_capacity(rows.len()),
        velocity_mps: Vec::with_capacity(rows.len()),
    };
    for (index, row) in rows.iter().enumerate() {
        let fields: Vec<&str> = row.split(',').collect();
        if fields.len() != 4 {
            return Err(invalid_payload(
                sensor,
                format!("row {index} has {} fields, expected 4", fields.len()),
            ));
        }
        scan.depth_m
            .push(finite_field(fields[0], sensor, index, "depth_m")? as f32);
        scan.azimuth_rad
            .push(finite_field(fields[1], sensor, index, "azimuth_rad")? as f32);
        scan.altitude_rad
            .push(finite_field(fields[2], sensor, index, "altitude_rad")? as f32);
        scan.velocity_mps
            .push(finite_field(fields[3], sensor, index, "velocity_mps")? as f32);
    }
    Ok(scan)
}

type Rgb = [f64; 3];

const BACKGROUND: Rgb = [11.0, 14.0, 20.0];
const GRID: Rgb = [46.0, 52.0, 64.0];
const EGO: Rgb = [232.0, 228.0, 68.0];

/// Five-stop height ramp: ground teal, mid green/yellow, tall orange, top white.
const HEIGHT_RAMP: [Rgb; 5] = [
    [28.0, 92.0, 128.0],
    [40.0, 170.0, 150.0],
    [190.0, 215.0, 60.0],
    [245.0, 140.0, 40.0],
    [255.0, 245.0, 235.0],
];

/// `Math.max(0, Math.min(1, t))` (NaN propagates like V8's).
fn clamp01(t: f64) -> f64 {
    if t.is_nan() {
        return f64::NAN;
    }
    t.clamp(0.0, 1.0)
}

fn ramp_colour(t: f64) -> Rgb {
    let clamped = clamp01(t);
    let scaled = clamped * (HEIGHT_RAMP.len() - 1) as f64;
    let index = ((HEIGHT_RAMP.len() - 2) as f64).min(scaled.floor());
    let mix = scaled - index;
    let (from, to) = if index.is_nan() {
        // NaN heights index `HEIGHT_RAMP[NaN]` (undefined) in the TypeScript,
        // whose arithmetic then yields NaN channels, written as 0.
        return [f64::NAN; 3];
    } else {
        (HEIGHT_RAMP[index as usize], HEIGHT_RAMP[index as usize + 1])
    };
    [
        from[0] + (to[0] - from[0]) * mix,
        from[1] + (to[1] - from[1]) * mix,
        from[2] + (to[2] - from[2]) * mix,
    ]
}

/// `Uint8Array` element assignment (ECMAScript ToUint8).
fn to_uint8(v: f64) -> u8 {
    if !v.is_finite() {
        return 0;
    }
    (v.trunc().rem_euclid(256.0)) as u8
}

/// The shared RGBA canvas.
struct RgbaFrame {
    width: u32,
    height: u32,
    pixels: Vec<u8>,
}

impl RgbaFrame {
    fn new(width: u32, height: u32) -> Result<Self, CliError> {
        if width == 0 || height == 0 {
            return Err(CliError::findings(
                "render_rig_invalid",
                format!("sensor video size {width}x{height} is invalid"),
            ));
        }
        Ok(Self {
            width,
            height,
            pixels: vec![0; width as usize * height as usize * 4],
        })
    }

    fn clear(&mut self) {
        for px in self.pixels.chunks_exact_mut(4) {
            px[0] = BACKGROUND[0] as u8;
            px[1] = BACKGROUND[1] as u8;
            px[2] = BACKGROUND[2] as u8;
            px[3] = 255;
        }
    }

    fn plot(&mut self, x: f64, y: f64, colour: Rgb) {
        if x.is_nan()
            || y.is_nan()
            || x < 0.0
            || y < 0.0
            || x >= self.width as f64
            || y >= self.height as f64
        {
            return;
        }
        let offset = ((y * self.width as f64 + x) * 4.0) as usize;
        self.pixels[offset] = to_uint8(colour[0]);
        self.pixels[offset + 1] = to_uint8(colour[1]);
        self.pixels[offset + 2] = to_uint8(colour[2]);
    }

    fn disc(&mut self, cx: f64, cy: f64, radius: i32, colour: Rgb) {
        let r2 = radius * radius;
        for dy in -radius..=radius {
            for dx in -radius..=radius {
                if dx * dx + dy * dy <= r2 {
                    self.plot(js_round(cx + dx as f64), js_round(cy + dy as f64), colour);
                }
            }
        }
    }

    fn line(&mut self, x0: f64, y0: f64, x1: f64, y1: f64, colour: Rgb) {
        let steps = 1f64.max((x1 - x0).abs().max((y1 - y0).abs()).ceil());
        let mut step = 0.0;
        while step <= steps {
            let t = step / steps;
            self.plot(
                js_round(x0 + (x1 - x0) * t),
                js_round(y0 + (y1 - y0) * t),
                colour,
            );
            step += 1.0;
        }
    }
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

/// V8's `Math.hypot(a, b, c)` (src/builtins/math.tq): normalise by the
/// largest magnitude, Kahan-sum the squares, one `sqrt`.
fn hypot3(a: f64, b: f64, c: f64) -> f64 {
    let abs = [a.abs(), b.abs(), c.abs()];
    let mut max = 0.0f64;
    for v in abs {
        if v > max {
            max = v;
        }
    }
    if max == f64::INFINITY {
        return f64::INFINITY;
    }
    if abs.iter().any(|v| v.is_nan()) {
        return f64::NAN;
    }
    if max == 0.0 {
        return 0.0;
    }
    let mut sum = 0.0f64;
    let mut compensation = 0.0f64;
    for v in abs {
        let n = v / max;
        let summand = n * n - compensation;
        let preliminary = sum + summand;
        compensation = (preliminary - sum) - summand;
        sum = preliminary;
    }
    sum.sqrt() * max
}

fn normalise(v: [f64; 3]) -> [f64; 3] {
    let length = hypot3(v[0], v[1], v[2]);
    [v[0] / length, v[1] / length, v[2] / length]
}

/// A perspective view of one scan from behind and above the sensor, in the
/// sensor's own frame so the cloud rides with the host. Points are
/// height-coloured and z-tested, the host footprint is a wire box, the
/// ground carries range rings.
pub struct LidarVideoRasterizer {
    frame: RgbaFrame,
    /// `Float32Array`, as in the TypeScript: stored depths round to f32.
    depth: Vec<f32>,
    eye: [f64; 3],
    forward: [f64; 3],
    right: [f64; 3],
    up: [f64; 3],
    focal_x: f64,
    focal_y: f64,
    ground_y: f64,
    range_m: f64,
}

impl LidarVideoRasterizer {
    pub fn new(
        width: u32,
        height: u32,
        range_m: f64,
        mount_height_m: f64,
    ) -> Result<Self, CliError> {
        let frame = RgbaFrame::new(width, height)?;
        let ground_y = -mount_height_m;
        let eye = [-24.0, 13.0, 0.0];
        let target = [14.0, ground_y, 0.0];
        let forward = normalise([target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]]);
        // Sensor frame is x forward, y up, z left; screen-right is therefore -z.
        let right = normalise(cross([0.0, 1.0, 0.0], forward));
        let up = cross(forward, right);
        let vertical_fov = 58.0 * std::f64::consts::PI / 180.0;
        let focal_y = (height as f64 / 2.0) / tan(vertical_fov / 2.0);
        Ok(Self {
            depth: vec![0.0; width as usize * height as usize],
            frame,
            eye,
            forward,
            right,
            up,
            focal_x: focal_y,
            focal_y,
            ground_y,
            range_m,
        })
    }

    /// Rasterise one scan; the returned buffer is reused by the next call.
    pub fn frame(&mut self, scan: &LidarScan) -> &[u8] {
        self.frame.clear();
        self.depth.fill(f32::INFINITY);
        self.draw_ground();
        self.draw_host();
        let height_span = 7.0;
        for index in 0..scan.count {
            let x = scan.xyz[index * 3] as f64;
            let y = scan.xyz[index * 3 + 1] as f64;
            let z = scan.xyz[index * 3 + 2] as f64;
            let t = (y - self.ground_y) / height_span;
            let base = ramp_colour(t);
            let shade = 0.55 + 0.45 * clamp01(scan.intensity[index] as f64);
            self.splat(x, y, z, [base[0] * shade, base[1] * shade, base[2] * shade]);
        }
        &self.frame.pixels
    }

    fn splat(&mut self, x: f64, y: f64, z: f64, colour: Rgb) {
        let dx = x - self.eye[0];
        let dy = y - self.eye[1];
        let dz = z - self.eye[2];
        let depth = dx * self.forward[0] + dy * self.forward[1] + dz * self.forward[2];
        if depth <= 0.5 || depth.is_nan() {
            // (NaN compares false in `depth <= 0.5` too, but then fails every
            // z test below: nothing is drawn either way.)
            return;
        }
        let sx = (dx * self.right[0] + dy * self.right[1] + dz * self.right[2]) / depth;
        let sy = (dx * self.up[0] + dy * self.up[1] + dz * self.up[2]) / depth;
        let width = self.frame.width as f64;
        let height = self.frame.height as f64;
        let px = js_round(width / 2.0 + sx * self.focal_x);
        let py = js_round(height / 2.0 - sy * self.focal_y);
        let size: i32 = if depth < 30.0 { 1 } else { 0 };
        for oy in -size..=size {
            for ox in -size..=size {
                let qx = px + ox as f64;
                let qy = py + oy as f64;
                if qx < 0.0 || qy < 0.0 || qx >= width || qy >= height {
                    continue;
                }
                let cell = (qy * width + qx) as usize;
                if self.depth[cell] as f64 <= depth {
                    continue;
                }
                self.depth[cell] = depth as f32;
                self.frame.plot(qx, qy, colour);
            }
        }
    }

    fn draw_ground(&mut self) {
        for radius in [10.0, 25.0, 50.0, 100.0, 200.0] {
            if radius > self.range_m {
                continue;
            }
            let samples = 360f64.max(js_round(radius * 24.0)) as u64;
            for sample in 0..samples {
                let angle = sample as f64 * 2.0 * std::f64::consts::PI / samples as f64;
                self.splat(
                    radius * cos(angle),
                    self.ground_y,
                    radius * sin(angle),
                    GRID,
                );
            }
        }
        // Heading line along +x so the direction of travel is unambiguous.
        let limit = self.range_m.min(200.0);
        let mut metres = 0.0;
        while metres <= limit {
            self.splat(metres, self.ground_y, 0.0, GRID);
            metres += 0.25;
        }
    }

    fn draw_host(&mut self) {
        let (x0, x1) = (-2.1, 2.4);
        let (y0, y1) = (self.ground_y + 0.2, self.ground_y + 1.6);
        let (z0, z1) = (-0.95, 0.95);
        let corners = [
            [x0, y0, z0],
            [x1, y0, z0],
            [x1, y0, z1],
            [x0, y0, z1],
            [x0, y1, z0],
            [x1, y1, z0],
            [x1, y1, z1],
            [x0, y1, z1],
        ];
        let edges = [
            (0, 1),
            (1, 2),
            (2, 3),
            (3, 0),
            (4, 5),
            (5, 6),
            (6, 7),
            (7, 4),
            (0, 4),
            (1, 5),
            (2, 6),
            (3, 7),
        ];
        for (from, to) in edges {
            let a: [f64; 3] = corners[from];
            let b: [f64; 3] = corners[to];
            let steps = 40.0;
            for step in 0..=40 {
                let t = step as f64 / steps;
                self.splat(
                    a[0] + (b[0] - a[0]) * t,
                    a[1] + (b[1] - a[1]) * t,
                    a[2] + (b[2] - a[2]) * t,
                    EGO,
                );
            }
        }
    }
}

const APPROACHING: Rgb = [255.0, 96.0, 64.0];
const RECEDING: Rgb = [72.0, 150.0, 255.0];
const STATIONARY: Rgb = [210.0, 220.0, 230.0];

/// A top-down plot of one radar frame: the sensor at the bottom centre, the
/// fan opening upward, range rings and detections coloured by range rate
/// (approaching warm, receding cool, static neutral).
pub struct RadarVideoRasterizer {
    frame: RgbaFrame,
    horizontal_fov_deg: f64,
    range_m: f64,
    origin_x: f64,
    origin_y: f64,
    scale: f64,
}

impl RadarVideoRasterizer {
    pub fn new(
        width: u32,
        height: u32,
        horizontal_fov_deg: f64,
        range_m: f64,
    ) -> Result<Self, CliError> {
        let frame = RgbaFrame::new(width, height)?;
        let (w, h) = (width as f64, height as f64);
        let origin_x = w / 2.0;
        let origin_y = h * 0.92;
        let half_fov =
            (std::f64::consts::PI / 2.0).min(horizontal_fov_deg * std::f64::consts::PI / 360.0);
        let vertical_budget = (h * 0.86) / range_m;
        let horizontal_budget = (w * 0.47) / (range_m * sin(half_fov));
        Ok(Self {
            frame,
            horizontal_fov_deg,
            range_m,
            origin_x,
            origin_y,
            scale: js_min(vertical_budget, horizontal_budget),
        })
    }

    /// Rasterise one frame; the returned buffer is reused by the next call.
    pub fn frame(&mut self, scan: &RadarScan) -> &[u8] {
        self.frame.clear();
        self.draw_fan();
        for index in 0..scan.count {
            let depth = scan.depth_m[index] as f64;
            let azimuth = scan.azimuth_rad[index] as f64;
            let altitude = scan.altitude_rad[index] as f64;
            let ground = depth * cos(altitude);
            let px = self.origin_x - ground * sin(azimuth) * self.scale;
            let py = self.origin_y - ground * cos(azimuth) * self.scale;
            let velocity = scan.velocity_mps[index] as f64;
            let colour = if velocity > 0.5 {
                APPROACHING
            } else if velocity < -0.5 {
                RECEDING
            } else {
                STATIONARY
            };
            let radius = if depth < self.range_m * 0.25 {
                4
            } else if depth < self.range_m * 0.6 {
                3
            } else {
                2
            };
            self.frame.disc(px, py, radius, colour);
        }
        let (ox, oy) = (self.origin_x, self.origin_y);
        self.frame.disc(ox, oy, 5, EGO);
        &self.frame.pixels
    }

    fn draw_fan(&mut self) {
        let half_fov = self.horizontal_fov_deg * std::f64::consts::PI / 360.0;
        let ring_step = if self.range_m > 120.0 {
            50.0
        } else if self.range_m > 40.0 {
            25.0
        } else {
            10.0
        };
        let (ox, oy, scale) = (self.origin_x, self.origin_y, self.scale);
        let mut radius = ring_step;
        while radius <= self.range_m + 1e-6 {
            let arc_samples = 64f64.max(js_round(radius * scale * 2.0 * half_fov));
            let mut sample = 0.0;
            while sample <= arc_samples {
                let angle = -half_fov + (2.0 * half_fov * sample) / arc_samples;
                self.frame.plot(
                    js_round(ox - radius * sin(angle) * scale),
                    js_round(oy - radius * cos(angle) * scale),
                    GRID,
                );
                sample += 1.0;
            }
            radius += ring_step;
        }
        for angle in [-half_fov, half_fov] {
            self.frame.line(
                ox,
                oy,
                ox - self.range_m * sin(angle) * scale,
                oy - self.range_m * cos(angle) * scale,
                GRID,
            );
        }
        self.frame.line(ox, oy, ox, oy - self.range_m * scale, GRID);
    }
}

/// `Math.min(a, b)` (NaN if either is NaN).
fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.min(b)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PLY_HEADER: &str = "ply\nformat ascii 1.0\nelement vertex 2\nproperty float x\nproperty float y\nproperty float z\nproperty float intensity\nproperty uint instance_id\nend_header";

    #[test]
    fn parse_the_service_layouts() {
        let scan = parse_lidar_ply(
            format!("{PLY_HEADER}\n1 2 3 0.5 7\n-4 0.25 6 1 0\n").as_bytes(),
            "lidar",
        )
        .unwrap();
        assert_eq!(scan.count, 2);
        assert_eq!(scan.xyz, vec![1.0, 2.0, 3.0, -4.0, 0.25, 6.0]);
        assert_eq!(scan.intensity, vec![0.5, 1.0]);
        let radar = parse_radar_csv(
            b"depth_m,azimuth_rad,altitude_rad,velocity_mps\n12.5,0.1,-0.02,3\n",
            "radar",
        )
        .unwrap();
        assert_eq!(radar.count, 1);
        assert_eq!(radar.depth_m[0], 12.5);
        assert_eq!(
            parse_radar_csv(b"depth_m,azimuth_rad,altitude_rad,velocity_mps\n", "radar")
                .unwrap()
                .count,
            0
        );
    }

    #[test]
    fn refuse_malformed_lidar_frames_instead_of_plotting_nan_points_or_dropping_rows() {
        let swapped = PLY_HEADER.replace(
            "property float y\nproperty float z",
            "property float z\nproperty float y",
        );
        for body in [
            format!("{PLY_HEADER}\n1 2 NaN 0.5 7\n-4 0.25 6 1 0\n"),
            format!("{PLY_HEADER}\n1 2 3 0.5\n-4 0.25 6 1 0\n"),
            format!("{PLY_HEADER}\n1 2 3 0.5 7\n"),
            format!("{PLY_HEADER}\n1 2 3 0.5 7\n-4 0.25 6 1 0\n9 9 9 9 9\n"),
            format!("{swapped}\n1 2 3 0.5 7\n-4 0.25 6 1 0\n"),
            format!("{PLY_HEADER}\n1  3 0.5 7\n-4 0.25 6 1 0\n"),
        ] {
            let error = parse_lidar_ply(body.as_bytes(), "lidar top").unwrap_err();
            assert_eq!(error.code, "native_sensor_payload_invalid", "{body}");
            assert_eq!(error.exit, crate::contract::Exit::Findings);
        }
    }

    #[test]
    fn refuse_malformed_radar_frames() {
        for body in [
            "depth_m,azimuth_rad,altitude_rad,velocity_mps\n12.5,0.1,-0.02\n",
            "depth_m,azimuth_rad,altitude_rad,velocity_mps\n12.5,0.1,,3\n",
            "depth_m,azimuth_rad,altitude_rad,velocity_mps\n12.5,inf,0,3\n",
            "depth_m,azimuth,altitude,velocity\n12.5,0.1,0,3\n",
            "depth_m,azimuth_rad,altitude_rad,velocity_mps\n12.5,0.1,0,3",
        ] {
            let error = parse_radar_csv(body.as_bytes(), "radar front").unwrap_err();
            assert_eq!(error.code, "native_sensor_payload_invalid", "{body}");
        }
    }

    #[test]
    fn number_parsing_follows_ecmascript() {
        assert_eq!(js_number("0x1f"), 31.0);
        assert_eq!(js_number(" 2.5 "), 2.5);
        assert_eq!(js_number("1e3"), 1000.0);
        assert_eq!(js_number(".5"), 0.5);
        assert_eq!(js_number("5."), 5.0);
        assert!(js_number("inf").is_nan());
        assert!(js_number("NaN").is_nan());
        assert!(js_number("1e").is_nan());
        assert_eq!(js_number("-Infinity"), f64::NEG_INFINITY);
    }

    #[test]
    fn hypot_matches_the_two_argument_port() {
        for (a, b) in [(3.0, 4.0), (38.0, -14.9), (1e-300, 3e-300)] {
            assert_eq!(
                hypot3(a, b, 0.0).to_bits(),
                simforge_core::math::hypot(a, b).to_bits()
            );
        }
    }
}
