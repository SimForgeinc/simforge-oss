import { describe, expect, it } from "vitest";
import type { ScenarioRenderJobDetailDto, ScenarioRenderProgressDto } from "@simforge-oss/studio-host";
import { renderPipelineStages } from "../../../src/scenario/editor/render/render-view-model";

const base = {
  jobState: "running", attemptCount: 2, createdAt: "2026-09-22T12:00:00Z", completedAt: null,
  attempts: [{ attemptNumber: 2, workerNodeId: "staging-node", leasedAt: "2026-09-22T12:00:01Z" }],
  progressDetail: null, progressRecords: [],
} as unknown as ScenarioRenderJobDetailDto;
const downloading: ScenarioRenderProgressDto = {
  schema: "simforge.render-progress/v1", jobId: "job", attempt: 2, sequence: 1,
  timestamp: "2026-09-22T12:00:02Z", event: "stage.progress", stage: "downloading",
  completed: 12, total: 20, unit: "items", downloadedBytes: 1024, totalBytes: 2048,
};

describe("render worker stage projection", () => {
  it("shows the lease without waiting for unrelated managed pipeline events", () => {
    const progress = renderPipelineStages(base);
    expect(progress.label).toBe("Leased");
    expect(progress.percent).toBeNull();
    expect(progress.stages.find((stage) => stage.state === "active")).toMatchObject({ kind: "leased", hint: "staging-node" });
  });
  it("keeps durable stage counters when the latest record is a warning", () => {
    const progress = renderPipelineStages({ ...base, progressRecords: [downloading], progressDetail: {
      ...downloading, event: "warning", sequence: 2, code: "slow", message: "slow input",
    } });
    expect(progress.label).toBe("Downloading inputs");
    expect(progress.percent).toBe(60);
    expect(progress.stages.find((stage) => stage.state === "active")?.hint).toContain("12/20 files");
    expect(progress.stages.find((stage) => stage.state === "active")?.hint).toContain("1.0 KB / 2.0 KB");
  });
  it("does not resurrect progress from a previous failed attempt", () => {
    const progress = renderPipelineStages({ ...base, jobState: "queued", progressDetail: { ...downloading, attempt: 1 } });
    expect(progress.label).toBe("Queued");
    expect(progress.percent).toBeNull();
    expect(progress.stages.find((stage) => stage.state === "active")?.kind).toBe("queued");
  });
  it("orders records by sequence, and terminal failures stop all stages", () => {
    const records: ScenarioRenderProgressDto[] = [{ ...downloading, stage: "uploading", sequence: 20, completed: 2, total: 5 }, downloading];
    const progress = renderPipelineStages({ ...base, progressRecords: records });
    expect(progress.label).toBe("Uploading artifacts");
    expect(progress.percent).toBe(40);
    expect(progress.stages.find((stage) => stage.state === "active")?.hint).toContain("2/5 artifacts");
    const failed = renderPipelineStages({ ...base, jobState: "failed", progressRecords: records });
    expect(failed.label).toBe("Failed");
    expect(failed.stages.some((stage) => stage.state === "active")).toBe(false);
    expect(failed.percent).toBeNull();
  });
});
