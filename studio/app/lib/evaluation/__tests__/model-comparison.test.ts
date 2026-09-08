import assert from "node:assert/strict";
import { test } from "node:test";

import {
  cellUnrankable,
  comparability,
  metricUnrankable,
  rankMetric,
  type ComparisonCellResult,
  type ComparisonIdentity,
} from "../model-comparison";

const rig = (overrides: Partial<ComparisonIdentity["rig"]> = {}): ComparisonIdentity["rig"] => ({
  profile: "alpamayo-4cam",
  captureVersion: "alpamayo-4cam@5d56b3d837c8",
  cameraIds: [0, 1, 2, 6],
  resolution: { width: 512, height: 384 },
  intrinsicsSha256: "b".repeat(64),
  extrinsicsSha256: "c".repeat(64),
  historyFrames: 4,
  historyDtS: 0.1,
  cadenceHz: 10,
  renderFps: 30,
  cadenceDividesExactly: true,
  worstResampleErrorS: 0,
  ...overrides,
});

const identity = (overrides: Partial<ComparisonIdentity> = {}): ComparisonIdentity => ({
  family: "alpamayo-1",
  familyLabel: "Alpamayo 1",
  revision: "dd4a24ca",
  quant: "nf4",
  checkpointDigest: "d".repeat(64),
  policySeed: 7,
  modelRequirementVersion: "alpamayo-1@00e8e20863b4",
  rig: rig(),
  runtime: { engineVersion: "0.1.0", abiVersion: 2, addonSha256: "e".repeat(64), decisionHz: 10 },
  ...overrides,
});

const cell = (overrides: Partial<ComparisonCellResult> = {}): ComparisonCellResult => ({
  episodeId: "ep-1",
  status: "complete",
  scored: true,
  truncation: null,
  unscoredReason: null,
  metrics: { drivingScore: 0.7, routeCompletion: 0.9 },
  unavailable: [],
  scenarioInputDigest: "f".repeat(64),
  identity: identity(),
  ...overrides,
});

test("only the model differing is matched; a different rig is sensor-different", () => {
  const baseline = cell();
  const sameRigOtherModel = cell({
    identity: identity({ family: "alpamayo-1.5", familyLabel: "Alpamayo 1.5", revision: "537991f6" }),
  });
  assert.equal(comparability(baseline, sameRigOtherModel).verdict, "matched");

  // Same camera IDS, different resolution: camera ids alone are not a rig.
  const otherResolution = cell({
    identity: identity({ rig: rig({ resolution: { width: 1920, height: 1080 } }) }),
  });
  const sensor = comparability(baseline, otherResolution);
  assert.equal(sensor.verdict, "sensor-different");
  assert.ok(sensor.differing.includes("rig.resolution"));

  // Same profile NAME, different resolved geometry: caught by the version.
  const reauthored = cell({
    identity: identity({ rig: rig({ captureVersion: "alpamayo-1@ffffffffffff" }) }),
  });
  assert.equal(comparability(baseline, reauthored).verdict, "sensor-different");
});

test("quant, checkpoint, engine and cadence differences are runtime-different, not matched", () => {
  const baseline = cell();
  for (const [label, other] of [
    ["quant", cell({ identity: identity({ quant: "bf16" }) })],
    ["checkpointDigest", cell({ identity: identity({ checkpointDigest: "9".repeat(64) }) })],
    [
      "engineVersion",
      cell({
        identity: identity({
          runtime: { engineVersion: "0.2.0", abiVersion: 2, addonSha256: "e".repeat(64), decisionHz: 10 },
        }),
      }),
    ],
    [
      "decisionHz",
      cell({
        identity: identity({
          runtime: { engineVersion: "0.1.0", abiVersion: 2, addonSha256: "e".repeat(64), decisionHz: 2 },
        }),
      }),
    ],
  ] as const) {
    const detail = comparability(baseline, other);
    assert.equal(detail.verdict, "runtime-different", label);
    assert.ok(detail.differing.includes(label), `${label} named`);
  }
});

test("a resampled camera history is not matched with a clean one", () => {
  const clean = cell();
  const jittered = cell({
    identity: identity({ rig: rig({ cadenceDividesExactly: false, worstResampleErrorS: 0.0208 }) }),
  });
  const detail = comparability(clean, jittered);
  assert.equal(detail.verdict, "sensor-different");
  assert.ok(detail.differing.includes("rig.cadenceDividesExactly"));
});

test("clips rendered at different frame rates are not matched", () => {
  // 30 fps divides a 10 Hz model exactly; 24 fps does not, and the nearest
  // frame can be 20.8 ms away against a 5 ms tolerance.
  const clean = cell();
  const fromTwentyFour = cell({
    identity: identity({
      rig: rig({ renderFps: 24, cadenceDividesExactly: false, worstResampleErrorS: 0.0208 }),
    }),
  });
  const detail = comparability(clean, fromTwentyFour);
  assert.equal(detail.verdict, "sensor-different");
  assert.ok(detail.differing.includes("rig.renderFps"));
  assert.ok(detail.differing.includes("rig.worstResampleErrorS"));

  // Same flag, different magnitude: still not interchangeable.
  const worse = cell({
    identity: identity({ rig: rig({ cadenceDividesExactly: false, worstResampleErrorS: 0.0208 }) }),
  });
  const better = cell({
    identity: identity({ rig: rig({ cadenceDividesExactly: false, worstResampleErrorS: 0.004 }) }),
  });
  assert.equal(comparability(worse, better).verdict, "sensor-different");
});

test("a re-authored scenario with the same id is incomparable", () => {
  const detail = comparability(cell(), cell({ scenarioInputDigest: "0".repeat(64) }));
  assert.equal(detail.verdict, "incomparable");
  assert.deepEqual(detail.differing, ["scenarioInputDigest"]);
});

test("failure, cancellation, truncation and structural unscored read differently", () => {
  assert.equal(cellUnrankable(null), "missing");
  assert.equal(cellUnrankable(cell({ status: "failed" })), "failed");
  assert.equal(cellUnrankable(cell({ status: "cancelled" })), "cancelled");
  assert.equal(cellUnrankable(cell({ truncation: "envelope_exceeded" })), "truncated");
  assert.equal(
    cellUnrankable(cell({ scored: false, unscoredReason: "no recorded future" })),
    "unscored",
  );
  assert.equal(cellUnrankable(cell()), null);
});

test("availability is per metric, not per run", () => {
  const partial = cell({
    metrics: { drivingScore: 0.7, routeCompletion: 0.9 },
    unavailable: ["speeding"],
  });
  assert.equal(metricUnrankable(partial, "drivingScore"), null);
  assert.equal(metricUnrankable(partial, "speeding"), "metric-unavailable");
  // A metric the run never reported is unavailable, not zero.
  assert.equal(metricUnrankable(partial, "offRoad"), "metric-unavailable");
});

test("ranking counts only rows matched and defined in every column, and imputes nothing", () => {
  const rows = [
    // Matched and defined everywhere: counted.
    {
      scenarioId: "s1",
      seed: 1,
      cells: [cell({ metrics: { drivingScore: 0.6 } }), cell({ metrics: { drivingScore: 0.8 } })],
    },
    // Column 1 failed: the row is excluded from BOTH columns, so the two means
    // are taken over the same subset.
    {
      scenarioId: "s2",
      seed: 1,
      cells: [cell({ metrics: { drivingScore: 0.9 } }), cell({ status: "failed", scored: false })],
    },
    // Sensor-different: excluded and it makes the metric unorderable.
    {
      scenarioId: "s3",
      seed: 1,
      cells: [
        cell({ metrics: { drivingScore: 0.5 } }),
        cell({
          metrics: { drivingScore: 0.4 },
          identity: identity({ rig: rig({ cameraIds: [0, 1] }) }),
        }),
      ],
    },
  ];
  const ranking = rankMetric(rows, 2, "drivingScore");
  assert.equal(ranking.columns[0]!.rows, 1);
  assert.equal(ranking.columns[1]!.rows, 1);
  assert.ok(Math.abs(ranking.columns[0]!.mean! - 0.6) < 1e-12);
  assert.ok(Math.abs(ranking.columns[1]!.mean! - 0.8) < 1e-12);
  // 0.9 was NOT averaged in for the baseline: a row its partner could not run
  // is not a row where the baseline gets credit.
  assert.equal(ranking.orderable, false);
  const reasons = ranking.excluded.map((entry) => entry.reason);
  assert.ok(reasons.includes("failed"));
  assert.ok(reasons.includes("sensor-different"));
});

test("a column with no comparable rows reports null, never zero", () => {
  const rows = [
    {
      scenarioId: "s1",
      seed: 1,
      cells: [cell(), cell({ status: "failed", scored: false })],
    },
  ];
  const ranking = rankMetric(rows, 2, "drivingScore");
  assert.equal(ranking.columns[0]!.mean, null);
  assert.equal(ranking.columns[1]!.mean, null);
  assert.equal(ranking.orderable, false);
});

test("two columns of the same run are matched: a repeat is a control", () => {
  assert.equal(comparability(cell(), cell()).verdict, "matched");
});

test("two unknowns are never a match: absent identity is incomplete, not equal", () => {
  // Both sides omit the rig profile version and the runtime addon digest. Every
  // field they DID record agrees, so an equality-of-nulls rule would rank them.
  const blind = (score: number) =>
    cell({
      metrics: { drivingScore: score },
      identity: identity({
        rig: rig({ captureVersion: null }),
        runtime: { engineVersion: "0.1.0", abiVersion: 2, addonSha256: null, decisionHz: 10 },
      }),
    });
  const detail = comparability(blind(0.6), blind(0.8));
  assert.equal(detail.verdict, "incomplete-identity");
  assert.ok(detail.differing.includes("rig.captureVersion"));
  assert.ok(detail.differing.includes("runtime.addonSha256"));

  // And it is not rankable: an unknown-identity row makes the metric a set of
  // readings rather than an ordering.
  const ranking = rankMetric(
    [{ scenarioId: "s1", seed: 1, cells: [blind(0.6), blind(0.8)] }],
    2,
    "drivingScore",
  );
  assert.equal(ranking.orderable, false);
  assert.equal(ranking.columns[0]!.mean, null);
  assert.deepEqual(
    ranking.excluded.map((entry) => entry.reason),
    ["incomplete-identity"],
  );
});

test("a completed run with a partial identity is not silently comparable", () => {
  // The overclaim this guards: "these are completed runs, so nothing fake is
  // possible". A completed artifact can still omit its scenario input digest.
  const complete = cell();
  const partial = cell({ scenarioInputDigest: null });
  assert.equal(comparability(complete, partial).verdict, "incomplete-identity");
});

test("two models over one identical capture are matched: that is the comparison", () => {
  // The case the page exists for. Capture identity is family-free, so both
  // cells carry alpamayo-4cam@5d56b3d837c8; the family-prefixed requirement
  // version differs, as it must between two models, and that is metadata.
  const a = cell({
    identity: identity({
      family: "alpamayo-1",
      checkpointDigest: "a1checkpoint",
      modelRequirementVersion: "alpamayo-1@00e8e20863b4",
      rig: rig({ captureVersion: "alpamayo-4cam@5d56b3d837c8" }),
    }),
  });
  const b = cell({
    identity: identity({
      family: "alpamayo-1.5",
      checkpointDigest: "a15checkpoint",
      modelRequirementVersion: "alpamayo-1.5@e1a393f5b1d7",
      rig: rig({ captureVersion: "alpamayo-4cam@5d56b3d837c8" }),
    }),
  });
  const detail = comparability(a, b);
  // Different weights are a runtime difference by checkpoint, NOT a sensor one:
  // nothing about the imagery changed.
  assert.equal(detail.verdict, "runtime-different");
  assert.deepEqual(detail.differing, ["checkpointDigest"]);
  assert.ok(detail.metadata.includes("model.requirementVersion"));
  assert.ok(!detail.differing.includes("model.requirementVersion"));
});

test("a differing requirement version alone never makes runs sensor-different", () => {
  const base = rig({ captureVersion: "alpamayo-4cam@5d56b3d837c8" });
  const a = cell({ identity: identity({ modelRequirementVersion: "alpamayo-1@00e8e20863b4", rig: base }) });
  const b = cell({ identity: identity({ modelRequirementVersion: "alpamayo-2-super@ab9e93bced10", rig: base }) });
  const detail = comparability(a, b);
  assert.equal(detail.verdict, "matched");
  assert.deepEqual(detail.metadata, ["model.requirementVersion"]);
});

test("a genuinely different capture is still sensor-different", () => {
  const a = cell({ identity: identity({ rig: rig({ captureVersion: "alpamayo-4cam@5d56b3d837c8" }) }) });
  const b = cell({
    identity: identity({
      rig: rig({ captureVersion: "alpamayo-6cam@3187a344fb6f", cameraIds: [0, 1, 2, 3, 4, 5] }),
    }),
  });
  const detail = comparability(a, b);
  assert.equal(detail.verdict, "sensor-different");
  assert.ok(detail.differing.includes("rig.captureVersion"));
});

test("the rig preset NAME is metadata, not evidence of a different capture", () => {
  // Two families name one capture differently; the digest settles it.
  const a = cell({ identity: identity({ rig: rig({ profile: "alpamayo-4cam" }) }) });
  const b = cell({ identity: identity({ rig: rig({ profile: "a15-4cam" }) }) });
  const detail = comparability(a, b);
  assert.equal(detail.verdict, "matched");
  assert.deepEqual(detail.metadata, ["rig.profile"]);
});
