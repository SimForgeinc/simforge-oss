/**
 * Renders the driving simulator's sample library.
 *
 *     pnpm --filter @simforge-oss/studio-ui exec tsx scripts/generate-drive-audio.ts
 *
 * The library the graph in `src/drive/audio` plays is *synthesised*, not
 * recorded. The plan called for curated CC0/CC-BY recordings from freesound;
 * freesound's download API requires an OAuth token this machine does not have
 * (`/apiv2/search/text/` answers 401) and no other reachable CC source carries
 * a set of steady-RPM engine recordings that could be cut into per-family
 * ladders. So the loops are generated here, by physical synthesis, which is
 * the honest alternative: every file is real audible material with a known
 * spectrum, the licence is unambiguous (CC0, authored in this repository), and
 * the ladder is exactly consistent with `src/drive/audio/samples.ts`.
 *
 * Engine method — the standard pulse/resonator model. An engine's sound is a
 * train of combustion events exciting the resonances of the block, the exhaust
 * and the intake tract, plus broadband induction noise modulated at the firing
 * rate. So: place one grain per firing event (a click plus, for a diesel, a
 * high-frequency knock ring), run the train through a bank of high-Q
 * bandpasses that stand in for those resonances, add the modulated induction
 * noise, and low-pass the sum by load. An electric drive unit has no
 * combustion at all and is synthesised as gear-mesh partials plus inverter
 * whine.
 *
 * Loops: each file holds a whole number of firing events, and the file's
 * length is chosen to make that exact, so the loop point is sample-accurate
 * with no trimming and no crossfade. Every added sinusoid is quantised to a
 * multiple of the loop's own fundamental, and every filter is run twice around
 * the buffer so its state is the periodic steady state rather than a start-up
 * transient. That is why the seams are inaudible: the signal is genuinely
 * periodic, not faded.
 *
 * Levels: all engine loops of all families are normalised to the same RMS, so
 * a crossfade between two rungs and a change of family are both level-neutral;
 * the loudness of the engine as the driver hears it comes from the mix, not
 * from the recordings.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENGINE_BANDS, SHARED_SAMPLES } from '../src/drive/audio/samples';
import type { VehicleAudioClass } from '../src/drive/audio/classes';
import type { EngineBand } from '../src/drive/audio/bands';

const SAMPLE_RATE = 44_100;
/** Engine loops all land here, in dBFS RMS. */
const ENGINE_RMS_DBFS = -18;
/** One-shots are normalised by peak instead: their RMS says nothing useful. */
const ONE_SHOT_PEAK_DBFS = -1.5;

// ---------------------------------------------------------------------------
// Signal plumbing
// ---------------------------------------------------------------------------

/**
 * Mulberry32. A named, seeded generator because the library has to be
 * reproducible: regenerating it must not produce a different 3 MB of binary.
 */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

interface Biquad {
  readonly b0: number;
  readonly b1: number;
  readonly b2: number;
  readonly a1: number;
  readonly a2: number;
}

/** RBJ cookbook, normalised by a0. `q` is the filter Q, not a bandwidth. */
function bandpass(hz: number, q: number): Biquad {
  const w = (2 * Math.PI * hz) / SAMPLE_RATE;
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: alpha / a0,
    b1: 0,
    b2: -alpha / a0,
    a1: (-2 * Math.cos(w)) / a0,
    a2: (1 - alpha) / a0,
  };
}

function lowpass(hz: number, q = 0.707): Biquad {
  const w = (2 * Math.PI * Math.min(hz, SAMPLE_RATE * 0.45)) / SAMPLE_RATE;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: ((1 - cos) / 2) / a0,
    b1: (1 - cos) / a0,
    b2: ((1 - cos) / 2) / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

function highpass(hz: number, q = 0.707): Biquad {
  const w = (2 * Math.PI * hz) / SAMPLE_RATE;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: ((1 + cos) / 2) / a0,
    b1: -(1 + cos) / a0,
    b2: ((1 + cos) / 2) / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

/**
 * Filter a periodic signal without a start-up transient.
 *
 * The first pass round the buffer is thrown away and only its final state is
 * kept; because the input repeats exactly, that state is the state the filter
 * would be in after running forever, so the second pass is the steady-state
 * response and is itself exactly periodic. Without this a high-Q resonator
 * leaves a ring-up at the head of the loop that clicks once per revolution.
 */
function filterPeriodic(signal: Float64Array, ...stages: readonly Biquad[]): Float64Array {
  let input = signal;
  for (const stage of stages) {
    const out = new Float64Array(input.length);
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < input.length; i++) {
        const x0 = input[i]!;
        const y0 = stage.b0 * x0 + stage.b1 * x1 + stage.b2 * x2 - stage.a1 * y1 - stage.a2 * y2;
        x2 = x1;
        x1 = x0;
        y2 = y1;
        y1 = y0;
        if (pass === 1) out[i] = y0;
      }
    }
    input = out;
  }
  return input;
}

function mixInto(target: Float64Array, source: Float64Array, gain: number): void {
  for (let i = 0; i < target.length; i++) target[i] = target[i]! + source[i]! * gain;
}

/** Periodic white noise: one loop's worth, which repeats as noise, not as tone. */
function noise(length: number, random: () => number): Float64Array {
  const out = new Float64Array(length);
  for (let i = 0; i < length; i++) out[i] = random() * 2 - 1;
  return out;
}

/** The nearest frequency that completes a whole number of cycles in the loop. */
function periodic(hz: number, length: number): number {
  const cycles = Math.max(1, Math.round((hz * length) / SAMPLE_RATE));
  return (cycles * SAMPLE_RATE) / length;
}

function rms(signal: Float64Array): number {
  let sum = 0;
  for (const value of signal) sum += value * value;
  return Math.sqrt(sum / Math.max(1, signal.length));
}

function peak(signal: Float64Array): number {
  let max = 0;
  for (const value of signal) max = Math.max(max, Math.abs(value));
  return max;
}

/** Scale to a target RMS, backing off if that would clip. Returns the result. */
function normalizeRms(signal: Float64Array, targetDbfs: number): Float64Array {
  const level = rms(signal);
  if (level <= 0) throw new Error('normalizeRms: silence');
  let gain = 10 ** (targetDbfs / 20) / level;
  const ceiling = 10 ** (-0.8 / 20);
  if (peak(signal) * gain > ceiling) gain = ceiling / peak(signal);
  for (let i = 0; i < signal.length; i++) signal[i] = signal[i]! * gain;
  return signal;
}

function normalizePeak(signal: Float64Array, targetDbfs: number): Float64Array {
  const level = peak(signal);
  if (level <= 0) throw new Error('normalizePeak: silence');
  const gain = 10 ** (targetDbfs / 20) / level;
  for (let i = 0; i < signal.length; i++) signal[i] = signal[i]! * gain;
  return signal;
}

/**
 * A one-shot's head and tail, faded. A loop must not be faded — that is what
 * the periodic construction is for — but a one-shot played from a buffer
 * source starts and stops abruptly and a DC step at either end is a click.
 */
function fadeEnds(signal: Float64Array, headMs: number, tailMs: number): Float64Array {
  const head = Math.floor((headMs / 1000) * SAMPLE_RATE);
  const tail = Math.floor((tailMs / 1000) * SAMPLE_RATE);
  for (let i = 0; i < head && i < signal.length; i++) signal[i] = signal[i]! * (i / head);
  for (let i = 0; i < tail && i < signal.length; i++) {
    const index = signal.length - 1 - i;
    signal[index] = signal[index]! * (i / tail);
  }
  return signal;
}

/** 16-bit mono PCM WAV. */
function encodeWav(signal: Float64Array): Buffer {
  const samples = Buffer.alloc(signal.length * 2);
  for (let i = 0; i < signal.length; i++) {
    const clamped = Math.max(-1, Math.min(1, signal[i]!));
    samples.writeInt16LE(Math.round(clamped * 32_767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + samples.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(samples.length, 40);
  return Buffer.concat([header, samples]);
}

// ---------------------------------------------------------------------------
// Engine voices
// ---------------------------------------------------------------------------

interface Resonance {
  readonly hz: number;
  readonly q: number;
  readonly gain: number;
}

interface EngineSynth {
  /** Cylinders, i.e. firing events per two crank revolutions, four-stroke. */
  readonly cylinders: number;
  /**
   * Firing-interval offsets, as a fraction of one interval, repeated forever.
   * `[0]` is an even-firing engine; a crossplane V8 or a V-twin fires in
   * unevenly spaced pairs, and that irregularity is the whole character of
   * those engines.
   */
  readonly pattern: readonly number[];
  /** Block, exhaust and tailpipe resonances the firing train excites. */
  readonly resonances: readonly Resonance[];
  /** Combustion grain level, and its decay as a fraction of a firing interval. */
  readonly combustion: number;
  readonly decay: number;
  /** Diesel knock: a high-frequency ring on every firing event. */
  readonly knock: { readonly hz: number; readonly gain: number; readonly decay: number } | null;
  /** Induction noise, amplitude-modulated at the firing rate. */
  readonly intake: number;
  /** Low-pass on load and on the overrun, Hz. */
  readonly brightHz: number;
  readonly darkHz: number;
  /** Everything below this is body rumble the speaker cannot reproduce. */
  readonly rumbleHz: number;
  /**
   * An electric drive unit instead of an engine: gear-mesh order (mesh
   * frequency = motor rev/s × order) and the relative level of its partials.
   */
  readonly electric?: { readonly meshOrder: number; readonly partials: readonly number[] };
}

const SYNTH: Readonly<Record<VehicleAudioClass, EngineSynth>> = {
  'petrol-i4': {
    cylinders: 4,
    pattern: [0],
    resonances: [
      { hz: 105, q: 3.5, gain: 1 },
      { hz: 245, q: 5, gain: 0.55 },
      { hz: 620, q: 3, gain: 0.3 },
      { hz: 1450, q: 2.2, gain: 0.16 },
    ],
    combustion: 1,
    decay: 0.3,
    knock: null,
    intake: 0.5,
    brightHz: 7200,
    darkHz: 2100,
    rumbleHz: 45,
  },
  v8: {
    cylinders: 8,
    // Crossplane crank: within a bank the pairs are 90 degrees out, which is
    // why a muscle car burbles instead of buzzing.
    pattern: [0, 0.86],
    resonances: [
      { hz: 78, q: 4.5, gain: 1 },
      { hz: 186, q: 5.5, gain: 0.6 },
      { hz: 415, q: 3.6, gain: 0.34 },
      { hz: 980, q: 2.4, gain: 0.2 },
    ],
    combustion: 1.15,
    decay: 0.34,
    knock: null,
    intake: 0.42,
    brightHz: 8200,
    darkHz: 2300,
    rumbleHz: 38,
  },
  'diesel-truck': {
    cylinders: 6,
    pattern: [0],
    resonances: [
      { hz: 68, q: 5, gain: 1 },
      { hz: 152, q: 7, gain: 0.62 },
      { hz: 330, q: 4, gain: 0.3 },
    ],
    combustion: 0.9,
    decay: 0.22,
    knock: { hz: 1850, gain: 0.5, decay: 0.06 },
    intake: 0.36,
    brightHz: 4200,
    darkHz: 1300,
    rumbleHz: 32,
  },
  bus: {
    cylinders: 6,
    pattern: [0],
    resonances: [
      { hz: 58, q: 6, gain: 1 },
      { hz: 124, q: 8, gain: 0.66 },
      { hz: 292, q: 5, gain: 0.28 },
    ],
    combustion: 0.85,
    decay: 0.26,
    knock: { hz: 1520, gain: 0.34, decay: 0.07 },
    intake: 0.42,
    brightHz: 3600,
    darkHz: 1150,
    rumbleHz: 30,
  },
  ev: {
    cylinders: 2,
    pattern: [0],
    resonances: [{ hz: 900, q: 4, gain: 0.3 }],
    combustion: 0,
    decay: 0.2,
    knock: null,
    intake: 0.22,
    brightHz: 15_000,
    darkHz: 6000,
    rumbleHz: 90,
    // A single-speed reduction gear: the mesh tone and its harmonics are the
    // whine, and the third and fourth partials are what makes it electric
    // rather than merely high-pitched.
    electric: { meshOrder: 11, partials: [1, 0.62, 0.4, 0.24, 0.12] },
  },
  motorcycle: {
    cylinders: 2,
    // A 90-degree V-twin: two closely spaced bangs, then a gap.
    pattern: [0, 0.75],
    resonances: [
      { hz: 148, q: 4, gain: 1 },
      { hz: 372, q: 5.5, gain: 0.6 },
      { hz: 910, q: 3.2, gain: 0.38 },
      { hz: 2100, q: 2.4, gain: 0.2 },
    ],
    combustion: 1,
    decay: 0.28,
    knock: null,
    intake: 0.58,
    brightHz: 9500,
    darkHz: 2500,
    rumbleHz: 60,
  },
};

interface RenderedBand {
  readonly signal: Float64Array;
  /** The engine speed actually rendered, after rounding to whole firings. */
  readonly rpm: number;
  readonly seconds: number;
}

/**
 * One steady-RPM loop.
 *
 * The loop length is derived rather than given: it is the shortest length
 * above the nominal that holds a whole number of firing patterns at exactly
 * the requested engine speed. Rounding the *length* keeps the pitch exact,
 * where rounding the firing rate into a fixed length would put a band's pitch
 * up to 4% away from the rpm it is labelled with and make the ladder
 * inconsistent with itself.
 */
function renderEngineBand(cls: VehicleAudioClass, band: EngineBand): RenderedBand {
  const synth = SYNTH[cls];
  const firingsPerSecond = (band.rpm / 60) * (synth.cylinders / 2);
  const period = synth.pattern.length;
  const firings = Math.max(period * 2, Math.round((band.seconds * firingsPerSecond) / period) * period);
  const seconds = firings / firingsPerSecond;
  const length = Math.round(seconds * SAMPLE_RATE);
  const random = prng(hashSeed(`${cls}/${band.file}`));
  const onLoad = band.load === 'on';

  const train = new Float64Array(length);
  if (synth.combustion > 0) {
    const interval = length / firings;
    const grainDecay = interval * synth.decay * (onLoad ? 1 : 0.7);
    const knockDecay = synth.knock ? interval * synth.knock.decay + 0.001 * SAMPLE_RATE : 0;
    const knockHz = synth.knock ? synth.knock.hz : 0;
    const grainLength = Math.min(length, Math.ceil(grainDecay * 8 + knockDecay * 8));
    // Cylinder-to-cylinder scatter: fixed per cylinder, so the pattern still
    // repeats exactly, but no two bangs in a revolution are identical.
    const cylinderGain: number[] = [];
    for (let c = 0; c < synth.cylinders; c++) cylinderGain.push(0.85 + 0.3 * random());
    const combustion = synth.combustion * (onLoad ? 1 : 0.22);
    const knockGain = (synth.knock?.gain ?? 0) * (onLoad ? 1 : 0.42);

    for (let f = 0; f < firings; f++) {
      const offset = synth.pattern[f % period]!;
      const start = (f + offset) * interval;
      const gain = combustion * cylinderGain[f % synth.cylinders]!;
      for (let i = 0; i < grainLength; i++) {
        // A pressure step, not a click: a fast rise into an exponential fall
        // has the bandwidth of a combustion event rather than of an impulse.
        const rise = 1 - Math.exp(-i / (grainDecay * 0.18 + 1));
        const fall = Math.exp(-i / grainDecay);
        let value = gain * rise * fall;
        if (knockGain > 0) {
          value += gain * knockGain * Math.exp(-i / knockDecay) * Math.sin((2 * Math.PI * knockHz * i) / SAMPLE_RATE);
        }
        train[(Math.round(start) + i) % length] = train[(Math.round(start) + i) % length]! + value;
      }
    }
  }

  const voice = new Float64Array(length);
  for (const resonance of synth.resonances) {
    // Load opens the tract: the upper resonances are excited far harder under
    // throttle than on a trailing throttle.
    const weight = onLoad ? resonance.gain : resonance.gain * (resonance.hz > 300 ? 0.45 : 0.8);
    mixInto(voice, filterPeriodic(train, bandpass(resonance.hz, resonance.q)), weight);
  }
  mixInto(voice, train, 0.12);

  if (synth.electric) {
    const revsPerSecond = band.rpm / 60;
    let partialIndex = 0;
    for (const level of synth.electric.partials) {
      partialIndex += 1;
      const hz = periodic(revsPerSecond * synth.electric.meshOrder * partialIndex, length);
      if (hz > SAMPLE_RATE * 0.45) break;
      const phase = random() * Math.PI * 2;
      const gain = level * (onLoad ? 1 : 0.55);
      for (let i = 0; i < length; i++) {
        voice[i] = voice[i]! + gain * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE + phase);
      }
    }
    // Inverter switching residue: a fixed high tone that does not track speed.
    const switching = periodic(8000, length);
    for (let i = 0; i < length; i++) {
      voice[i] = voice[i]! + 0.05 * Math.sin((2 * Math.PI * switching * i) / SAMPLE_RATE);
    }
  }

  // Induction/exhaust flow noise, pulsing once per firing.
  const flowHz = periodic(firingsPerSecond, length);
  const flow = noise(length, random);
  for (let i = 0; i < length; i++) {
    const pulse = 0.55 + 0.45 * Math.sin((2 * Math.PI * flowHz * i) / SAMPLE_RATE);
    flow[i] = flow[i]! * pulse;
  }
  const flowBand = filterPeriodic(flow, highpass(260), lowpass(onLoad ? 3800 : 2200));
  mixInto(voice, flowBand, synth.intake * (onLoad ? 1 : 0.75));

  if (!onLoad) {
    // Overrun gurgle: the slow irregular pumping of a closed throttle.
    const gurgleHz = periodic(9, length);
    for (let i = 0; i < length; i++) {
      voice[i] = voice[i]! * (0.82 + 0.18 * Math.sin((2 * Math.PI * gurgleHz * i) / SAMPLE_RATE));
    }
  }

  const shaped = filterPeriodic(voice, highpass(synth.rumbleHz), lowpass(onLoad ? synth.brightHz : synth.darkHz, 0.8));
  return { signal: normalizeRms(shaped, ENGINE_RMS_DBFS), rpm: band.rpm, seconds: length / SAMPLE_RATE };
}

// ---------------------------------------------------------------------------
// The shared layers
// ---------------------------------------------------------------------------

/**
 * Tyre scrub. A sliding tyre is a stick-slip oscillator: the tread block grips,
 * releases and grips again at a rate set by the block pitch and the slip
 * speed, which is heard as a pair of high, wavering, strongly resonant tones
 * over a bed of rubber roar.
 */
function renderSqueal(): Float64Array {
  const length = Math.round(1.6 * SAMPLE_RATE);
  const random = prng(hashSeed('shared/tyre-squeal'));
  const out = new Float64Array(length);
  const bed = filterPeriodic(noise(length, random), bandpass(520, 1.1));
  mixInto(out, bed, 0.5);
  // Two stick-slip modes, each slowly and independently wavering: a squeal
  // that holds one pitch sounds like a test tone, not like a tyre.
  const modes = [
    { hz: 1080, depth: 0.035, rateHz: 5, gain: 1 },
    { hz: 1610, depth: 0.028, rateHz: 7, gain: 0.62 },
    { hz: 2480, depth: 0.02, rateHz: 11, gain: 0.3 },
  ];
  for (const mode of modes) {
    const carrier = periodic(mode.hz, length);
    const wobble = periodic(mode.rateHz, length);
    let phase = random() * Math.PI * 2;
    for (let i = 0; i < length; i++) {
      const hz = carrier * (1 + mode.depth * Math.sin((2 * Math.PI * wobble * i) / SAMPLE_RATE));
      phase += (2 * Math.PI * hz) / SAMPLE_RATE;
      out[i] = out[i]! + mode.gain * Math.sin(phase);
    }
  }
  const scrub = filterPeriodic(noise(length, random), bandpass(3200, 0.8));
  mixInto(out, scrub, 0.35);
  return normalizeRms(filterPeriodic(out, highpass(180)), -19);
}

/** Brake-disc squeal: two very high, very narrow modes that beat together. */
function renderBrakeSqueal(): Float64Array {
  const length = Math.round(1.2 * SAMPLE_RATE);
  const random = prng(hashSeed('shared/brake-squeal'));
  const out = new Float64Array(length);
  for (const mode of [
    { hz: 3120, gain: 1 },
    { hz: 3190, gain: 0.8 },
    { hz: 6240, gain: 0.35 },
    { hz: 9360, gain: 0.12 },
  ]) {
    const hz = periodic(mode.hz, length);
    const phase = random() * Math.PI * 2;
    for (let i = 0; i < length; i++) out[i] = out[i]! + mode.gain * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE + phase);
  }
  // Pad rasp under the tone, so the layer has a body as well as a pitch.
  mixInto(out, filterPeriodic(noise(length, random), bandpass(1400, 0.7)), 0.28);
  return normalizeRms(filterPeriodic(out, highpass(500)), -22);
}

/** Gravel: individual stones against the floorpan over a loose-surface hiss. */
function renderGravel(): Float64Array {
  const length = Math.round(1.8 * SAMPLE_RATE);
  const random = prng(hashSeed('shared/gravel'));
  const out = new Float64Array(length);
  const grains = 420;
  for (let g = 0; g < grains; g++) {
    const start = Math.floor(random() * length);
    const decay = (0.0015 + random() * 0.004) * SAMPLE_RATE;
    const gain = 0.4 + random() * 0.6;
    const hz = 900 + random() * 3400;
    const grainLength = Math.ceil(decay * 6);
    for (let i = 0; i < grainLength; i++) {
      const value = gain * Math.exp(-i / decay) * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE) * (random() * 0.4 + 0.8);
      out[(start + i) % length] = out[(start + i) % length]! + value;
    }
  }
  mixInto(out, filterPeriodic(noise(length, random), bandpass(260, 0.6)), 0.8);
  return normalizeRms(filterPeriodic(out, highpass(90), lowpass(7000)), -20);
}

/** Gearbox: a selector clunk and the dog teeth engaging behind it. */
function renderShift(): Float64Array {
  const length = Math.round(0.24 * SAMPLE_RATE);
  const random = prng(hashSeed('shared/shift'));
  const out = new Float64Array(length);
  const hits = [
    { at: 0.0, gain: 1, decay: 0.02, hz: 520 },
    { at: 0.045, gain: 0.7, decay: 0.035, hz: 190 },
    { at: 0.052, gain: 0.4, decay: 0.012, hz: 1400 },
  ];
  for (const hit of hits) {
    const start = Math.floor(hit.at * SAMPLE_RATE);
    const decay = hit.decay * SAMPLE_RATE;
    for (let i = 0; start + i < length; i++) {
      const envelope = Math.exp(-i / decay);
      out[start + i] =
        out[start + i]! +
        hit.gain * envelope * (Math.sin((2 * Math.PI * hit.hz * i) / SAMPLE_RATE) * 0.6 + (random() * 2 - 1) * 0.4);
    }
  }
  return normalizePeak(fadeEnds(filterPeriodic(out, highpass(90), lowpass(6500)), 1, 20), ONE_SHOT_PEAK_DBFS);
}

/**
 * A collision. Three things happen at once and none of them is a "bang": the
 * body panel deforms (a low thud), the structure rings (inharmonic metal
 * partials, because a car body is not a bell), and trim and glass scatter (a
 * decaying crunch). The graph resamples this one buffer by severity.
 */
function renderImpact(): Float64Array {
  const length = Math.round(1.1 * SAMPLE_RATE);
  const random = prng(hashSeed('shared/impact'));
  const out = new Float64Array(length);

  const thudDecay = 0.055 * SAMPLE_RATE;
  for (let i = 0; i < length; i++) {
    const envelope = Math.exp(-i / thudDecay);
    const sweep = 92 - 40 * (1 - envelope); // the panel slackens as it deforms
    out[i] = out[i]! + 1.1 * envelope * Math.sin((2 * Math.PI * sweep * i) / SAMPLE_RATE);
  }
  for (const partial of [
    { hz: 430, gain: 0.5, decay: 0.16 },
    { hz: 712, gain: 0.38, decay: 0.12 },
    { hz: 1103, gain: 0.3, decay: 0.1 },
    { hz: 1777, gain: 0.22, decay: 0.07 },
    { hz: 2971, gain: 0.14, decay: 0.05 },
  ]) {
    const decay = partial.decay * SAMPLE_RATE;
    const phase = random() * Math.PI * 2;
    for (let i = 0; i < length; i++) {
      out[i] = out[i]! + partial.gain * Math.exp(-i / decay) * Math.sin((2 * Math.PI * partial.hz * i) / SAMPLE_RATE + phase);
    }
  }
  const crunch = noise(length, random);
  const crunchDecay = 0.09 * SAMPLE_RATE;
  for (let i = 0; i < length; i++) crunch[i] = crunch[i]! * Math.exp(-i / crunchDecay);
  mixInto(out, filterPeriodic(crunch, bandpass(1800, 0.5)), 0.9);
  // Debris: a scatter of small ticks in the first third of the tail.
  for (let g = 0; g < 90; g++) {
    const start = Math.floor(random() ** 2 * length * 0.5) + Math.floor(0.02 * SAMPLE_RATE);
    const decay = (0.0008 + random() * 0.002) * SAMPLE_RATE;
    const hz = 2200 + random() * 5200;
    for (let i = 0; start + i < length && i < decay * 6; i++) {
      out[start + i] = out[start + i]! + 0.16 * Math.exp(-i / decay) * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE);
    }
  }
  return normalizePeak(fadeEnds(out, 0.4, 60), ONE_SHOT_PEAK_DBFS);
}

/** A two-tone horn: a minor third apart, both buzzy with harmonics. */
function renderHorn(): Float64Array {
  const length = Math.round(1 * SAMPLE_RATE);
  const random = prng(hashSeed('shared/horn'));
  const out = new Float64Array(length);
  for (const fundamental of [440, 522]) {
    for (let harmonic = 1; harmonic <= 9; harmonic++) {
      const hz = periodic(fundamental * harmonic, length);
      if (hz > SAMPLE_RATE * 0.45) break;
      const phase = random() * Math.PI * 2;
      const gain = 1 / harmonic ** 1.15;
      for (let i = 0; i < length; i++) out[i] = out[i]! + gain * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE + phase);
    }
  }
  // Diaphragm rattle: without it the horn is an organ.
  mixInto(out, filterPeriodic(noise(length, random), bandpass(2600, 0.8)), 0.1);
  return normalizeRms(filterPeriodic(out, highpass(300), lowpass(9000)), -15);
}

// ---------------------------------------------------------------------------
// Writing the library
// ---------------------------------------------------------------------------

function hashSeed(key: string): number {
  return createHash('sha256').update(key).digest().readUInt32LE(0);
}

interface AssetRecord {
  readonly title: string;
  readonly bytes: number;
  readonly seconds: number;
  readonly sample_rate: number;
  readonly loop: boolean;
  readonly rms_dbfs: number;
  readonly peak_dbfs: number;
  readonly rpm?: number;
  readonly load?: 'on' | 'off';
  readonly synthesis: string;
  readonly license: 'CC0-1.0';
  readonly author: 'SimForge Inc.';
}

const here = dirname(fileURLToPath(import.meta.url));
const outDir = process.argv[2] ?? join(here, '../../../studio/public/drive/audio');

const assets: Record<string, AssetRecord> = {};

function emit(relative: string, signal: Float64Array, record: Omit<AssetRecord, 'bytes' | 'seconds' | 'sample_rate' | 'rms_dbfs' | 'peak_dbfs' | 'license' | 'author'>): void {
  const wav = encodeWav(signal);
  const target = join(outDir, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, wav);
  assets[relative] = {
    ...record,
    bytes: wav.length,
    seconds: Number((signal.length / SAMPLE_RATE).toFixed(4)),
    sample_rate: SAMPLE_RATE,
    rms_dbfs: Number((20 * Math.log10(rms(signal))).toFixed(2)),
    peak_dbfs: Number((20 * Math.log10(peak(signal))).toFixed(2)),
    license: 'CC0-1.0',
    author: 'SimForge Inc.',
  };
}

const ENGINE_TITLES: Readonly<Record<VehicleAudioClass, string>> = {
  'petrol-i4': 'Four-cylinder petrol',
  v8: 'Naturally aspirated V8',
  'diesel-truck': 'Heavy inline-six diesel',
  bus: 'Transit diesel',
  ev: 'Single-speed electric drive unit',
  motorcycle: 'V-twin motorcycle',
};

for (const [cls, bands] of Object.entries(ENGINE_BANDS) as [VehicleAudioClass, readonly EngineBand[]][]) {
  const synth = SYNTH[cls];
  for (const band of bands) {
    const rendered = renderEngineBand(cls, band);
    emit(`${cls}/${band.file}`, rendered.signal, {
      title: `${ENGINE_TITLES[cls]}, ${band.rpm} rpm, ${band.load === 'on' ? 'on load' : 'overrun'}`,
      loop: true,
      rpm: band.rpm,
      load: band.load,
      synthesis: synth.electric
        ? `gear-mesh partials at order ${synth.electric.meshOrder} of ${band.rpm} rpm plus inverter residue, band-limited to ${band.load === 'on' ? synth.brightHz : synth.darkHz} Hz`
        : `${synth.cylinders}-cylinder four-stroke firing train at ${((band.rpm / 60) * (synth.cylinders / 2)).toFixed(1)} Hz through ${synth.resonances.length} resonances${synth.knock ? ` with ${synth.knock.hz} Hz knock` : ''}, induction noise, low-passed at ${band.load === 'on' ? synth.brightHz : synth.darkHz} Hz`,
    });
  }
}

emit(SHARED_SAMPLES.squeal, renderSqueal(), {
  title: 'Tyre scrub',
  loop: true,
  synthesis: 'three wavering stick-slip modes (1.08/1.61/2.48 kHz) over band-passed rubber roar',
});
emit(SHARED_SAMPLES.brake, renderBrakeSqueal(), {
  title: 'Brake-disc squeal',
  loop: true,
  synthesis: 'beating 3.12/3.19 kHz disc modes with harmonics and pad rasp',
});
emit(SHARED_SAMPLES.gravel, renderGravel(), {
  title: 'Loose surface',
  loop: true,
  synthesis: '420 resonant stone impacts per 1.8 s over a band-passed loose-surface bed',
});
emit(SHARED_SAMPLES.shift, renderShift(), {
  title: 'Gearbox shift',
  loop: false,
  synthesis: 'selector clunk plus dog-tooth engagement, three damped hits',
});
emit(SHARED_SAMPLES.impact, renderImpact(), {
  title: 'Collision impact',
  loop: false,
  synthesis: 'deforming-panel thud with a downward sweep, five inharmonic structural partials, band-passed crunch and debris ticks',
});
emit(SHARED_SAMPLES.horn, renderHorn(), {
  title: 'Two-tone horn',
  loop: true,
  synthesis: '440/522 Hz harmonic pair with diaphragm rattle',
});

const attribution = {
  license: 'CC0-1.0',
  license_url: 'https://creativecommons.org/publicdomain/zero/1.0/',
  source: 'Procedurally synthesised for SimForge by packages/studio-ui/scripts/generate-drive-audio.ts',
  source_url: 'https://github.com/SimForgeinc/simforge-oss',
  notice:
    'No third-party audio is included. The library was to be curated from CC0/CC-BY recordings on freesound.org; freesound requires an API token for search and download (its API answers HTTP 401 without one) and no other reachable CC0/CC-BY source carries a set of steady-RPM engine recordings that could be cut into per-family ladders, so every file here is generated by physical synthesis from the parameters in the generator. The generator is deterministic: the same revision reproduces these bytes. If licensed recordings are curated later they replace these files one for one - the ladder is specified by src/drive/audio/samples.ts, not by the generator - and this file must then carry the author, source URL and licence of each recording.',
  third_party_samples: [],
  method:
    'Engine loops: one grain per firing event (fast rise, exponential fall; plus a knock ring for the diesels), placed on the firing pattern of the family, excited through a bank of high-Q resonances standing in for block, exhaust and tailpipe, with induction noise amplitude-modulated at the firing rate, low-passed by load. Electric: gear-mesh partials plus inverter residue. Every loop holds a whole number of firing patterns at exactly its labelled engine speed, every added sinusoid completes a whole number of cycles in the loop, and every filter is run twice around the buffer so its state is the periodic steady state, which makes the loop points sample-accurate without trimming or crossfading. Engine loops are RMS-normalised to a single level across the whole library so crossfades and family changes are level-neutral; one-shots are peak-normalised.',
  generated_by: 'packages/studio-ui/scripts/generate-drive-audio.ts',
  assets,
};

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'ATTRIBUTION.json'), `${JSON.stringify(attribution, null, 2)}\n`);

const totalBytes = Object.values(assets).reduce((sum, asset) => sum + asset.bytes, 0);
process.stdout.write(
  `drive audio: ${Object.keys(assets).length} files, ${(totalBytes / 1024 / 1024).toFixed(2)} MiB -> ${outDir}\n`,
);
