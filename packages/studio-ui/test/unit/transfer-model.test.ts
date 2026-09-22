import { describe, expect, it } from "vitest";
import type { ScenarioTransferCandidateDto } from "@simforge-oss/studio-host";
import {
  batchSummary,
  candidateKey,
  errorMessage,
  failedKeys,
  runBatch,
  scenarioFailure,
  selectedRefs,
  statusLine,
  toggleSelection,
  variationTitles,
  type CandidateRef,
  type CreateJob,
  type MapSearch,
} from "../../src/scenario/list/transfer/transfer-model";

/**
 * The transfer overlay's rules, without the overlay: selecting placements
 * across maps, naming the variations a batch creates, running the batch so
 * one failure cannot stop the rest, and reporting a partial failure honestly.
 */

function candidate(siteId: string, rank: number): ScenarioTransferCandidateDto {
  return { siteId, rank, score: 1, verdict: "exact", summary: "", offRoadActors: 0, preview: null };
}

const maps: Array<{ mapVersionId: string; label: string; search: MapSearch }> = [
  { mapVersionId: "yale", label: "Yale Street", search: { status: "ready", candidates: [candidate("y1", 1), candidate("y2", 2), candidate("y3", 3)] } },
  { mapVersionId: "belmont", label: "Belmont", search: { status: "ready", candidates: [candidate("b1", 1)] } },
  { mapVersionId: "rfs", label: "Richmond", search: { status: "searching" } },
];

describe("selection", () => {
  it("toggles one placement without touching the rest", () => {
    const one = toggleSelection(new Set(), candidateKey("yale", "y1"));
    const two = toggleSelection(one, candidateKey("belmont", "b1"));
    expect([...two]).toEqual(["yale::y1", "belmont::b1"]);
    expect([...toggleSelection(two, "yale::y1")]).toEqual(["belmont::b1"]);
    // The input set is never mutated: React state stays comparable by identity.
    expect([...one]).toEqual(["yale::y1"]);
  });

  it("resolves selected keys to placements in display order, map by map", () => {
    const selection = new Set(["belmont::b1", "yale::y3", "yale::y1"]);
    const refs = selectedRefs(selection, maps);
    expect(refs.map((ref) => `${ref.mapVersionId}/${ref.candidate.siteId}`)).toEqual(["yale/y1", "yale/y3", "belmont/b1"]);
  });

  it("ignores keys whose map is not answered (or no longer offers the site)", () => {
    expect(selectedRefs(new Set(["rfs::r1", "yale::gone"]), maps)).toEqual([]);
  });
});

describe("variation titles", () => {
  const ref = (mapVersionId: string, mapLabel: string, siteId: string, rank: number): CandidateRef => ({
    mapVersionId,
    mapLabel,
    candidate: candidate(siteId, rank),
  });

  it("names each variation after the source and its new map, numbering only a map that gets several", () => {
    const titles = variationTitles("Unprotected left", [
      ref("yale", "Yale Street", "y3", 3),
      ref("yale", "Yale Street", "y1", 1),
      ref("belmont", "Belmont", "b1", 1),
    ]);
    expect(titles.get("yale::y1")).toBe("Unprotected left · Yale Street 1");
    expect(titles.get("yale::y3")).toBe("Unprotected left · Yale Street 2");
    expect(titles.get("belmont::b1")).toBe("Unprotected left · Belmont");
  });

  it("keeps every title within the 200-character limit the server enforces", () => {
    const title = variationTitles("x".repeat(400), [ref("yale", "Yale Street", "y1", 1)]).get("yale::y1")!;
    expect(title.length).toBeLessThanOrEqual(200);
    expect(title.endsWith(" · Yale Street")).toBe(true);
  });
});

describe("runBatch", () => {
  it("never runs more than the concurrency limit at once", async () => {
    let running = 0;
    let peak = 0;
    await runBatch([1, 2, 3, 4, 5], async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
    }, { concurrency: 2 });
    expect(peak).toBe(2);
  });

  it("settles every item when some fail, reporting each outcome in order", async () => {
    const settled: string[] = [];
    const results = await runBatch(["a", "b", "c", "d"], async (item) => {
      if (item === "b" || item === "d") throw new Error(`${item} refused`);
      return item.toUpperCase();
    }, {
      concurrency: 2,
      onSettled: (item, result) => settled.push(`${item}:${result.ok ? "ok" : "failed"}`),
    });
    expect(results.map((result) => (result.ok ? result.value : errorMessage(result.error, "?")))).toEqual([
      "A",
      "b refused",
      "C",
      "d refused",
    ]);
    expect(settled.sort()).toEqual(["a:ok", "b:failed", "c:ok", "d:failed"]);
  });

  it("stops starting new items once cancelled, letting running ones finish", async () => {
    let cancelled = false;
    const started: number[] = [];
    await runBatch([1, 2, 3, 4], async (item) => {
      started.push(item);
      if (item === 1) cancelled = true;
    }, { concurrency: 1, isCancelled: () => cancelled });
    expect(started).toEqual([1]);
  });
});

describe("batch reporting", () => {
  const jobs = new Map<string, CreateJob>([
    ["yale::y1", { status: "created", documentId: "d1", datasetId: "ds", title: "A" }],
    ["yale::y2", { status: "failed", message: "That placement is no longer offered on Yale Street." }],
    ["belmont::b1", { status: "created", documentId: "d2", datasetId: "ds", title: "B" }],
  ]);

  it("counts created, failed and running jobs", () => {
    expect(batchSummary(jobs)).toEqual({ total: 3, created: 2, failed: 1, running: 0 });
  });

  it("says a partial failure plainly", () => {
    expect(statusLine({ phase: "done", selected: 0, searching: 0, summary: batchSummary(jobs) })).toBe(
      "2 variations created · 1 failed",
    );
    expect(
      statusLine({
        phase: "done",
        selected: 0,
        searching: 0,
        summary: { total: 1, created: 1, failed: 0, running: 0 },
      }),
    ).toBe("1 variation created");
  });

  it("counts creation progress from the settled jobs", () => {
    expect(
      statusLine({ phase: "creating", selected: 3, searching: 0, summary: { total: 3, created: 1, failed: 0, running: 2 } }),
    ).toBe("Creating 2 of 3");
  });

  it("reports the selection, then any maps still searching", () => {
    const empty = { total: 0, created: 0, failed: 0, running: 0 };
    expect(statusLine({ phase: "choosing", selected: 2, searching: 3, summary: empty })).toBe("2 selected");
    expect(statusLine({ phase: "choosing", selected: 0, searching: 1, summary: empty })).toBe("Searching 1 map");
    expect(statusLine({ phase: "choosing", selected: 0, searching: 0, summary: empty })).toBe("Select placements");
  });

  it("offers exactly the failed placements for a retry", () => {
    expect([...failedKeys(jobs)]).toEqual(["yale::y2"]);
  });
});

describe("scenarioFailure", () => {
  it("names a failure that belongs to the scenario as soon as one map reports it", () => {
    const failure: MapSearch = { status: "failed", scope: "scenario", message: "actor_catalog_class_mismatch: unknown catalog id" };
    expect(scenarioFailure([{ status: "searching" }, failure, { status: "queued" }])).toBe(failure.message);
  });

  it("leaves a failure of one map to that map", () => {
    const mapOnly: MapSearch = { status: "failed", scope: "map", message: "This map's data is not fully published yet." };
    expect(scenarioFailure([mapOnly, mapOnly])).toBeNull();
    expect(scenarioFailure([{ status: "ready", candidates: [] }])).toBeNull();
    expect(scenarioFailure([])).toBeNull();
  });
});
