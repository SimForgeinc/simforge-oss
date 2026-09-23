import { describe, expect, it } from "vitest";

import type { ScenarioMotionDiffDto, ScenarioRevisionMotionDto } from "@simforge-oss/studio-host";

import {
  motionDiffSummary,
  renderMotionLabel,
  revisionMotionPlan,
} from "../../../src/scenario/editor/render/render-motion-model";

const motion = (active: ScenarioRevisionMotionDto["active"], legacyXoscAvailable = false): ScenarioRevisionMotionDto => ({
  revisionId: "usrev_1",
  currentEngineSemVer: "0.10.0",
  active,
  results: [],
  legacyXoscAvailable,
});

const active = (engineSemVer: string, reason: "commit" | "backfill-resimulated" | "user" = "commit") => ({
  simKey: "a".repeat(64),
  engineSemVer,
  traceSha256: "b".repeat(64),
  reason,
  original: reason === "commit",
  setAt: "2026-09-22T00:00:00Z",
});

describe("render motion model", () => {
  it("replays the original simulation of an older engine and offers an explicit re-simulation", () => {
    expect(revisionMotionPlan(motion(active("0.9.0")))).toEqual({
      kind: "replay-original",
      engineSemVer: "0.9.0",
      engineIsCurrent: false,
      resimulateLabel: "Re-simulate on engine 0.10.0",
    });
    expect(revisionMotionPlan(motion(active("0.10.0")))).toMatchObject({ kind: "replay-original", resimulateLabel: null });
  });

  it("makes a missing original visible and offers the legacy replay only when it exists", () => {
    const withXosc = revisionMotionPlan(motion(null, true));
    expect(withXosc).toMatchObject({ kind: "original-missing", legacyXoscAvailable: true, resimulateLabel: "Re-simulate on engine 0.10.0" });
    const lost = revisionMotionPlan(motion(null, false));
    expect(lost.kind === "original-missing" && lost.message).toMatch(/lost/);
  });

  it("labels a backfilled re-simulation as not the original", () => {
    expect(revisionMotionPlan(motion(active("0.9.0", "backfill-resimulated")))).toMatchObject({
      kind: "replay-active",
      note: expect.stringMatching(/not kept/),
    });
  });

  it("names every recorded motion source", () => {
    expect(renderMotionLabel({ source: "original", engineSemVer: "0.9.0" })).toBe("Original simulation · engine 0.9.0");
    expect(renderMotionLabel({ source: "resimulated", engineSemVer: "0.10.0" })).toBe("Re-simulated · engine 0.10.0");
    expect(renderMotionLabel({ source: "original-xosc", engineSemVer: null })).toMatch(/legacy OpenSCENARIO/);
    expect(renderMotionLabel({ source: null, engineSemVer: "0.9.0" })).toBe("Simulated at submission · engine 0.9.0");
    expect(renderMotionLabel(null)).toBe("Not recorded");
  });

  it("summarizes a motion diff", () => {
    const base: ScenarioMotionDiffDto = {
      schema: "simforge.motion-diff/v1",
      identical: true,
      tolerance: { positionM: 0.001, headingDeg: 0.05 },
      comparedTicks: 1001,
      unmatchedTicks: 0,
      maxPositionDeltaM: 0,
      maxHeadingDeltaDeg: 0,
      worst: null,
      firstDivergenceS: null,
      actorsChanged: [],
      actorsOnlyInBase: [],
      actorsOnlyInCandidate: [],
      base: { traceSha256: "a".repeat(64), engineSemVer: "0.9.0" },
      candidate: { traceSha256: "b".repeat(64), engineSemVer: "0.10.0" },
    };
    expect(motionDiffSummary(base)).toBe("Motion identical (engine 0.9.0 → 0.10.0).");
    expect(motionDiffSummary({ ...base, identical: false, actorsChanged: ["ego", "ped"], maxPositionDeltaM: 1.234, maxHeadingDeltaDeg: 3.5, firstDivergenceS: 4.2 }))
      .toBe("Motion changed (engine 0.9.0 → 0.10.0): 2 actors moved (max 1.23 m, 3.50°), from t = 4.20 s.");
  });
});
