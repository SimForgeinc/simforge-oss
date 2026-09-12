/**
 * RPM to loop selection.
 *
 * Each engine family ships a ladder of steady-RPM loops cut from real
 * recordings (see `samples.ts`). At any instant the graph plays the two loops
 * that bracket the current engine speed, equal-power crossfaded, each resampled
 * by `playbackRate` so its own pitch lands on the engine speed being asked for.
 * Two neighbours rather than one is what removes the audible step as the needle
 * sweeps; resampling on top of that is what removes the audible *ladder*.
 *
 * Everything here is arithmetic on plain numbers so it can be tested without
 * an AudioContext.
 */

/** One recorded loop: the engine speed it was recorded at, and its load state. */
export interface EngineBand {
  /** File name inside the family's sample directory. */
  readonly file: string;
  /** Engine speed the loop was recorded at, rev/min. */
  readonly rpm: number;
  /**
   * `on` was recorded under throttle, `off` on a trailing throttle. A family
   * whose source recording has no overrun material ships only `on` bands and
   * the graph darkens them instead.
   */
  readonly load: 'on' | 'off';
  /** Loop length in seconds, for the demo tooling and for budget reporting. */
  readonly seconds: number;
}

/** The pair of loops that bracket an engine speed, and where between them it falls. */
export interface BandBlend {
  /** Index of the lower loop in the array passed in. */
  readonly lower: number;
  /** Index of the upper loop; equal to `lower` when the ladder has one rung. */
  readonly upper: number;
  /** 0 at the lower loop's own RPM, 1 at the upper's. */
  readonly mix: number;
}

/**
 * The bracketing pair for `rpm`, interpolating in log-RPM.
 *
 * Pitch is logarithmic, so a linear mix between 1000 and 4000 would spend most
 * of its travel on the upper loop and lurch through the bottom of the range.
 * Outside the ladder the result clamps to the end rung with `mix` pinned, and
 * the caller stretches that rung with `playbackRateFor`.
 */
export function blendForRpm(rpms: readonly number[], rpm: number): BandBlend {
  if (rpms.length === 0) throw new Error('blendForRpm: no bands');
  if (rpms.length === 1 || rpm <= rpms[0]!) return { lower: 0, upper: 0, mix: 0 };
  const top = rpms.length - 1;
  if (rpm >= rpms[top]!) return { lower: top, upper: top, mix: 1 };
  // `<=`, so an engine speed sitting exactly on a rung comes back as the
  // bottom of the interval above it rather than the top of the one below.
  // Either answer crossfades to the same two gains, but only this one keeps
  // `mix` moving in one direction as the needle sweeps, which is what a
  // caller reading `mix` for anything other than the gains expects.
  let upper = 1;
  while (upper < top && rpms[upper]! <= rpm) upper += 1;
  const lower = upper - 1;
  const lo = Math.log(rpms[lower]!);
  const hi = Math.log(rpms[upper]!);
  return { lower, upper, mix: hi > lo ? (Math.log(rpm) - lo) / (hi - lo) : 1 };
}

/**
 * Equal-power weights for a crossfade position.
 *
 * Two engine loops of the same family are strongly correlated in the low
 * harmonics and uncorrelated in the roar above them, so neither a linear fade
 * (dips in the middle) nor a plain sum (bulges) holds the level; the sine pair
 * is the usual compromise and measures flat enough on these loops.
 */
export function crossfadeGains(mix: number): readonly [number, number] {
  const t = mix <= 0 ? 0 : mix >= 1 ? 1 : mix;
  const angle = (t * Math.PI) / 2;
  return [Math.cos(angle), Math.sin(angle)];
}

/**
 * How far a loop recorded at `bandRpm` must be resampled to sound at `rpm`.
 *
 * Clamped, because a loop stretched much beyond half an octave stops sounding
 * like an engine and starts sounding like a tape machine: at the ends of the
 * ladder the pitch simply stops tracking, which is far less noticeable than the
 * artefact would be.
 */
export function playbackRateFor(bandRpm: number, rpm: number, maxStretch = 1.7): number {
  if (bandRpm <= 0) return 1;
  const ratio = rpm / bandRpm;
  const lo = 1 / maxStretch;
  return ratio < lo ? lo : ratio > maxStretch ? maxStretch : ratio;
}
