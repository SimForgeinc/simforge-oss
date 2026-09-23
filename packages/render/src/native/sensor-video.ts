/**
 * Lidar and radar frames the native service publishes are structured
 * (`ply-ascii` point clouds, `radar-csv` detections). The render's video for
 * those sensors is a deterministic rasterisation of that structure, drawn
 * here without a canvas dependency: a point cloud is a z-tested splat pass,
 * a radar frame a top-down plot. Every frame is RGBA at the video size, so
 * it feeds the same ffmpeg pipe as an RGB camera and stays on the same
 * fixed-step clock.
 */

import { RenderInputError } from '../render-input-error.js';

export interface LidarScan {
  readonly count: number;
  /** Sensor-frame metres, interleaved xyz: x forward, y up, z left. */
  readonly xyz: Float32Array;
  readonly intensity: Float32Array;
}

export interface RadarScan {
  readonly count: number;
  readonly depthM: Float32Array;
  /** Positive = left of forward. */
  readonly azimuthRad: Float32Array;
  readonly altitudeRad: Float32Array;
  /** Relative radial velocity, m/s; positive approaches the sensor. */
  readonly velocityMps: Float32Array;
}

function invalidPayload(sensor: string, message: string): RenderInputError {
  return new RenderInputError('native_sensor_payload_invalid', `${sensor} frame ${message}`);
}

/** The exact header `renderer/sensors` `encode_lidar_ply` writes, after its `element vertex` line. */
const LIDAR_PLY_PROPERTIES = [
  'property float x', 'property float y', 'property float z', 'property float intensity', 'property uint instance_id',
] as const;

function finiteField(text: string, sensor: string, row: number, name: string): number {
  // `Number('')` is 0: an empty field is malformed, not the origin.
  const value = text.length === 0 ? Number.NaN : Number(text);
  if (!Number.isFinite(value)) throw invalidPayload(sensor, `row ${row} has a non-finite ${name} "${text}"`);
  return value;
}

/**
 * Parse the service's `encode_lidar_ply` output (ASCII, `x y z intensity
 * instance_id` per row). Strict: the header must be the service's exact
 * layout, every row must carry five finite fields, and the row count must
 * match `element vertex`; anything else fails the job
 * (`native_sensor_payload_invalid`) rather than dropping points.
 */
export function parseLidarPly(bytes: Buffer, sensor = 'lidar'): LidarScan {
  const text = bytes.toString('latin1');
  const headerEnd = text.indexOf('end_header\n');
  if (headerEnd < 0) throw invalidPayload(sensor, 'is not an ASCII PLY document');
  const header = text.slice(0, headerEnd).split('\n').filter((line) => line.length > 0);
  const vertexMatch = /^element vertex (\d+)$/.exec(String(header[2]));
  if (header[0] !== 'ply' || header[1] !== 'format ascii 1.0' || !vertexMatch
    || header.length !== 3 + LIDAR_PLY_PROPERTIES.length
    || LIDAR_PLY_PROPERTIES.some((property, index) => header[3 + index] !== property)) {
    throw invalidPayload(sensor, `has an unexpected PLY header: ${header.join(' | ')}`);
  }
  const count = Number(vertexMatch[1]);
  const xyz = new Float32Array(count * 3);
  const intensity = new Float32Array(count);
  let cursor = headerEnd + 'end_header\n'.length;
  for (let index = 0; index < count; index += 1) {
    const lineEnd = text.indexOf('\n', cursor);
    if (lineEnd < 0) throw invalidPayload(sensor, `declares ${count} points but ends after ${index}`);
    const fields = text.slice(cursor, lineEnd).split(' ');
    cursor = lineEnd + 1;
    if (fields.length !== 5) throw invalidPayload(sensor, `row ${index} has ${fields.length} fields, expected 5`);
    xyz[index * 3] = finiteField(fields[0]!, sensor, index, 'x');
    xyz[index * 3 + 1] = finiteField(fields[1]!, sensor, index, 'y');
    xyz[index * 3 + 2] = finiteField(fields[2]!, sensor, index, 'z');
    intensity[index] = finiteField(fields[3]!, sensor, index, 'intensity');
    if (!/^\d+$/.test(fields[4]!)) throw invalidPayload(sensor, `row ${index} has a malformed instance_id "${fields[4]}"`);
  }
  if (cursor !== text.length) throw invalidPayload(sensor, `carries data after its ${count} declared points`);
  return { count, xyz, intensity };
}

/** The exact header `renderer/sensors` `encode_radar_csv` writes. */
const RADAR_CSV_HEADER = 'depth_m,azimuth_rad,altitude_rad,velocity_mps';

/**
 * Parse the service's `encode_radar_csv` output. Strict like
 * {@link parseLidarPly}: the exact header and four finite fields per row.
 */
export function parseRadarCsv(bytes: Buffer, sensor = 'radar'): RadarScan {
  const text = bytes.toString('latin1');
  if (!text.endsWith('\n')) throw invalidPayload(sensor, 'is not newline-terminated CSV');
  const lines = text.slice(0, -1).split('\n');
  if (lines[0] !== RADAR_CSV_HEADER) throw invalidPayload(sensor, `has an unexpected CSV header: ${JSON.stringify(lines[0])}`);
  const rows = lines.slice(1);
  const count = rows.length;
  const depthM = new Float32Array(count);
  const azimuthRad = new Float32Array(count);
  const altitudeRad = new Float32Array(count);
  const velocityMps = new Float32Array(count);
  rows.forEach((row, index) => {
    const fields = row.split(',');
    if (fields.length !== 4) throw invalidPayload(sensor, `row ${index} has ${fields.length} fields, expected 4`);
    depthM[index] = finiteField(fields[0]!, sensor, index, 'depth_m');
    azimuthRad[index] = finiteField(fields[1]!, sensor, index, 'azimuth_rad');
    altitudeRad[index] = finiteField(fields[2]!, sensor, index, 'altitude_rad');
    velocityMps[index] = finiteField(fields[3]!, sensor, index, 'velocity_mps');
  });
  return { count, depthM, azimuthRad, altitudeRad, velocityMps };
}

const BACKGROUND: readonly [number, number, number] = [11, 14, 20];
const GRID: readonly [number, number, number] = [46, 52, 64];
const EGO: readonly [number, number, number] = [232, 228, 68];

/** Five-stop height ramp: ground teal, mid green/yellow, tall orange, top white. */
const HEIGHT_RAMP: readonly (readonly [number, number, number])[] = [
  [28, 92, 128],
  [40, 170, 150],
  [190, 215, 60],
  [245, 140, 40],
  [255, 245, 235],
];

function rampColour(t: number): readonly [number, number, number] {
  const clamped = Math.max(0, Math.min(1, t));
  const scaled = clamped * (HEIGHT_RAMP.length - 1);
  const index = Math.min(HEIGHT_RAMP.length - 2, Math.floor(scaled));
  const mix = scaled - index;
  const from = HEIGHT_RAMP[index]!;
  const to = HEIGHT_RAMP[index + 1]!;
  return [
    from[0] + (to[0] - from[0]) * mix,
    from[1] + (to[1] - from[1]) * mix,
    from[2] + (to[2] - from[2]) * mix,
  ];
}

abstract class RgbaFrame {
  protected readonly pixels: Buffer;

  constructor(readonly width: number, readonly height: number) {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
      throw new Error(`sensor video size ${width}x${height} is invalid`);
    }
    this.pixels = Buffer.allocUnsafe(width * height * 4);
  }

  protected clear(): void {
    const { pixels } = this;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      pixels[offset] = BACKGROUND[0];
      pixels[offset + 1] = BACKGROUND[1];
      pixels[offset + 2] = BACKGROUND[2];
      pixels[offset + 3] = 255;
    }
  }

  protected plot(x: number, y: number, colour: readonly [number, number, number]): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const offset = (y * this.width + x) * 4;
    this.pixels[offset] = colour[0];
    this.pixels[offset + 1] = colour[1];
    this.pixels[offset + 2] = colour[2];
  }

  protected disc(cx: number, cy: number, radius: number, colour: readonly [number, number, number]): void {
    const r2 = radius * radius;
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        if (dx * dx + dy * dy <= r2) this.plot(Math.round(cx + dx), Math.round(cy + dy), colour);
      }
    }
  }

  protected line(x0: number, y0: number, x1: number, y1: number, colour: readonly [number, number, number]): void {
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
    for (let step = 0; step <= steps; step += 1) {
      const t = step / steps;
      this.plot(Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t), colour);
    }
  }
}

/**
 * A perspective view of one scan from behind and above the sensor, in the
 * sensor's own frame so the cloud rides with the host: a full revolution
 * reads as the scene around the vehicle. Points are height-coloured and
 * z-tested, the host footprint is a wire box, the ground carries range rings.
 */
export class LidarVideoRasterizer extends RgbaFrame {
  private readonly depth: Float32Array;
  private readonly eye: readonly [number, number, number];
  private readonly forward: readonly [number, number, number];
  private readonly right: readonly [number, number, number];
  private readonly up: readonly [number, number, number];
  private readonly focalX: number;
  private readonly focalY: number;
  private readonly groundY: number;

  constructor(width: number, height: number, private readonly rangeM: number, mountHeightM: number) {
    super(width, height);
    this.depth = new Float32Array(width * height);
    this.groundY = -mountHeightM;
    const eye: [number, number, number] = [-24, 13, 0];
    const target: [number, number, number] = [14, this.groundY, 0];
    const forward = normalise([target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]]);
    // Sensor frame is x forward, y up, z left; screen-right is therefore -z.
    const right = normalise(cross([0, 1, 0], forward));
    const up = cross(forward, right);
    this.eye = eye;
    this.forward = forward;
    this.right = right;
    this.up = up;
    const verticalFov = 58 * Math.PI / 180;
    this.focalY = (height / 2) / Math.tan(verticalFov / 2);
    this.focalX = this.focalY;
  }

  frame(scan: LidarScan): Buffer {
    this.clear();
    this.depth.fill(Number.POSITIVE_INFINITY);
    this.drawGround();
    this.drawHost();
    const { xyz, intensity, count } = scan;
    const heightSpan = 7;
    for (let index = 0; index < count; index += 1) {
      const x = xyz[index * 3]!;
      const y = xyz[index * 3 + 1]!;
      const z = xyz[index * 3 + 2]!;
      const t = (y - this.groundY) / heightSpan;
      const base = rampColour(t);
      const shade = 0.55 + 0.45 * Math.max(0, Math.min(1, intensity[index]!));
      this.splat(x, y, z, [base[0] * shade, base[1] * shade, base[2] * shade]);
    }
    return this.pixels;
  }

  private splat(x: number, y: number, z: number, colour: readonly [number, number, number]): void {
    const dx = x - this.eye[0];
    const dy = y - this.eye[1];
    const dz = z - this.eye[2];
    const depth = dx * this.forward[0] + dy * this.forward[1] + dz * this.forward[2];
    if (depth <= 0.5) return;
    const sx = (dx * this.right[0] + dy * this.right[1] + dz * this.right[2]) / depth;
    const sy = (dx * this.up[0] + dy * this.up[1] + dz * this.up[2]) / depth;
    const px = Math.round(this.width / 2 + sx * this.focalX);
    const py = Math.round(this.height / 2 - sy * this.focalY);
    const size = depth < 30 ? 1 : 0;
    for (let oy = -size; oy <= size; oy += 1) {
      for (let ox = -size; ox <= size; ox += 1) {
        const qx = px + ox;
        const qy = py + oy;
        if (qx < 0 || qy < 0 || qx >= this.width || qy >= this.height) continue;
        const cell = qy * this.width + qx;
        if (this.depth[cell]! <= depth) continue;
        this.depth[cell] = depth;
        this.plot(qx, qy, colour);
      }
    }
  }

  private drawGround(): void {
    const rings = [10, 25, 50, 100, 200].filter((radius) => radius <= this.rangeM);
    for (const radius of rings) {
      const samples = Math.max(360, Math.round(radius * 24));
      for (let sample = 0; sample < samples; sample += 1) {
        const angle = sample * 2 * Math.PI / samples;
        this.splat(radius * Math.cos(angle), this.groundY, radius * Math.sin(angle), GRID);
      }
    }
    // Heading line along +x so the direction of travel is unambiguous.
    for (let metres = 0; metres <= Math.min(this.rangeM, 200); metres += 0.25) this.splat(metres, this.groundY, 0, GRID);
  }

  private drawHost(): void {
    const x0 = -2.1;
    const x1 = 2.4;
    const y0 = this.groundY + 0.2;
    const y1 = this.groundY + 1.6;
    const z0 = -0.95;
    const z1 = 0.95;
    const corners: (readonly [number, number, number])[] = [
      [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1],
      [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1],
    ];
    const edges: (readonly [number, number])[] = [
      [0, 1], [1, 2], [2, 3], [3, 0],
      [4, 5], [5, 6], [6, 7], [7, 4],
      [0, 4], [1, 5], [2, 6], [3, 7],
    ];
    for (const [from, to] of edges) {
      const a = corners[from]!;
      const b = corners[to]!;
      const steps = 40;
      for (let step = 0; step <= steps; step += 1) {
        const t = step / steps;
        this.splat(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, EGO);
      }
    }
  }
}

const APPROACHING: readonly [number, number, number] = [255, 96, 64];
const RECEDING: readonly [number, number, number] = [72, 150, 255];
const STATIONARY: readonly [number, number, number] = [210, 220, 230];

/**
 * A top-down plot of one radar frame: the sensor at the bottom centre, the
 * fan opening upward, range rings and detections coloured by range rate
 * (approaching warm, receding cool, static neutral).
 */
export class RadarVideoRasterizer extends RgbaFrame {
  private readonly originX: number;
  private readonly originY: number;
  private readonly scale: number;

  constructor(
    width: number,
    height: number,
    private readonly horizontalFovDeg: number,
    private readonly rangeM: number,
  ) {
    super(width, height);
    this.originX = width / 2;
    this.originY = height * 0.92;
    const halfFov = Math.min(Math.PI / 2, horizontalFovDeg * Math.PI / 360);
    const verticalBudget = (height * 0.86) / rangeM;
    const horizontalBudget = (width * 0.47) / (rangeM * Math.sin(halfFov));
    this.scale = Math.min(verticalBudget, horizontalBudget);
  }

  frame(scan: RadarScan): Buffer {
    this.clear();
    this.drawFan();
    for (let index = 0; index < scan.count; index += 1) {
      const depth = scan.depthM[index]!;
      const azimuth = scan.azimuthRad[index]!;
      const altitude = scan.altitudeRad[index]!;
      const ground = depth * Math.cos(altitude);
      const px = this.originX - ground * Math.sin(azimuth) * this.scale;
      const py = this.originY - ground * Math.cos(azimuth) * this.scale;
      const velocity = scan.velocityMps[index]!;
      const colour = velocity > 0.5 ? APPROACHING : velocity < -0.5 ? RECEDING : STATIONARY;
      const radius = depth < this.rangeM * 0.25 ? 4 : depth < this.rangeM * 0.6 ? 3 : 2;
      this.disc(px, py, radius, colour);
    }
    this.disc(this.originX, this.originY, 5, EGO);
    return this.pixels;
  }

  private drawFan(): void {
    const halfFov = this.horizontalFovDeg * Math.PI / 360;
    const ringStep = this.rangeM > 120 ? 50 : this.rangeM > 40 ? 25 : 10;
    for (let radius = ringStep; radius <= this.rangeM + 1e-6; radius += ringStep) {
      const arcSamples = Math.max(64, Math.round(radius * this.scale * 2 * halfFov));
      for (let sample = 0; sample <= arcSamples; sample += 1) {
        const angle = -halfFov + (2 * halfFov * sample) / arcSamples;
        this.plot(
          Math.round(this.originX - radius * Math.sin(angle) * this.scale),
          Math.round(this.originY - radius * Math.cos(angle) * this.scale),
          GRID,
        );
      }
    }
    for (const angle of [-halfFov, halfFov]) {
      this.line(
        this.originX, this.originY,
        this.originX - this.rangeM * Math.sin(angle) * this.scale,
        this.originY - this.rangeM * Math.cos(angle) * this.scale,
        GRID,
      );
    }
    this.line(this.originX, this.originY, this.originX, this.originY - this.rangeM * this.scale, GRID);
  }
}

function cross(a: readonly [number, number, number], b: readonly [number, number, number]): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalise(v: readonly [number, number, number]): [number, number, number] {
  const length = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / length, v[1] / length, v[2] / length];
}
