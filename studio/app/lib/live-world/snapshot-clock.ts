/**
 * The sim time to draw, for a fixed-step world seen over a message channel.
 *
 * The drive's physics runs in a worker on a wall-clock interval and posts
 * every 20 ms step it took. Those steps reach the page in bursts — two or
 * three at once, then nothing until the next interval — and never on the
 * display's own cadence. Drawing "the newest step", or blending "the last two
 * steps that arrived", turns that burst pattern straight into motion: the car
 * holds still between bursts and leaps when one lands. Measured in the drive
 * at 60 Hz, a third of all frames showed the car frozen and a sixth showed it
 * jump by two steps at once.
 *
 * This clock decouples the two. It runs a render time off the wall clock at a
 * fixed lag behind it, and picks that lag as the stalest the channel's newest
 * step has been over the last half second (measured just before each arrival)
 * plus a small margin. At that lag there is always a buffered step on either
 * side of the moment being drawn, so the renderer interpolates and never
 * extrapolates, and a steady channel costs only a step or two of latency.
 * Drift between the two clocks is taken out by running a few percent fast or
 * slow — a rate change nobody can see — rather than by jumping. The render
 * time never passes the newest step and never runs backwards.
 *
 * Pure and clock-free: the caller passes wall time in, which keeps it testable
 * at any display rate without a browser.
 */

export interface SnapshotClockOptions {
  /** Added to the measured worst staleness, seconds. */
  readonly marginS?: number;
  /** Lag ceiling, seconds; a channel noisier than this holds at its newest step instead. */
  readonly maxLagS?: number;
  /** Wall seconds of arrivals the staleness estimate looks back over. */
  readonly windowS?: number;
  /** Silence longer than this (a pause, a hidden tab) restarts the estimate, seconds. */
  readonly gapResetS?: number;
  /** A render time this far behind its target, seconds, is snapped forward rather than eased. */
  readonly snapS?: number;
  /** Proportional correction, per second of error per second. */
  readonly gainPerS?: number;
  /** The most the render clock may run fast or slow, as a fraction of real time. */
  readonly maxRateDeviation?: number;
}

const DEFAULTS: Required<SnapshotClockOptions> = {
  marginS: 0.006,
  maxLagS: 0.3,
  windowS: 0.5,
  gapResetS: 0.3,
  snapS: 0.3,
  gainPerS: 2,
  maxRateDeviation: 0.1,
};

export class SnapshotClock {
  private readonly options: Required<SnapshotClockOptions>;
  /**
   * Wall time of each arrival in the window and how stale the newest step
   * was just before it (`wall - newestSim`), oldest first.
   */
  private readonly arrivalWallS: number[] = [];
  private readonly stalenessS: number[] = [];
  private newestSimS: number | null = null;
  private lastArrivalWallS: number | null = null;
  private renderSimS: number | null = null;
  private lastAdvanceWallS: number | null = null;

  constructor(options: SnapshotClockOptions = {}) {
    this.options = { ...DEFAULTS, ...options };
  }

  /**
   * `wall - render` the clock is steering for, seconds, or null while the
   * channel has not yet shown its cadence. Staleness is measured in one
   * frame (`wall - sim`), so this carries the constant offset between the two
   * clocks as well as the lag.
   */
  private get offsetS(): number | null {
    if (this.stalenessS.length === 0) return null;
    const freshest = Math.min(...this.stalenessS);
    const stalest = Math.max(...this.stalenessS);
    return Math.min(freshest + this.options.maxLagS, stalest + this.options.marginS);
  }

  /**
   * How far the drawn moment trails the freshest the channel has been, seconds:
   * the latency this clock adds. Null until the channel has shown its cadence.
   */
  get lagS(): number | null {
    const offset = this.offsetS;
    return offset === null ? null : offset - Math.min(...this.stalenessS);
  }

  /** The render time last returned by `advance`, or null before the first. */
  get renderTimeS(): number | null {
    return this.renderSimS;
  }

  /** The newest step's sim time, or null before the first. */
  get newestTimeS(): number | null {
    return this.newestSimS;
  }

  /** A step with sim time `simS` arrived at wall time `wallS`. */
  observe(simS: number, wallS: number): void {
    if (!Number.isFinite(simS) || !Number.isFinite(wallS)) return;
    const silent = this.lastArrivalWallS !== null && wallS - this.lastArrivalWallS > this.options.gapResetS;
    if (silent) {
      // The channel stopped (paused world, hidden tab). Staleness measured
      // across the gap describes a clock that was not running; re-learn the
      // channel. The render time stays parked on the newest step.
      this.arrivalWallS.length = 0;
      this.stalenessS.length = 0;
    } else if (this.newestSimS !== null) {
      this.arrivalWallS.push(wallS);
      this.stalenessS.push(wallS - this.newestSimS);
    }
    this.lastArrivalWallS = wallS;
    this.newestSimS = this.newestSimS === null ? simS : Math.max(this.newestSimS, simS);
  }

  /**
   * The sim time to draw at wall time `wallS`, or null before any step has
   * arrived. Call once per rendered frame.
   */
  advance(wallS: number): number | null {
    const newest = this.newestSimS;
    if (newest === null) return null;
    this.prune(wallS);
    const offset = this.offsetS;
    // Until the channel has shown its cadence, draw its newest step.
    const target = offset === null ? newest : wallS - offset;
    let render = this.renderSimS;
    if (render === null || this.lastAdvanceWallS === null) {
      render = target;
    } else {
      const elapsed = Math.max(0, wallS - this.lastAdvanceWallS);
      const error = target - (render + elapsed);
      if (error > this.options.snapS) {
        render = target;
      } else if (error < -this.options.snapS) {
        // Far ahead of where the channel says to be — typically parked on the
        // newest step through a silence. Go no further than the target; the
        // forward-only clamp below turns anything earlier into a hold.
        render = Math.max(render, target);
      } else {
        const deviation = clamp(
          error * this.options.gainPerS,
          -this.options.maxRateDeviation,
          this.options.maxRateDeviation,
        );
        render += elapsed * (1 + deviation);
      }
    }
    render = Math.min(render, newest);
    if (this.renderSimS !== null) render = Math.max(render, this.renderSimS);
    this.renderSimS = render;
    this.lastAdvanceWallS = wallS;
    return render;
  }

  /** The world restarted: forget everything. */
  reset(): void {
    this.arrivalWallS.length = 0;
    this.stalenessS.length = 0;
    this.newestSimS = null;
    this.lastArrivalWallS = null;
    this.renderSimS = null;
    this.lastAdvanceWallS = null;
  }

  private prune(wallS: number): void {
    const horizon = wallS - this.options.windowS;
    let drop = 0;
    // Keep the newest measurement: it is the only word on the channel's clock.
    while (drop < this.arrivalWallS.length - 1 && this.arrivalWallS[drop]! < horizon) drop += 1;
    if (drop > 0) {
      this.arrivalWallS.splice(0, drop);
      this.stalenessS.splice(0, drop);
    }
  }
}

/**
 * The pair of buffered steps around `timeS` and how far between them it lies.
 * `frames` must be sorted by time. Before the first step it returns the first;
 * past the last, the last — the caller never extrapolates.
 */
export function bracketSnapshots<T>(
  frames: readonly T[],
  timeOf: (frame: T) => number,
  timeS: number,
): { from: T; to: T; alpha: number } | null {
  if (frames.length === 0) return null;
  const first = frames[0]!;
  const last = frames[frames.length - 1]!;
  if (timeS <= timeOf(first)) return { from: first, to: first, alpha: 0 };
  if (timeS >= timeOf(last)) return { from: last, to: last, alpha: 0 };
  let lo = 0;
  let hi = frames.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (timeOf(frames[mid]!) <= timeS) lo = mid;
    else hi = mid;
  }
  const from = frames[lo]!;
  const to = frames[hi]!;
  const span = timeOf(to) - timeOf(from);
  return { from, to, alpha: span > 0 ? (timeS - timeOf(from)) / span : 0 };
}

/** Linear blend. */
export function lerp(from: number, to: number, alpha: number): number {
  return from + (to - from) * alpha;
}

/** Shortest-arc blend of two headings, radians; safe across the ±π seam. */
export function lerpAngle(from: number, to: number, alpha: number): number {
  const delta = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  return from + delta * alpha;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}
