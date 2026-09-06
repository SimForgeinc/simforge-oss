/**
 * The v2 temporal core: clip window, authoring grid, interaction layout.
 *
 * No test here reads a real clock. Every time in this file is an authored number in a template, and
 * the one place a clock could leak in — `TemplateDocument.create` — is not used at all; templates are
 * built with `parseTemplate` on literal timestamps. A timeline suite that measured elapsed time would
 * be permanently unreliable under fleet load rather than merely noisy.
 */

import { parseTemplate, type ScenarioTemplateV2 } from "@simforge-oss/scenario";
import { describe, expect, it } from "vitest";

import { choreographyWindow, recordedWindow } from "../../../src/lib/scenario/timeline/clip-window";
import { rangePercent } from "../../../src/lib/scenario/timeline/geometry";
import {
  formatSeconds,
  isOnTimeGrid,
  snapToTimeGrid,
} from "../../../src/lib/scenario/timeline/grid";
import {
  authoredContentEndSeconds,
  resolveInteractionLayout,
  type ResolvedInteraction,
} from "../../../src/lib/scenario/timeline/resolve";

const T0 = "2026-08-04T12:00:00.000Z";

type InteractionInput = Record<string, unknown>;

/** A minimal valid template carrying exactly the interactions under test. */
function templateWith(
  interactions: InteractionInput[],
  options: {
    clipSeconds?: number;
    warmupSeconds?: number;
    params?: Array<Record<string, unknown>>;
  } = {},
): ScenarioTemplateV2 {
  return parseTemplate({
    scenarioVersion: 2,
    meta: { name: "timeline fixture", createdAt: T0, modifiedAt: T0, appVersion: "0.0.0-dev" },
    params: { declarations: options.params ?? [] },
    anchor: { features: [] },
    roles: [],
    choreography: {
      clipSeconds: options.clipSeconds ?? 20,
      warmupSeconds: options.warmupSeconds ?? 5,
      interactions,
    },
  });
}

function speedAt(id: string, extra: InteractionInput): InteractionInput {
  return {
    id,
    actor: "challenger",
    verb: "speed",
    target: { mode: "stop" },
    dynamics: { shape: "linear", constraint: "rate", value: 3 },
    ...extra,
  };
}

/** Indexing a resolved list without `noUncheckedIndexedAccess` complaints, and loudly on a miss. */
function only(resolved: ResolvedInteraction[]): ResolvedInteraction {
  const first = resolved[0];
  if (!first) throw new Error("expected exactly one resolved interaction");
  return first;
}

function byId(resolved: ResolvedInteraction[], id: string): ResolvedInteraction {
  const found = resolved.find((item) => item.interaction.id === id);
  if (!found) throw new Error(`no resolved interaction with id ${id}`);
  return found;
}

describe("clip window", () => {
  it("starts at zero even when legacy content carries a warm-up", () => {
    const template = templateWith([], { clipSeconds: 20, warmupSeconds: 5 });
    expect(choreographyWindow(template.choreography)).toEqual({ startMs: 0, endMs: 20000 });
  });

  it("separates the recorded window from the authoring window", () => {
    const template = templateWith([], { clipSeconds: 12, warmupSeconds: 4 });
    expect(recordedWindow(template.choreography)).toEqual({ startMs: 0, endMs: 12000 });
  });

});

describe("rangePercent", () => {
  const window = { startMs: -5000, endMs: 20000 };

  it("places a warm-up instant off the left edge rather than clamping it to zero", () => {
    // The whole reason this function exists. `timelinePercent(-2000, 20000)` clamps to 0, which draws
    // a pre-roll trigger exactly where `at(0)` would sit, and those are different scenarios.
    expect(rangePercent(-2000, window)).toBeCloseTo(12, 6);
    expect(rangePercent(window.startMs, window)).toBe(0);
  });

  it("puts the recorded origin at the warm-up's share of the rail", () => {
    expect(rangePercent(0, window)).toBeCloseTo(20, 6);
  });

  it("clamps outside the window and survives a degenerate one", () => {
    expect(rangePercent(999_999, window)).toBe(100);
    expect(rangePercent(-999_999, window)).toBe(0);
    expect(rangePercent(5, { startMs: 10, endMs: 10 })).toBe(0);
    expect(rangePercent(Number.NaN, window)).toBe(0);
  });
});

describe("authoring grid", () => {
  it("rounds to the quantum symmetrically", () => {
    expect(snapToTimeGrid(1.24)).toBe(1.2);
    expect(snapToTimeGrid(1.26)).toBe(1.3);
    expect(snapToTimeGrid(-1.26)).toBe(-1.3);
  });

  it("does not leave binary float residue on the grid", () => {
    // 0.1 + 0.2 style residue reaches a `toFixed` label as 0.3 but an equality check as false, so the
    // snap has to normalise the value itself, not just its rendering.
    expect(snapToTimeGrid(0.30000000000000004)).toBe(0.3);
    expect(isOnTimeGrid(snapToTimeGrid(2.7500001))).toBe(true);
  });

  it("normalises negative zero", () => {
    // `(-0).toFixed(1)` is "-0.0", which reads as a warm-up time on a rail where the sign is meaning.
    expect(Object.is(snapToTimeGrid(-0.02), 0)).toBe(true);
    expect(formatSeconds(-0.02)).toBe("0.0s");
  });

  it("keeps the sign on a real warm-up time", () => {
    expect(formatSeconds(-2.5)).toBe("-2.5s");
    expect(formatSeconds(3)).toBe("3.0s");
    expect(formatSeconds(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("resolveInteractionLayout", () => {
  it("places an exact `at` trigger without arming it", () => {
    const resolved = only(
      resolveInteractionLayout(
        templateWith([speedAt("brake", { trigger: { kind: "at", t: 4 }, until: { kind: "at", t: 6 } })]),
      ),
    );
    expect(resolved.range).toEqual({ startMs: 4000, endMs: 6000 });
    expect(resolved.armed).toBe(false);
    expect(resolved.openEnded).toBe(false);
    expect(resolved.axis).toBe("longitudinal");
    expect(resolved.actor).toBe("challenger");
  });

  it("runs an interaction with no `until` to the clip edge and marks it open-ended", () => {
    const resolved = only(
      resolveInteractionLayout(
        templateWith([speedAt("brake", { trigger: { kind: "at", t: 4 } })], { clipSeconds: 18 }),
      ),
    );
    expect(resolved.range).toEqual({ startMs: 4000, endMs: 18000 });
    expect(resolved.openEnded).toBe(true);
  });

  it("arms a condition trigger and bounds it by `byLatest`", () => {
    const resolved = only(
      resolveInteractionLayout(
        templateWith(
          [
            speedAt("brake", {
              trigger: {
                kind: "when",
                condition: { kind: "ttc", of: "ego", to: "challenger", op: "<", valueS: 2 },
                byLatest: 9,
              },
              until: { kind: "at", t: 12 },
            }),
          ],
          { warmupSeconds: 5 },
        ),
      ),
    );
    expect(resolved.range.startMs).toBe(0);
    expect(resolved.armed).toBe(true);
  });

  it("arms a back-solved arrival across the whole window", () => {
    const resolved = only(
      resolveInteractionLayout(
        templateWith([
          speedAt("meet", {
            trigger: {
              kind: "arrival",
              of: "challenger",
              at: { role: "ego" },
              syncWith: "ego",
              ttc: 1.8,
            },
          }),
        ]),
      ),
    );
    expect(resolved.armed).toBe(true);
    expect(resolved.range).toEqual({ startMs: 0, endMs: 20000 });
  });

  it("records an `after` chain and which end it measures from", () => {
    const resolved = resolveInteractionLayout(
      templateWith([
        speedAt("first", { trigger: { kind: "at", t: 2 }, until: { kind: "at", t: 5 } }),
        speedAt("second", {
          trigger: { kind: "after", of: "first", event: "end", delayS: 1 },
          until: { kind: "at", t: 9 },
        }),
      ]),
    );
    const second = byId(resolved, "second");
    expect(second.chainedTo).toEqual({ id: "first", event: "end" });
    // 5 s (parent's declared end) + 1 s delay — the parent's END, which v1 could not express.
    expect(second.range.startMs).toBe(6000);
    expect(second.armed).toBe(false);
    expect(byId(resolved, "first").chainedTo).toBeNull();
  });

  it("distinguishes chaining to a parent's start from chaining to its end", () => {
    const resolved = resolveInteractionLayout(
      templateWith([
        speedAt("first", { trigger: { kind: "at", t: 2 }, until: { kind: "at", t: 5 } }),
        speedAt("second", { trigger: { kind: "after", of: "first", event: "start", delayS: 1 } }),
      ]),
    );
    expect(byId(resolved, "second").range.startMs).toBe(3000);
  });

  it("resolves an expression-valued time against the params at their defaults", () => {
    const resolved = only(
      resolveInteractionLayout(
        templateWith([speedAt("brake", { trigger: { kind: "at", t: "param.tBrake + 1" } })], {
          params: [
            { id: "tBrake", type: "continuous", range: [1, 8], default: 3.5, unit: "s", tier: 1 },
          ],
        }),
      ),
    );
    expect(resolved.range.startMs).toBe(4500);
    expect(resolved.armed).toBe(false);
  });

  it("arms an expression that reads a site fact no template knows yet", () => {
    const resolved = only(
      resolveInteractionLayout(
        templateWith([speedAt("brake", { trigger: { kind: "at", t: "lane.speedLimitKph / 10" } })]),
      ),
    );
    expect(resolved.armed).toBe(true);
  });

  it("collapses an `until` that precedes its own trigger instead of inverting the rectangle", () => {
    // The model reports this as `until_before_trigger`; the layout must not also produce a negative
    // width, which would draw a chip extending leftwards out of its own lane.
    const resolved = only(
      resolveInteractionLayout(
        templateWith([
          speedAt("brake", { trigger: { kind: "at", t: 8 }, until: { kind: "at", t: 3 } }),
        ]),
      ),
    );
    expect(resolved.range.endMs).toBe(resolved.range.startMs);
    expect(resolved.range.endMs).toBeGreaterThanOrEqual(resolved.range.startMs);
  });

  it("clamps a trigger authored outside the clip into the window", () => {
    const resolved = only(
      resolveInteractionLayout(
        templateWith([speedAt("brake", { trigger: { kind: "at", t: 40 } })], { clipSeconds: 20 }),
      ),
    );
    expect(resolved.range).toEqual({ startMs: 20000, endMs: 20000 });
  });

  it("assigns one axis per verb and a distinct axis per `set` key", () => {
    const resolved = resolveInteractionLayout(
      templateWith([
        speedAt("brake", { trigger: { kind: "at", t: 1 } }),
        {
          id: "cut",
          actor: "challenger",
          verb: "changeLane",
          target: { mode: "relative", dk: -1 },
          dynamics: { shape: "linear", constraint: "rate", value: 0.8 },
          trigger: { kind: "at", t: 2 },
        },
        {
          id: "lights",
          actor: "@world",
          verb: "set",
          target: { key: "env.streetLights", value: true },
          trigger: { kind: "at", t: 3 },
        },
      ]),
    );
    expect(byId(resolved, "brake").axis).toBe("longitudinal");
    expect(byId(resolved, "cut").axis).toBe("lateral");
    expect(byId(resolved, "lights").axis).toBe("state:env.streetLights");
    expect(byId(resolved, "lights").actor).toBe("@world");
  });

  it("preserves document order and index", () => {
    const resolved = resolveInteractionLayout(
      templateWith([
        speedAt("late", { trigger: { kind: "at", t: 9 } }),
        speedAt("early", { trigger: { kind: "at", t: 1 } }),
      ]),
    );
    expect(resolved.map((item) => item.interaction.id)).toEqual(["late", "early"]);
    expect(resolved.map((item) => item.index)).toEqual([0, 1]);
  });
});

describe("authoredContentEndSeconds", () => {
  it("is zero for an empty choreography", () => {
    expect(authoredContentEndSeconds(templateWith([]))).toBe(0);
  });

  it("reaches the latest declared exact end", () => {
    const template = templateWith([
      speedAt("a", { trigger: { kind: "at", t: 2 }, until: { kind: "at", t: 7.5 } }),
      speedAt("b", { trigger: { kind: "at", t: 4 } }),
    ]);
    expect(authoredContentEndSeconds(template)).toBe(7.5);
  });

  it("is not pushed to the clip edge by an open-ended interaction", () => {
    // An open-ended interaction already runs to the edge by definition; letting it set the floor would
    // pin the clip at its current length and make shortening impossible forever.
    const template = templateWith([speedAt("a", { trigger: { kind: "at", t: 3 } })], {
      clipSeconds: 30,
    });
    expect(authoredContentEndSeconds(template)).toBe(3);
  });
});
