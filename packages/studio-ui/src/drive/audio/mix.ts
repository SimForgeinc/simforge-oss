/**
 * Telemetry to layer levels.
 *
 * This is the whole behaviour of the audio graph expressed as arithmetic: given
 * a frame of telemetry it says which engine loops play at what gain and
 * playback rate, and how loud the tyre, wind, road, brake and impact layers
 * are. The graph in `vehicle-audio.ts` does nothing but copy these numbers onto
 * AudioParams, which is what makes the interesting half of the feature
 * testable in a plain node process.
 *
 * Nothing here allocates: the caller owns one `DriveAudioMix` and one
 * `MixState` for the session and both are written in place every frame.
 */
import type { DriveTelemetry } from '../telemetry';
import { blendForRpm, crossfadeGains, playbackRateFor, type EngineBand } from './bands';
import type { EngineProfile } from './profiles';

/** Engine speed below which the tyre-squeal layer is silent, m/s. */
const SQUEAL_SPEED_GATE_MPS = 2.5;
/** Tyre utilisation at which a tyre starts to sing, and where it is screaming. */
const SQUEAL_ONSET = 0.85;
const SQUEAL_FULL = 1.05;
/** Brake squeal only exists in the last few m/s of a stop. */
const BRAKE_SQUEAL_MAX_MPS = 9;
const BRAKE_SQUEAL_MIN_PEDAL = 0.25;
/** Collision impulse that saturates the impact one-shot, N·s. */
const IMPACT_FULL_NS = 6000;
/** Shortest gap between two impact one-shots, seconds. */
const IMPACT_HOLD_SECONDS = 0.16;
/** How much bigger a hit has to be to cut into the previous one's tail. */
const IMPACT_RETRIGGER_RATIO = 1.8;
/** Length of the torque cut the gearbox takes to change gear, seconds. */
const SHIFT_CUT_SECONDS = 0.13;

/** The ladder of loops for one family, split by load and indexed once. */
export interface BandLadder {
  readonly bands: readonly EngineBand[];
  /** Indices into `bands` of the on-load loops, ascending in RPM. */
  readonly on: readonly number[];
  /** Their RPMs, in the same order, so the search needs no indirection. */
  readonly onRpm: readonly number[];
  readonly off: readonly number[];
  readonly offRpm: readonly number[];
}

export function createLadder(bands: readonly EngineBand[]): BandLadder {
  const pick = (load: 'on' | 'off'): number[] =>
    bands
      .map((band, index) => ({ band, index }))
      .filter((entry) => entry.band.load === load)
      .sort((a, b) => a.band.rpm - b.band.rpm)
      .map((entry) => entry.index);
  const on = pick('on');
  const off = pick('off');
  if (on.length === 0) throw new Error('createLadder: a family needs at least one on-load loop');
  return {
    bands,
    on,
    onRpm: on.map((index) => bands[index]!.rpm),
    off,
    offRpm: off.map((index) => bands[index]!.rpm),
  };
}

/** Per-layer levels for one frame. Gains are linear, 0..1 unless noted. */
export interface DriveAudioMix {
  /** One gain per entry of the ladder's `bands`; all but two or four are zero. */
  readonly bandGains: Float32Array;
  /** One playback rate per band. Only the audible ones are meaningful. */
  readonly bandRates: Float32Array;
  /** Master engine level, before the camera's own scaling. */
  engine: number;
  /** Cutoff of the exhaust low-pass: load opens it, a closed throttle shuts it. */
  engineCutoffHz: number;
  squeal: number;
  wind: number;
  windCutoffHz: number;
  /** Tyre roar on tarmac. */
  road: number;
  /** Loose-surface rattle, from the off-road flag. */
  gravel: number;
  brake: number;
  /** Non-zero on the single frame a gear change starts; the level to fire it at. */
  shift: number;
  /** Non-zero on the frame a collision is reported; the level to fire it at. */
  impact: number;
  /** Playback rate for that impact: a heavy hit is a lower, longer crunch. */
  impactRate: number;
}

export function createMix(bandCount: number): DriveAudioMix {
  return {
    bandGains: new Float32Array(bandCount),
    bandRates: new Float32Array(bandCount).fill(1),
    engine: 0,
    engineCutoffHz: 2000,
    squeal: 0,
    wind: 0,
    windCutoffHz: 400,
    road: 0,
    gravel: 0,
    brake: 0,
    shift: 0,
    impact: 0,
    impactRate: 1,
  };
}

/** What the mix has to remember between frames. */
export interface MixState {
  /** Gear on the previous frame; a change is what fires the shift transient. */
  gear: number;
  /** Seconds left of the torque cut that follows a shift. */
  shiftCut: number;
  /** True once a frame has been seen, so the first frame does not "shift". */
  started: boolean;
  /** Seconds left before another impact one-shot may be fired. */
  impactHold: number;
  /** The impulse that started that hold, N·s; a far bigger hit interrupts it. */
  impactRef: number;
}

export function createMixState(): MixState {
  return { gear: 0, shiftCut: 0, started: false, impactHold: 0, impactRef: 0 };
}

function clamp01(value: number): number {
  return value > 1 ? 1 : value > 0 ? value : 0;
}

/**
 * How much of the sound comes from the on-load recordings.
 *
 * Throttle is the primary signal, but a car coasting downhill at part throttle
 * is still on the overrun, so deceleration pulls the blend towards the off-load
 * loops. A family with no off-load recordings always answers 1 and relies on
 * the exhaust low-pass for the same cue.
 */
export function loadBlend(throttle: number, longitudinalG: number, hasOffBands: boolean): number {
  if (!hasOffBands) return 1;
  const pedal = clamp01(throttle * 1.6);
  const coasting = clamp01(-longitudinalG * 3) * (1 - clamp01(throttle * 4));
  return clamp01(pedal + 0.25 - coasting);
}

/** Tyre squeal level for an axle utilisation, gated by speed. */
export function squealGain(utilisation: number, speedMps: number): number {
  const slip = clamp01((utilisation - SQUEAL_ONSET) / (SQUEAL_FULL - SQUEAL_ONSET));
  if (slip <= 0) return 0;
  const speed = clamp01((Math.abs(speedMps) - SQUEAL_SPEED_GATE_MPS) / 4);
  return slip * speed;
}

/** Brake-squeal level: a hard pedal in the last few metres of a stop. */
export function brakeGain(brake: number, speedMps: number): number {
  const speed = Math.abs(speedMps);
  if (brake <= BRAKE_SQUEAL_MIN_PEDAL || speed > BRAKE_SQUEAL_MAX_MPS || speed < 0.4) return 0;
  const pedal = (brake - BRAKE_SQUEAL_MIN_PEDAL) / (1 - BRAKE_SQUEAL_MIN_PEDAL);
  return clamp01(pedal) * (1 - speed / BRAKE_SQUEAL_MAX_MPS);
}

/**
 * Wind level, which is drag noise and therefore grows faster than speed.
 *
 * The exponent is below the square the drag itself follows: what reaches the
 * listener is loudness, not power, and a squared curve leaves nothing audible
 * below motorway speed.
 */
export function windGain(speedMps: number): number {
  return clamp01(Math.pow(Math.abs(speedMps) / 38, 1.6));
}

/** Write one frame of telemetry into `mix`. `dt` is the frame's length in seconds. */
export function updateMix(
  mix: DriveAudioMix,
  state: MixState,
  telemetry: Readonly<DriveTelemetry>,
  profile: EngineProfile,
  ladder: BandLadder,
  dt: number,
): void {
  const speed = Math.abs(telemetry.speedMps);
  const rpm = Math.max(telemetry.rpm, profile.idleRpm);
  const rpmNorm = clamp01((rpm - profile.idleRpm) / Math.max(1, profile.redlineRpm - profile.idleRpm));
  const load = loadBlend(telemetry.throttle, telemetry.longitudinalG, ladder.off.length > 0);

  mix.bandGains.fill(0);
  writeGroup(mix, ladder.on, ladder.onRpm, ladder.bands, rpm, load);
  if (ladder.off.length > 0) writeGroup(mix, ladder.off, ladder.offRpm, ladder.bands, rpm, 1 - load);

  // A gear change is the one event telemetry reports only as a difference.
  mix.shift = 0;
  if (state.started && telemetry.gear !== state.gear && telemetry.gear !== 0 && state.gear !== 0) {
    mix.shift = profile.shiftGain * (0.55 + 0.45 * rpmNorm);
    state.shiftCut = SHIFT_CUT_SECONDS;
  }
  state.gear = telemetry.gear;
  state.started = true;
  state.shiftCut = Math.max(0, state.shiftCut - Math.max(0, dt));

  const loadTerm = profile.loadWeight * load + (1 - profile.loadWeight) * (0.35 + 0.65 * rpmNorm);
  mix.engine = profile.engineGain * (0.4 + 0.6 * rpmNorm) * (0.55 + 0.45 * loadTerm);
  if (state.shiftCut > 0) mix.engine *= 0.55;
  mix.engineCutoffHz = profile.darkHz + (profile.brightHz - profile.darkHz) * load;

  const utilisation = Math.max(telemetry.tyreUtilization.front, telemetry.tyreUtilization.rear);
  mix.squeal = squealGain(utilisation, speed) * (telemetry.offRoad ? 0.25 : 1);
  mix.brake = brakeGain(telemetry.brake, speed);
  mix.wind = windGain(speed) * profile.bodyGain;
  mix.windCutoffHz = 260 + 24 * speed;
  mix.road = clamp01(Math.pow(speed / 30, 0.8)) * 0.55 * profile.bodyGain * (telemetry.offRoad ? 0.4 : 1);
  mix.gravel = telemetry.offRoad ? clamp01(speed / 9) * profile.bodyGain : 0;

  // Scraping along a wall reports an impulse on every tick, and one impact
  // one-shot per frame is a machine gun. Hold off for longer than the sample's
  // own transient, but let a genuinely bigger hit cut in over the tail.
  const impulse = telemetry.collisionImpulseNs;
  state.impactHold = Math.max(0, state.impactHold - Math.max(0, dt));
  if (impulse > 0 && (state.impactHold <= 0 || impulse > state.impactRef * IMPACT_RETRIGGER_RATIO)) {
    const strength = clamp01(impulse / IMPACT_FULL_NS);
    mix.impact = 0.25 + 0.75 * strength;
    mix.impactRate = 1.3 - 0.5 * strength;
    state.impactHold = IMPACT_HOLD_SECONDS;
    state.impactRef = impulse;
  } else {
    mix.impact = 0;
  }
}

/** Crossfade one load group's bracketing pair into the mix. */
function writeGroup(
  mix: DriveAudioMix,
  indices: readonly number[],
  rpms: readonly number[],
  bands: readonly EngineBand[],
  rpm: number,
  weight: number,
): void {
  if (weight <= 0 || indices.length === 0) return;
  const blend = blendForRpm(rpms, rpm);
  const [lowerGain, upperGain] = crossfadeGains(blend.mix);
  const lower = indices[blend.lower]!;
  const upper = indices[blend.upper]!;
  mix.bandRates[lower] = playbackRateFor(bands[lower]!.rpm, rpm);
  mix.bandRates[upper] = playbackRateFor(bands[upper]!.rpm, rpm);
  if (lower === upper) {
    mix.bandGains[lower] = mix.bandGains[lower]! + weight;
    return;
  }
  mix.bandGains[lower] = mix.bandGains[lower]! + weight * lowerGain;
  mix.bandGains[upper] = mix.bandGains[upper]! + weight * upperGain;
}
