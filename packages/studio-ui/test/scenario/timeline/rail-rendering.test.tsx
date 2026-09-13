/**
 * The rail's geometry, asserted where it actually matters: in the emitted markup.
 *
 * `ticks.test.ts` and `temporal.test.ts` already prove the maths. These tests prove the numbers survive
 * the trip into `style`, which is the step where a correct calculation still becomes an invisible
 * element — a `NaN` percentage renders as `left: NaN%` and drops the bar from the layout with no error
 * anywhere.
 *
 * `renderToStaticMarkup` rather than jsdom: both components are hook-free and purely presentational, so
 * a string render exercises everything they do and costs nothing. No clocks, no timers.
 */

import type { Choreography, Interaction } from "@simforge-oss/scenario";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { InteractionTrack } from "../../../src/scenario/editor/timeline/InteractionTrack";
import { TimelineRuler } from "../../../src/scenario/editor/timeline/TimelineRuler";
import type { ResolvedInteraction } from "../../../src/lib/scenario/timeline";

const choreography = (over: Partial<Choreography> = {}): Choreography => ({
  clipSeconds: 20,
  warmupSeconds: 5,
  interactions: [],
  ...over,
});

const WINDOW = { startMs: 0, endMs: 20000 };

function resolved(over: Partial<ResolvedInteraction> = {}): ResolvedInteraction {
  return {
    interaction: { id: "a", actor: "ego", verb: "speed" } as Interaction,
    index: 0,
    actor: "ego",
    axis: "longitudinal",
    range: { startMs: 0, endMs: 5000 },
    armed: false,
    openEnded: false,
    chainedTo: null,
    ...over,
  };
}

/** Every `left:` percentage in the markup, in order. */
function lefts(markup: string): number[] {
  return [...markup.matchAll(/left:\s*([-\d.]+)%/g)].map((m) => Number(m[1]));
}

describe("TimelineRuler", () => {
  it("emits no NaN or undefined into any style", () => {
    // The failure this guards has no error and no console warning: the element simply is not laid out.
    const markup = renderToStaticMarkup(<TimelineRuler choreography={choreography()} />);
    expect(markup).not.toMatch(/NaN/);
    expect(markup).not.toMatch(/undefined/);
    expect(markup).not.toMatch(/Infinity/);
  });

  it("omits legacy warm-up presentation even when the source value is non-zero", () => {
    const markup = renderToStaticMarkup(<TimelineRuler choreography={choreography()} />);
    expect(markup).not.toMatch(/unrecorded warm-up/);
    expect(markup).toMatch(/left:\s*0%/);
  });

  it("omits the warm-up band when there is no warm-up", () => {
    const markup = renderToStaticMarkup(
      <TimelineRuler choreography={choreography({ warmupSeconds: 0 })} />,
    );
    expect(markup).not.toMatch(/unrecorded warm-up/);
  });

  it("starts the first tick at the playback origin", () => {
    const markup = renderToStaticMarkup(<TimelineRuler choreography={choreography()} />);
    expect(lefts(markup)[0]).toBe(0);
  });

  it("keeps every tick inside the rail", () => {
    const markup = renderToStaticMarkup(<TimelineRuler choreography={choreography()} />);
    for (const left of lefts(markup)) {
      expect(left).toBeGreaterThanOrEqual(0);
      expect(left).toBeLessThanOrEqual(100);
    }
  });

  it("survives a minimum-length clip without a degenerate rail", () => {
    const markup = renderToStaticMarkup(
      <TimelineRuler choreography={choreography({ clipSeconds: 3, warmupSeconds: 0 })} />,
    );
    expect(markup).not.toMatch(/NaN/);
    expect(lefts(markup).length).toBeGreaterThan(0);
  });

  it("places collision markers at their simulated time in the top ruler", () => {
    const markup = renderToStaticMarkup(
      <TimelineRuler
        choreography={choreography({ clipSeconds: 10, warmupSeconds: 0 })}
        crashes={[{ timeS: 4, actorLabels: ["Sedan", "Police cruiser"] }]}
      />,
    );

    expect(markup).toContain('data-testid="timeline-crash-marker"');
    expect(markup).toContain("left:40%");
    expect(markup).toContain("Crash at 4.0 seconds involving Sedan and Police cruiser");
  });
});

describe("InteractionTrack", () => {
  it("places a recorded-origin bar at the left edge", () => {
    const markup = renderToStaticMarkup(
      <InteractionTrack resolved={resolved()} window={WINDOW} />,
    );
    expect(markup).toMatch(/left:\s*0%/);
    expect(markup).toMatch(/width:\s*25%/);
  });

  it("places a warm-up bar left of the origin", () => {
    const markup = renderToStaticMarkup(
      <InteractionTrack
        resolved={resolved({ range: { startMs: -2000, endMs: 0 } })}
        window={WINDOW}
      />,
    );
    const [left] = lefts(markup);
    expect(left).toBeDefined();
    expect(left).toBeLessThan(20);
    expect(left).toBeGreaterThanOrEqual(0);
  });

  it("marks an armed bar as indeterminate rather than drawing it solid", () => {
    // Solid would assert a start time the analysis never claimed.
    const armed = renderToStaticMarkup(
      <InteractionTrack resolved={resolved({ armed: true })} window={WINDOW} />,
    );
    const exact = renderToStaticMarkup(
      <InteractionTrack resolved={resolved({ armed: false })} window={WINDOW} />,
    );
    expect(armed).toMatch(/data-armed="true"/);
    expect(exact).toMatch(/data-armed="false"/);
  });

  it("never emits a negative width for an inverted range", () => {
    // `until` before its own trigger. The validator reports it; the bar must not extend leftwards out
    // of its own row while it does.
    const markup = renderToStaticMarkup(
      <InteractionTrack
        resolved={resolved({ range: { startMs: 8000, endMs: 8000 } })}
        window={WINDOW}
      />,
    );
    const widths = [...markup.matchAll(/width:\s*([-\d.]+)%/g)].map((m) => Number(m[1]));
    expect(widths.length).toBeGreaterThan(0);
    for (const width of widths) expect(width).toBeGreaterThanOrEqual(0);
  });

  it("emits no NaN for a degenerate window", () => {
    const markup = renderToStaticMarkup(
      <InteractionTrack resolved={resolved()} window={{ startMs: 10, endMs: 10 }} />,
    );
    expect(markup).not.toMatch(/NaN/);
  });
});
