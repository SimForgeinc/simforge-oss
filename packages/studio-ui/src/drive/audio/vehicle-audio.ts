/**
 * The Web Audio graph for one car.
 *
 * ```
 *  band loops ─gain─┐
 *                   ├─► engine bus ─► exhaust low-pass ─► engine gain ─┐
 *  pink noise ─┬─ wind low-pass ─► wind gain ───────────────────────────┤
 *              └─ road band-pass ─► road gain ────────────────────────  ┤
 *  gravel loop ─► gravel gain ─────────────────────────────────────────►├─► cabin
 *  squeal loop ─► squeal gain ─────────────────────────────────────────►│   low-pass
 *  brake loop  ─► brake gain  ─────────────────────────────────────────►│      │
 *  horn loop   ─► horn gain   ─────────────────────────────────────────►│      ▼
 *  shift / impact one-shots ───────────────────────────────────────────►┘   master ─► [panner] ─► out
 * ```
 *
 * Every per-frame number comes from `updateMix`, which is pure; this module
 * only owns nodes, the sample loading, and the smoothing time constants.
 */
import type { DriveTelemetry } from '../telemetry';
import { createLadder, createMix, createMixState, updateMix, type BandLadder, type DriveAudioMix, type MixState } from './mix';
import { CAMERA_ACOUSTICS, ENGINE_PROFILES, type DriveCamera, type EngineProfile } from './profiles';
import { ENGINE_BANDS, SHARED_SAMPLES } from './samples';
import type { VehicleAudioClass } from './classes';
import { loadSample } from './loader';
import { createNoiseSource } from './noise';

/** Where the sample library is served from; the studio host serves `public/`. */
const DEFAULT_BASE_URL = '/drive/audio';

/**
 * Smoothing constants, seconds. Level follows the telemetry closely enough to
 * feel connected to the throttle; the cabin filter is slower because a camera
 * change should sound like a door closing, not like a switch.
 */
const TAU_GAIN = 0.03;
const TAU_RATE = 0.02;
const TAU_FILTER = 0.05;
const TAU_CAMERA = 0.08;

export interface VehicleAudioOptions {
  /** Root the samples are served from. Default `/drive/audio`. */
  readonly baseUrl?: string;
  /** Where the car's output goes. Default `ctx.destination`. */
  readonly destination?: AudioNode;
  /**
   * Place the car in space with a PannerNode. Traffic uses this; the car the
   * player is sitting in does not, because a panner on the listener's own
   * vehicle only makes its engine wander.
   */
  readonly spatial?: boolean;
  /**
   * Play only the on-load loops. Halves the running sources per car, which is
   * what makes a street full of traffic affordable.
   */
  readonly compact?: boolean;
  /** Initial master volume, 0..1. Default 1. */
  readonly volume?: number;
  /** Start muted. Default false. */
  readonly muted?: boolean;
  /**
   * Drop the engine entirely and keep the tyre, wind, brake and impact layers.
   * A bicycle takes an engine family like everything else so the rest of the
   * graph needs no special case, and then silences it; nothing is fetched for
   * the bands that would not be heard.
   */
  readonly silentEngine?: boolean;
}

/** Listener pose in the world, metres, with a unit forward and up vector. */
export interface ListenerPose {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly forwardX: number;
  readonly forwardY: number;
  readonly forwardZ: number;
  readonly upX?: number;
  readonly upY?: number;
  readonly upZ?: number;
}

export interface VehicleAudio {
  /** Apply one frame of telemetry. `dt` is the frame's length in seconds. */
  update(telemetry: Readonly<DriveTelemetry>, dt?: number): void;
  /** Switch cabin acoustics. */
  setCamera(camera: DriveCamera): void;
  /** Move the listener. Shared by every car in the context. */
  setListener(pose: ListenerPose): void;
  /** Move this car, for a spatial voice. Ignored for a non-spatial one. */
  setPosition(x: number, y: number, z: number): void;
  setMasterVolume(volume: number): void;
  setMuted(muted: boolean): void;
  /** Hold the horn down, or let it go. */
  setHorn(on: boolean): void;
  /** Resolves when every sample is decoded and the car is actually audible. */
  readonly ready: Promise<void>;
  dispose(): void;
}

/** Set a param with a short exponential approach, ignoring rubbish input. */
function glide(param: AudioParam, value: number, tau: number, now: number): void {
  if (!Number.isFinite(value)) return;
  param.setTargetAtTime(value, now, tau);
}

/**
 * Resume the context on the first user gesture.
 *
 * Autoplay policy suspends a context created before the user has interacted
 * with the page, and the simulator creates its context while the map is still
 * loading. Nothing here creates or closes the context — that belongs to the
 * caller — so this only installs a one-shot resume and takes it back off again.
 */
function unlockOnGesture(ctx: AudioContext): () => void {
  if (ctx.state !== 'suspended' || typeof window === 'undefined') return () => {};
  const events = ['pointerdown', 'keydown', 'touchstart'] as const;
  const resume = (): void => {
    void ctx.resume();
    off();
  };
  const off = (): void => {
    for (const event of events) window.removeEventListener(event, resume);
  };
  for (const event of events) window.addEventListener(event, resume, { once: true, passive: true });
  return off;
}

export function createVehicleAudio(
  ctx: AudioContext,
  vehicleClass: VehicleAudioClass,
  options: VehicleAudioOptions = {},
): VehicleAudio {
  const profile: EngineProfile = ENGINE_PROFILES[vehicleClass];
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const all = ENGINE_BANDS[vehicleClass];
  const bands = options.compact ? all.filter((band) => band.load === 'on') : all;
  const ladder: BandLadder = createLadder(bands);
  const mix: DriveAudioMix = createMix(bands.length);
  const state: MixState = createMixState();

  // Volume and mute are two independent controls of one gain, so both have to
  // be remembered: unmuting has to return to the volume the pause menu is
  // showing, not to the volume the car was created with.
  let volume = Math.max(0, Math.min(1, options.volume ?? 1));
  let muted = options.muted ?? false;
  const master = ctx.createGain();
  master.gain.value = muted ? 0 : volume;
  const cabin = ctx.createBiquadFilter();
  cabin.type = 'lowpass';
  cabin.frequency.value = CAMERA_ACOUSTICS.chase.cutoffHz;
  cabin.Q.value = 0.7;
  cabin.connect(master);

  let panner: PannerNode | undefined;
  if (options.spatial) {
    panner = ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 6;
    panner.maxDistance = 220;
    panner.rolloffFactor = 1.1;
    master.connect(panner);
    panner.connect(options.destination ?? ctx.destination);
  } else {
    master.connect(options.destination ?? ctx.destination);
  }

  // Engine bus: every loop feeds one low-pass that stands in for the exhaust.
  const engineGain = ctx.createGain();
  engineGain.gain.value = 0;
  const exhaust = ctx.createBiquadFilter();
  exhaust.type = 'lowpass';
  exhaust.frequency.value = profile.darkHz;
  exhaust.Q.value = 0.6;
  exhaust.connect(engineGain);
  engineGain.connect(cabin);

  const bandSources: AudioBufferSourceNode[] = [];
  const bandGains: GainNode[] = [];
  for (let i = 0; i < bands.length; i++) {
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(exhaust);
    bandGains.push(gain);
  }

  const layerGain = (): GainNode => {
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(cabin);
    return gain;
  };
  const windGain = layerGain();
  const roadGain = layerGain();
  const gravelGain = layerGain();
  const squealGain = layerGain();
  const brakeGain = layerGain();
  const hornGain = layerGain();
  const oneShotBus = ctx.createGain();
  oneShotBus.connect(cabin);

  const windFilter = ctx.createBiquadFilter();
  windFilter.type = 'lowpass';
  windFilter.frequency.value = 400;
  windFilter.Q.value = 0.5;
  windFilter.connect(windGain);
  const roadFilter = ctx.createBiquadFilter();
  roadFilter.type = 'bandpass';
  roadFilter.frequency.value = 130;
  roadFilter.Q.value = 0.8;
  roadFilter.connect(roadGain);

  let camera: DriveCamera = 'chase';
  const engineAudible = !options.silentEngine;
  let disposed = false;
  let loaded = false;
  let shiftBuffer: AudioBuffer | undefined;
  let impactBuffer: AudioBuffer | undefined;
  let noise: AudioNode | undefined;
  const loops: AudioBufferSourceNode[] = [];
  const untieGesture = unlockOnGesture(ctx);

  const startLoop = (buffer: AudioBuffer, target: GainNode): AudioBufferSourceNode => {
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(target);
    source.start(ctx.currentTime + 0.01 * Math.random());
    loops.push(source);
    return source;
  };

  const ready = (async (): Promise<void> => {
    const [bandBuffers, squeal, brake, gravel, shift, impact, horn, noiseNode] = await Promise.all([
      Promise.all(engineAudible ? bands.map((band) => loadSample(ctx, `${baseUrl}/${vehicleClass}/${band.file}`)) : []),
      loadSample(ctx, `${baseUrl}/${SHARED_SAMPLES.squeal}`),
      loadSample(ctx, `${baseUrl}/${SHARED_SAMPLES.brake}`),
      loadSample(ctx, `${baseUrl}/${SHARED_SAMPLES.gravel}`),
      loadSample(ctx, `${baseUrl}/${SHARED_SAMPLES.shift}`),
      loadSample(ctx, `${baseUrl}/${SHARED_SAMPLES.impact}`),
      loadSample(ctx, `${baseUrl}/${SHARED_SAMPLES.horn}`),
      createNoiseSource(ctx),
    ]);
    if (disposed) return;
    bandBuffers.forEach((buffer, i) => {
      bandSources.push(startLoop(buffer, bandGains[i]!));
    });
    startLoop(squeal, squealGain);
    startLoop(brake, brakeGain);
    startLoop(gravel, gravelGain);
    startLoop(horn, hornGain);
    shiftBuffer = shift;
    impactBuffer = impact;
    noise = noiseNode;
    noise.connect(windFilter);
    noise.connect(roadFilter);
    loaded = true;
  })();

  /**
   * Play a one-shot at `when`. The time is explicit rather than "now" so that
   * the graph can be driven by a clock other than the wall clock: an offline
   * render pre-schedules a whole session in one pass, and a bare `start()`
   * would stack every gear change and every crash at zero.
   */
  const fire = (buffer: AudioBuffer | undefined, gain: number, rate: number, when: number): void => {
    if (!buffer) return;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rate;
    const level = ctx.createGain();
    level.gain.value = gain;
    source.connect(level);
    level.connect(oneShotBus);
    source.onended = (): void => {
      source.disconnect();
      level.disconnect();
    };
    source.start(when);
  };

  return {
    ready,
    update(telemetry: Readonly<DriveTelemetry>, dt = 1 / 60): void {
      if (disposed) return;
      updateMix(mix, state, telemetry, profile, ladder, dt);
      if (!loaded) return;
      const now = ctx.currentTime;
      const acoustics = CAMERA_ACOUSTICS[camera];
      for (let i = 0; i < bandSources.length; i++) {
        glide(bandGains[i]!.gain, mix.bandGains[i]!, TAU_GAIN, now);
        glide(bandSources[i]!.playbackRate, mix.bandRates[i]!, TAU_RATE, now);
      }
      if (engineAudible) {
        glide(engineGain.gain, mix.engine * acoustics.engineScale, TAU_GAIN, now);
        glide(exhaust.frequency, mix.engineCutoffHz, TAU_FILTER, now);
      }
      glide(windGain.gain, mix.wind * 0.5 * acoustics.bodyScale, TAU_GAIN, now);
      glide(windFilter.frequency, mix.windCutoffHz, TAU_FILTER, now);
      glide(roadGain.gain, mix.road * acoustics.bodyScale, TAU_GAIN, now);
      glide(gravelGain.gain, mix.gravel * 0.8 * acoustics.bodyScale, TAU_GAIN, now);
      glide(squealGain.gain, mix.squeal * 0.9, TAU_GAIN, now);
      glide(brakeGain.gain, mix.brake * 0.5, TAU_GAIN, now);
      if (mix.shift > 0) fire(shiftBuffer, mix.shift * 0.7, 1, now);
      if (mix.impact > 0) fire(impactBuffer, mix.impact, mix.impactRate, now);
    },
    setCamera(next: DriveCamera): void {
      camera = next;
      if (disposed) return;
      glide(cabin.frequency, CAMERA_ACOUSTICS[next].cutoffHz, TAU_CAMERA, ctx.currentTime);
    },
    setListener(pose: ListenerPose): void {
      const listener = ctx.listener;
      const now = ctx.currentTime;
      const upX = pose.upX ?? 0;
      const upY = pose.upY ?? 1;
      const upZ = pose.upZ ?? 0;
      if (listener.positionX) {
        glide(listener.positionX, pose.x, TAU_GAIN, now);
        glide(listener.positionY, pose.y, TAU_GAIN, now);
        glide(listener.positionZ, pose.z, TAU_GAIN, now);
        glide(listener.forwardX, pose.forwardX, TAU_GAIN, now);
        glide(listener.forwardY, pose.forwardY, TAU_GAIN, now);
        glide(listener.forwardZ, pose.forwardZ, TAU_GAIN, now);
        glide(listener.upX, upX, TAU_GAIN, now);
        glide(listener.upY, upY, TAU_GAIN, now);
        glide(listener.upZ, upZ, TAU_GAIN, now);
        return;
      }
      // Safari still only has the deprecated setters.
      listener.setPosition(pose.x, pose.y, pose.z);
      listener.setOrientation(pose.forwardX, pose.forwardY, pose.forwardZ, upX, upY, upZ);
    },
    setPosition(x: number, y: number, z: number): void {
      if (!panner) return;
      const now = ctx.currentTime;
      if (panner.positionX) {
        glide(panner.positionX, x, TAU_GAIN, now);
        glide(panner.positionY, y, TAU_GAIN, now);
        glide(panner.positionZ, z, TAU_GAIN, now);
        return;
      }
      panner.setPosition(x, y, z);
    },
    setMasterVolume(next: number): void {
      volume = Number.isFinite(next) ? Math.max(0, Math.min(1, next)) : volume;
      glide(master.gain, muted ? 0 : volume, TAU_CAMERA, ctx.currentTime);
    },
    setMuted(next: boolean): void {
      muted = next;
      glide(master.gain, muted ? 0 : volume, TAU_CAMERA, ctx.currentTime);
    },
    setHorn(on: boolean): void {
      glide(hornGain.gain, on ? 0.8 : 0, 0.008, ctx.currentTime);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      untieGesture();
      for (const loop of loops) {
        loop.stop();
        loop.disconnect();
      }
      noise?.disconnect();
      for (const gain of bandGains) gain.disconnect();
      for (const node of [windFilter, roadFilter, windGain, roadGain, gravelGain, squealGain, brakeGain, hornGain, oneShotBus, exhaust, engineGain, cabin, master]) {
        node.disconnect();
      }
      panner?.disconnect();
    },
  };
}
