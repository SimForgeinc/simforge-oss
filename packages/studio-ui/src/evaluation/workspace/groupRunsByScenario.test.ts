import { describe, expect, it } from "vitest";
import type { ComputeJob } from "@simforge-oss/evaluation/client";
import { groupRunsByScenario, sourceRenderJobId } from "./groupRunsByScenario";

function job(id: string, createdAt: string, params: unknown = null): ComputeJob {
  return {
    id,
    kind: "alpamayo.openloop",
    status: "succeeded",
    origin: "desktop",
    organizationId: "w1",
    submittedByUserId: "u1",
    submittedByEmail: null,
    model: { family: "alpamayo-1.5", revision: "a".repeat(40), quant: "bf16" },
    inputs: [],
    params,
    createdAt,
    updatedAt: createdAt,
    startedAt: null,
    finishedAt: null,
    queuedSeconds: null,
    cancellable: false,
    cancelRequestedAt: null,
    estimateCents: { lowCents: 0, highCents: 0, basis: "measured" },
    reservedCents: 0,
    settledCents: null,
    scored: null,
    attempt: null,
    result: null,
    error: null,
  };
}

describe("sourceRenderJobId", () => {
  it("reads the link from the job row, the params bag or the handoff provenance", () => {
    expect(sourceRenderJobId({ ...job("j", "2026-01-01T00:00:00Z"), sourceRenderJobId: "r1" })).toBe("r1");
    expect(sourceRenderJobId(job("j", "2026-01-01T00:00:00Z", { sourceRenderJobId: "r2" }))).toBe("r2");
    expect(sourceRenderJobId(job("j", "2026-01-01T00:00:00Z", { provenance: { renderJobId: "r3" } }))).toBe("r3");
  });

  it("reports no link rather than guessing one", () => {
    expect(sourceRenderJobId(job("j", "2026-01-01T00:00:00Z"))).toBeNull();
    expect(sourceRenderJobId(job("j", "2026-01-01T00:00:00Z", { sourceRenderJobId: 7 }))).toBeNull();
    expect(sourceRenderJobId(job("j", "2026-01-01T00:00:00Z", "params-as-string"))).toBeNull();
  });
});

describe("groupRunsByScenario", () => {
  const titles = new Map([
    ["r1", "Roundabout yield"],
    ["r2", "Highway merge"],
  ]);

  it("orders scenario groups by their newest run and puts uploads last", () => {
    const groups = groupRunsByScenario(
      [
        job("a", "2026-01-01T10:00:00Z", { sourceRenderJobId: "r1" }),
        job("b", "2026-01-03T10:00:00Z", { sourceRenderJobId: "r2" }),
        job("c", "2026-01-02T10:00:00Z", { sourceRenderJobId: "r1" }),
        job("d", "2026-01-04T10:00:00Z"),
      ],
      titles,
    );
    expect(groups.map((group) => group.title)).toEqual([
      "Highway merge",
      "Roundabout yield",
      "Uploaded clips",
    ]);
    expect(groups[1]?.jobs.map((entry) => entry.id)).toEqual(["c", "a"]);
  });

  it("groups a run whose render job has no resolved title under uploaded clips", () => {
    const groups = groupRunsByScenario(
      [job("a", "2026-01-01T10:00:00Z", { sourceRenderJobId: "unknown-render-job" })],
      titles,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ kind: "uploads", title: "Uploaded clips", renderJobId: null });
  });

  it("omits the uploads group when every run has a scenario", () => {
    const groups = groupRunsByScenario([job("a", "2026-01-01T10:00:00Z", { sourceRenderJobId: "r1" })], titles);
    expect(groups.map((group) => group.kind)).toEqual(["scenario"]);
  });

  it("is deterministic when two scenarios share their newest timestamp", () => {
    const runs = [
      job("a", "2026-01-01T10:00:00Z", { sourceRenderJobId: "r2" }),
      job("b", "2026-01-01T10:00:00Z", { sourceRenderJobId: "r1" }),
    ];
    const forward = groupRunsByScenario(runs, titles).map((group) => group.key);
    const reversed = groupRunsByScenario([...runs].reverse(), titles).map((group) => group.key);
    expect(forward).toEqual(["r1", "r2"]);
    expect(reversed).toEqual(forward);
  });
});
