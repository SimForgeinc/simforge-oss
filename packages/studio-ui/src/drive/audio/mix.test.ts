import { describe, expect, it } from 'vitest';

import { emptyDriveTelemetry, type DriveTelemetry } from '../telemetry';
import { blendForRpm, crossfadeGains, playbackRateFor, type EngineBand } from './bands';
import { vehicleAudioClassFor } from './classes';
import { createLadder, createMix, createMixState, loadBlend, squealGain, brakeGain, windGain, updateMix } from './mix';
import { ENGINE_PROFILES } from './profiles';
import { ENGINE_BANDS, SHARED_SAMPLES, sampleLibraryFiles } from './samples';

const band = (rpm: number, load: 'on' | 'off' = 'on'): EngineBand => ({
  file: `${load}_${rpm}.wav`,
  rpm,
  load,
  seconds: 0.4,
});

/** Four on-load rungs an octave apart, plus one overrun rung. */
const ladder = createLadder([band(800), band(1600), band(3200), band(6400), band(1200, 'off')]);

function frame(over: Partial<DriveTelemetry> = {}): DriveTelemetry {
  return Object.assign(emptyDriveTelemetry(), { rpm: 800, gear: 1 }, over);
}

describe('blendForRpm', () => {
  it('brackets the requested speed and lands mid-fade at the geometric mean', () => {
    expect(blendForRpm([800, 1600, 3200], 1600)).toEqual({ lower: 1, upper: 2, mix: 0 });
    const mid = blendForRpm([800, 1600, 3200], Math.sqrt(1600 * 3200));
    expect(mid.lower).toBe(1);
    expect(mid.upper).toBe(2);
    expect(mid.mix).toBeCloseTo(0.5, 6);
  });

  it('clamps to the end rungs outside the ladder', () => {
    expect(blendForRpm([800, 1600], 400)).toEqual({ lower: 0, upper: 0, mix: 0 });
    expect(blendForRpm([800, 1600], 9000)).toEqual({ lower: 1, upper: 1, mix: 1 });
  });

  it('interpolates in pitch, not in RPM', () => {
    // Linear interpolation would answer 0.25 a quarter of the way up by RPM;
    // an octave-wide rung heard at its arithmetic middle is above its pitch
    // middle, so the upper loop must already be dominant.
    const linearQuarter = blendForRpm([1000, 5000], 2000);
    expect(linearQuarter.mix).toBeGreaterThan(0.4);
    expect(linearQuarter.mix).toBeLessThan(0.44);
  });
});

describe('crossfadeGains', () => {
  it('holds power constant across the fade', () => {
    for (const mix of [0, 0.13, 0.5, 0.87, 1]) {
      const [a, b] = crossfadeGains(mix);
      expect(a * a + b * b).toBeCloseTo(1, 6);
    }
  });

  it('saturates outside 0..1 rather than inverting', () => {
    expect(crossfadeGains(-3)).toEqual(crossfadeGains(0));
    expect(crossfadeGains(4)).toEqual(crossfadeGains(1));
  });
});

describe('playbackRateFor', () => {
  it('asks for the exact pitch ratio inside its range', () => {
    expect(playbackRateFor(2000, 2400)).toBeCloseTo(1.2, 6);
    expect(playbackRateFor(2000, 1600)).toBeCloseTo(0.8, 6);
  });

  it('stops tracking rather than stretching a loop past recognition', () => {
    expect(playbackRateFor(1000, 9000, 1.7)).toBeCloseTo(1.7, 6);
    expect(playbackRateFor(4000, 200, 1.7)).toBeCloseTo(1 / 1.7, 6);
  });
});

describe('updateMix', () => {
  const profile = ENGINE_PROFILES['petrol-i4'];

  it('plays exactly the bracketing pair, at unit power, everywhere in the sweep', () => {
    const mix = createMix(ladder.bands.length);
    const state = createMixState();
    for (let rpm = 700; rpm <= 7000; rpm += 100) {
      updateMix(mix, state, frame({ rpm, throttle: 1 }), profile, ladder, 1 / 60);
      const sounding = [...mix.bandGains].filter((gain) => gain > 1e-4);
      expect(sounding.length).toBeGreaterThanOrEqual(1);
      expect(sounding.length).toBeLessThanOrEqual(2);
      const power = sounding.reduce((sum, gain) => sum + gain * gain, 0);
      expect(power).toBeCloseTo(1, 5);
      // The overrun rung is silent at full throttle.
      expect(mix.bandGains[4]).toBeCloseTo(0, 6);
    }
  });

  it('resamples the sounding loops towards the engine speed', () => {
    const mix = createMix(ladder.bands.length);
    updateMix(mix, createMixState(), frame({ rpm: 2400, throttle: 1 }), profile, ladder, 1 / 60);
    // 2400 sits between the 1600 and 3200 rungs.
    expect(mix.bandRates[1]).toBeCloseTo(1.5, 6);
    expect(mix.bandRates[2]).toBeCloseTo(0.75, 6);
  });

  it('crosses to the overrun loop when the car is coasting', () => {
    const mix = createMix(ladder.bands.length);
    const state = createMixState();
    updateMix(mix, state, frame({ rpm: 1200, throttle: 0, longitudinalG: -0.25 }), profile, ladder, 1 / 60);
    expect(mix.bandGains[4]).toBeGreaterThan(0.6);
    updateMix(mix, state, frame({ rpm: 1200, throttle: 1 }), profile, ladder, 1 / 60);
    expect(mix.bandGains[4]).toBeCloseTo(0, 6);
  });

  it('opens the exhaust filter with load and shuts it on a closed throttle', () => {
    const mix = createMix(ladder.bands.length);
    const state = createMixState();
    updateMix(mix, state, frame({ rpm: 3000, throttle: 1 }), profile, ladder, 1 / 60);
    const open = mix.engineCutoffHz;
    updateMix(mix, state, frame({ rpm: 3000, throttle: 0, longitudinalG: -0.4 }), profile, ladder, 1 / 60);
    expect(open).toBeGreaterThan(mix.engineCutoffHz * 2);
    expect(mix.engineCutoffHz).toBeGreaterThanOrEqual(profile.darkHz);
  });

  it('fires the shift transient once per gear change and cuts torque behind it', () => {
    const mix = createMix(ladder.bands.length);
    const state = createMixState();
    updateMix(mix, state, frame({ rpm: 6000, gear: 1, throttle: 1 }), profile, ladder, 1 / 60);
    expect(mix.shift).toBe(0); // the first frame is not a shift
    const before = mix.engine;

    updateMix(mix, state, frame({ rpm: 6000, gear: 2, throttle: 1 }), profile, ladder, 1 / 60);
    expect(mix.shift).toBeGreaterThan(0);
    expect(mix.engine).toBeLessThan(before);

    updateMix(mix, state, frame({ rpm: 6000, gear: 2, throttle: 1 }), profile, ladder, 1 / 60);
    expect(mix.shift).toBe(0);
    expect(mix.engine).toBeLessThan(before); // still inside the cut

    updateMix(mix, state, frame({ rpm: 6000, gear: 2, throttle: 1 }), profile, ladder, 0.2);
    expect(mix.engine).toBeCloseTo(before, 6); // cut over
  });

  it('never treats neutral as a gear change', () => {
    const mix = createMix(ladder.bands.length);
    const state = createMixState();
    updateMix(mix, state, frame({ gear: 1 }), profile, ladder, 1 / 60);
    updateMix(mix, state, frame({ gear: 0 }), profile, ladder, 1 / 60);
    expect(mix.shift).toBe(0);
    updateMix(mix, state, frame({ gear: 1 }), profile, ladder, 1 / 60);
    expect(mix.shift).toBe(0);
  });

  it('scales the impact with the reported impulse, for one frame only', () => {
    const mix = createMix(ladder.bands.length);
    const state = createMixState();
    updateMix(mix, state, frame({ collisionImpulseNs: 300 }), profile, ladder, 1 / 60);
    const nudge = mix.impact;
    expect(nudge).toBeGreaterThan(0);

    updateMix(mix, state, frame({ collisionImpulseNs: 20_000 }), profile, ladder, 1 / 60);
    expect(mix.impact).toBeGreaterThan(nudge);
    expect(mix.impact).toBeLessThanOrEqual(1);
    expect(mix.impactRate).toBeLessThan(1); // a heavy hit is a lower crunch

    updateMix(mix, state, frame(), profile, ladder, 1 / 60);
    expect(mix.impact).toBe(0);
  });

  it('idles quietly and gets louder towards the redline', () => {
    const mix = createMix(ladder.bands.length);
    const state = createMixState();
    updateMix(mix, state, frame({ rpm: profile.idleRpm }), profile, ladder, 1 / 60);
    const idle = mix.engine;
    updateMix(mix, state, frame({ rpm: profile.redlineRpm, throttle: 1 }), profile, ladder, 1 / 60);
    expect(mix.engine).toBeGreaterThan(idle * 2);
  });

  it('raises wind and road with speed, and gravel only off road', () => {
    const mix = createMix(ladder.bands.length);
    const state = createMixState();
    updateMix(mix, state, frame({ speedMps: 2 }), profile, ladder, 1 / 60);
    const slowWind = mix.wind;
    expect(mix.gravel).toBe(0);

    updateMix(mix, state, frame({ speedMps: 30 }), profile, ladder, 1 / 60);
    expect(mix.wind).toBeGreaterThan(slowWind * 5);
    expect(mix.windCutoffHz).toBeGreaterThan(800);

    updateMix(mix, state, frame({ speedMps: 12, offRoad: true }), profile, ladder, 1 / 60);
    expect(mix.gravel).toBeGreaterThan(0.9);
  });
});

describe('layer curves', () => {
  it('keeps tyres quiet below the slip threshold and at a standstill', () => {
    expect(squealGain(0.8, 20)).toBe(0);
    expect(squealGain(1.2, 0.5)).toBe(0);
    expect(squealGain(0.95, 20)).toBeGreaterThan(0);
    expect(squealGain(1.4, 20)).toBe(1);
  });

  it('puts brake squeal only in the last metres of a stop', () => {
    expect(brakeGain(1, 25)).toBe(0);
    expect(brakeGain(0.1, 3)).toBe(0);
    expect(brakeGain(1, 0)).toBe(0);
    expect(brakeGain(1, 2)).toBeGreaterThan(brakeGain(1, 7));
  });

  it('ignores the load blend for a family with no overrun recordings', () => {
    expect(loadBlend(0, -0.5, false)).toBe(1);
    expect(loadBlend(0, -0.5, true)).toBeLessThan(0.3);
  });
});

describe('the impact one-shot', () => {
  const profile = ENGINE_PROFILES['petrol-i4'];

  it('fires once for a scrape that reports an impulse on every frame', () => {
    const mix = createMix(ladder.bands.length);
    const state = createMixState();
    const fired: number[] = [];
    for (let i = 0; i < 6; i++) {
      updateMix(mix, state, frame({ collisionImpulseNs: 900 }), profile, ladder, 1 / 60);
      if (mix.impact > 0) fired.push(i);
    }
    expect(fired).toEqual([0]);
  });

  it('lets a much bigger hit cut into the previous one', () => {
    const mix = createMix(ladder.bands.length);
    const state = createMixState();
    updateMix(mix, state, frame({ collisionImpulseNs: 500 }), profile, ladder, 1 / 60);
    const first = mix.impact;
    updateMix(mix, state, frame({ collisionImpulseNs: 9000 }), profile, ladder, 1 / 60);
    expect(mix.impact).toBeGreaterThan(first);
  });

  it('fires again once the hold has run out, and not before', () => {
    const mix = createMix(ladder.bands.length);
    const state = createMixState();
    const fired: number[] = [];
    // Repeated equal hits at 60 Hz: barrier posts, not a scrape.
    for (let i = 0; i < 24; i++) {
      updateMix(mix, state, frame({ collisionImpulseNs: 2000 }), profile, ladder, 1 / 60);
      if (mix.impact > 0) fired.push(i / 60);
    }
    expect(fired.length).toBeGreaterThan(1);
    for (let i = 1; i < fired.length; i++) expect(fired[i]! - fired[i - 1]!).toBeGreaterThanOrEqual(0.16);
  });
});

describe('the shipped sample library', () => {
  it('gives every family a usable ladder', () => {
    for (const [cls, bands] of Object.entries(ENGINE_BANDS)) {
      const on = bands.filter((entry) => entry.load === 'on');
      expect(on.length, cls).toBeGreaterThanOrEqual(5);
      const rpms = on.map((entry) => entry.rpm);
      expect(rpms, cls).toEqual([...rpms].sort((a, b) => a - b));
      // Neighbouring rungs must be close enough that `playbackRateFor` can
      // cover the gap between them without being clamped.
      for (let i = 1; i < rpms.length; i++) expect(rpms[i]! / rpms[i - 1]!, cls).toBeLessThan(1.7);
      expect(createLadder(bands).on.length, cls).toBe(on.length);
    }
  });

  it('spans every family from its idle to its redline', () => {
    // A sweep that leaves the ladder plays a clamped, out-of-tune end rung for
    // the rest of the gear, which is the one audio defect a driver cannot
    // ignore. The ladder therefore has to bracket the profile's own range.
    for (const [cls, bands] of Object.entries(ENGINE_BANDS)) {
      const profile = ENGINE_PROFILES[cls as keyof typeof ENGINE_PROFILES];
      const rpms = bands.filter((entry) => entry.load === 'on').map((entry) => entry.rpm);
      expect(Math.min(...rpms), cls).toBeLessThanOrEqual(Math.max(profile.idleRpm, 800));
      expect(Math.max(...rpms), cls).toBeGreaterThanOrEqual(profile.redlineRpm * 0.9);
    }
  });

  it('names one file per rung plus the shared layers, with no collisions', () => {
    const files = sampleLibraryFiles();
    expect(new Set(files).size).toBe(files.length);
    const rungs = Object.values(ENGINE_BANDS).reduce((sum, bands) => sum + bands.length, 0);
    expect(files.length).toBe(rungs + Object.keys(SHARED_SAMPLES).length);
    for (const file of files) expect(file, file).toMatch(/^[a-z0-9-]+\/[a-z0-9-]+\.wav$/);
  });

  it('keeps the wind layer inside unity gain at any speed a car can reach', () => {
    expect(windGain(0)).toBe(0);
    expect(windGain(90)).toBe(1);
    expect(windGain(20)).toBeGreaterThan(windGain(10) * 2);
  });

  it('maps the catalogue onto the families it has samples for', () => {
    expect(vehicleAudioClassFor('vehicle.semi_truck')).toBe('diesel-truck');
    expect(vehicleAudioClassFor('vehicle.tesla_model_3')).toBe('ev');
    expect(vehicleAudioClassFor('vehicle.nothing_like_this')).toBe('petrol-i4');
  });
});
