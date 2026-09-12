/**
 * The shipped sample library: which loop files exist, what engine speed each
 * one represents, and where the shared non-engine layers live.
 *
 * This module is the library's manifest and its specification at the same
 * time. `scripts/generate-drive-audio.ts` reads it and renders exactly these
 * files, at exactly these lengths, into `studio/public/drive/audio/`; the
 * runtime reads it to know what to fetch. Nothing else in the graph knows a
 * file name.
 *
 * Ladder design: rungs are spaced so that no neighbouring pair is more than
 * about half an octave apart, because `playbackRateFor` clamps beyond that and
 * the pitch would stop tracking mid-sweep. The bottom rung sits at the
 * family's idle and the top at its redline, so the sweep never leaves the
 * ladder. Overrun (`off`) rungs are sparser: the overrun is quieter, changes
 * character less across its range, and is blended under the exhaust low-pass
 * anyway, so three rungs cover a petrol engine's whole trailing-throttle range.
 *
 * Provenance and licensing of every file is recorded in the library's
 * `ATTRIBUTION.json`, which the generator writes alongside the audio.
 */
import type { EngineBand } from './bands';
import type { VehicleAudioClass } from './classes';

/**
 * Nominal loop length, seconds. One value for the whole library: it is long
 * enough to hold several firing cycles of the slowest engine here (a 600 rpm
 * diesel fires every 50 ms) so the loop does not sound like a single repeated
 * bark, and short enough that the full library stays a few megabytes.
 *
 * Nominal, because the generator rounds each file to a whole number of firing
 * patterns — within a few percent of this — so that the loop point is
 * sample-accurate at exactly the engine speed the rung is labelled with. The
 * exact length of every file is in the library's `ATTRIBUTION.json`.
 */
const LOOP_SECONDS = 0.5;

/** The rungs of one family's ladder, on-load first, in the order they are loaded. */
function ladder(on: readonly number[], off: readonly number[]): readonly EngineBand[] {
  const rungs: EngineBand[] = [];
  for (const [load, rpms] of [
    ['on', on],
    ['off', off],
  ] as const) {
    for (const rpm of rpms) rungs.push({ file: `${load}-${rpm}.wav`, rpm, load, seconds: LOOP_SECONDS });
  }
  return rungs;
}

/**
 * The loop ladder for every engine family, relative to
 * `/drive/audio/<class>/`.
 */
export const ENGINE_BANDS: Readonly<Record<VehicleAudioClass, readonly EngineBand[]>> = {
  // A four-cylinder saloon: idle at 800, shifts at 6200.
  'petrol-i4': ladder([800, 1200, 1800, 2700, 4000, 5400, 6400], [1200, 2400, 4200]),
  // Large-displacement V8: lower idle, lazier sweep, far more low harmonics.
  v8: ladder([650, 1000, 1500, 2200, 3200, 4400, 5800], [1100, 2400, 4000]),
  // Heavy diesel: a narrow band between 600 and 2600, so the rungs are close.
  'diesel-truck': ladder([600, 850, 1150, 1500, 1900, 2300, 2700], [900, 1600, 2300]),
  // Transit diesel, geared taller and heard through a much bigger cavity.
  bus: ladder([600, 850, 1150, 1500, 1900, 2400], [900, 1700]),
  // An electric drive unit: no idle, one ratio, a whine to 12k motor rpm.
  ev: ladder([600, 1000, 1600, 2600, 4200, 6800, 10_800], [1600, 5000]),
  // A twin at motorcycle revs.
  motorcycle: ladder([1000, 1500, 2200, 3200, 4600, 6500, 9000], [1800, 4000]),
};

/**
 * The layers that are not per-family, relative to `/drive/audio/`.
 *
 * A tyre, a brake disc and a gravel shoulder sound the same under every body,
 * and the loader caches by URL, so one copy of each is shared by every car in
 * the context.
 */
export const SHARED_SAMPLES = {
  /** Sustained tyre scrub, looped, gated on tyre utilisation. */
  squeal: 'shared/tyre-squeal.wav',
  /** Brake-disc squeal, looped, the last few metres of a stop. */
  brake: 'shared/brake-squeal.wav',
  /** Loose-surface rattle, looped, the off-road flag. */
  gravel: 'shared/gravel.wav',
  /** Gearbox clunk, one-shot. */
  shift: 'shared/shift.wav',
  /** Panel-and-glass impact, one-shot, resampled by severity. */
  impact: 'shared/impact.wav',
  /** Two-tone horn, looped for as long as the button is held. */
  horn: 'shared/horn.wav',
} as const;

export type SharedSampleName = keyof typeof SHARED_SAMPLES;

/** Every file the library contains, relative to `/drive/audio/`. */
export function sampleLibraryFiles(): readonly string[] {
  const files: string[] = Object.values(SHARED_SAMPLES);
  for (const [cls, bands] of Object.entries(ENGINE_BANDS)) {
    for (const entry of bands) files.push(`${cls}/${entry.file}`);
  }
  return files;
}
