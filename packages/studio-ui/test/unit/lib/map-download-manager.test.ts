import { describe, expect, it, vi } from "vitest";
import {
  assessMapDownloadCapacity,
  MAP_DOWNLOAD_JOB_STORAGE_KEY,
  MapDownloadManager,
  type MapDownloadDeps,
} from "../../../src/lib/maps/frontend/map-download-manager";
import type { MapDownloadPlan, PlannedDownloadAsset } from "../../../src/lib/maps/frontend/map-download-plan";

const sha = (n: number) => n.toString(16).padStart(64, "0");

function asset(n: number, bytes: number, cell: string | null, mapVersionId = "a"): PlannedDownloadAsset {
  return { url: `/api/simforge/maps/${mapVersionId}/browser-assets/f${n}`, relativePath: `f${n}`, sha256: sha(n), bytes, kind: cell ? "tile" : "core", cell };
}

function plan(mapVersionId: string, assets: PlannedDownloadAsset[]): MapDownloadPlan {
  const cells = [...new Set(assets.flatMap((entry) => (entry.cell ? [entry.cell] : [])))].map((id) => {
    const [x, z] = id.split(",").map(Number);
    return { id, gridX: x!, gridZ: z!, bytes: 0, triangles: 1, hasVegetation: false };
  });
  return {
    mapVersionId, closureSha256: "c".repeat(64), preference: "low-no-foliage", variantId: "textures-256-uastc", variantNote: null,
    foliage: false, profileKey: `k-${mapVersionId}`, assets, totalBytes: assets.reduce((total, entry) => total + entry.bytes, 0),
    columns: 2, rows: 1, cells,
  };
}

function memoryStorage() {
  const backing = new Map<string, string>();
  return {
    backing,
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => void backing.set(key, value),
    removeItem: (key: string) => void backing.delete(key),
  };
}

/** A transfer that completes only when the test says so. */
function gatedEnsure() {
  const waiting: Array<{ asset: PlannedDownloadAsset; resolve: () => void; reject: (error: unknown) => void }> = [];
  const resident = new Set<string>();
  const ensure = vi.fn((entry: PlannedDownloadAsset, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    const item = { asset: entry, resolve: () => { resident.add(entry.sha256); resolve(); }, reject };
    waiting.push(item);
    signal.addEventListener("abort", () => {
      waiting.splice(waiting.indexOf(item), 1);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  }));
  return {
    ensure,
    resident,
    waiting,
    /** Complete `count` transfers, including ones the job asks for while earlier ones finish. */
    async release(count = Infinity) {
      let released = 0;
      while (released < count && waiting.length > 0) {
        waiting.shift()!.resolve();
        released += 1;
        await flush();
      }
      await flush();
    },
  };
}

async function flush() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

function manager(overrides: Partial<MapDownloadDeps> & { plans?: Record<string, MapDownloadPlan | string> } = {}) {
  const gate = gatedEnsure();
  const storage = memoryStorage();
  const plans = overrides.plans ?? {
    a: plan("a", [asset(1, 10, null), asset(2, 20, "0,0"), asset(3, 30, "1,0")]),
  };
  const deps: MapDownloadDeps = {
    plan: vi.fn(async (ids: readonly string[]) => ids.map((id) => {
      const entry = plans[id];
      return typeof entry === "string" || !entry
        ? { mapVersionId: id, ok: false as const, reason: typeof entry === "string" ? entry : "missing" }
        : { mapVersionId: id, ok: true as const, plan: entry };
    })),
    ensure: gate.ensure,
    isResident: (entry) => gate.resident.has(entry.sha256),
    capacity: async () => ({ ceilingBytes: 1_000_000, originFreeBytes: 1_000_000 }),
    storage,
    concurrency: 1,
    now: () => 0,
    // Store notifications publish at once; the throughput sampler never ticks.
    schedule: (callback, ms) => { if (ms < 200) callback(); return null; },
    cancelSchedule: () => undefined,
    ...overrides,
  };
  return { downloads: new MapDownloadManager(deps), gate, storage, deps };
}

describe("map download job", () => {
  it("downloads every missing file, lights each lot as it completes, and finishes", async () => {
    const { downloads, gate } = manager();
    const run = downloads.start({ preference: "low-no-foliage", maps: [{ mapVersionId: "a", label: "A" }] });
    await flush();
    expect(downloads.getSnapshot().status).toBe("downloading");
    await gate.release(2);
    const middle = downloads.getSnapshot();
    expect(middle.doneBytes).toBe(30);
    expect(middle.maps[0]!.litCells).toEqual(["0,0"]);
    await gate.release();
    await run;
    const done = downloads.getSnapshot();
    expect(done.status).toBe("complete");
    expect(done.doneBytes).toBe(60);
    expect(done.maps[0]!.state).toBe("done");
    expect([...done.maps[0]!.litCells].sort()).toEqual(["0,0", "1,0"]);
  });

  it("pauses without losing finished files and resumes only what is missing", async () => {
    const { downloads, gate, storage } = manager();
    void downloads.start({ preference: "low-no-foliage", maps: [{ mapVersionId: "a", label: "A" }] });
    await flush();
    await gate.release(1);
    downloads.pause();
    await flush();
    expect(downloads.getSnapshot().status).toBe("paused");
    expect(JSON.parse(storage.getItem(MAP_DOWNLOAD_JOB_STORAGE_KEY)!).status).toBe("paused");
    const transfersBefore = gate.ensure.mock.calls.length;

    const resumed = downloads.resume();
    await flush();
    expect(downloads.getSnapshot().status).toBe("downloading");
    // The file finished before the pause is not asked for again.
    const resumedUrls = gate.ensure.mock.calls.slice(transfersBefore).map(([entry]) => entry.relativePath);
    expect(resumedUrls).not.toContain("f1");
    await gate.release();
    await resumed;
    expect(downloads.getSnapshot().status).toBe("complete");
    expect(storage.getItem(MAP_DOWNLOAD_JOB_STORAGE_KEY)).toBeNull();
  });

  it("cancels: stops transferring, forgets the job, keeps what finished", async () => {
    const { downloads, gate, storage } = manager();
    void downloads.start({ preference: "low-no-foliage", maps: [{ mapVersionId: "a", label: "A" }] });
    await flush();
    await gate.release(1);
    downloads.cancel();
    await flush();
    const snapshot = downloads.getSnapshot();
    expect(snapshot.status).toBe("cancelled");
    expect(snapshot.doneBytes).toBe(10);
    expect(storage.getItem(MAP_DOWNLOAD_JOB_STORAGE_KEY)).toBeNull();
    const calls = gate.ensure.mock.calls.length;
    await gate.release();
    expect(gate.ensure.mock.calls.length).toBe(calls);
    expect(gate.resident.has(sha(1))).toBe(true);
    downloads.dismiss();
    expect(downloads.getSnapshot().status).toBe("idle");
  });

  it("refuses a selection larger than the ceiling before transferring anything", async () => {
    const { downloads, gate } = manager({ capacity: async () => ({ ceilingBytes: 50, originFreeBytes: null }) });
    await downloads.start({ preference: "low-no-foliage", maps: [{ mapVersionId: "a", label: "A" }] });
    const snapshot = downloads.getSnapshot();
    expect(snapshot.status).toBe("failed");
    expect(snapshot.error).toMatch(/ceiling/);
    expect(gate.ensure).not.toHaveBeenCalled();
  });

  it("reports a map it cannot plan by name instead of dropping it", async () => {
    const { downloads, gate } = manager({
      plans: { a: plan("a", [asset(1, 10, null)]), b: "This map has no verified browser assets to download." },
    });
    const run = downloads.start({ preference: "low-no-foliage", maps: [{ mapVersionId: "a", label: "A" }, { mapVersionId: "b", label: "Bravo" }] });
    await flush();
    await gate.release();
    await run;
    const snapshot = downloads.getSnapshot();
    expect(snapshot.status).toBe("failed");
    expect(snapshot.maps.find((map) => map.mapVersionId === "a")!.state).toBe("done");
    expect(snapshot.maps.find((map) => map.mapVersionId === "b")!.state).toBe("failed");
    expect(snapshot.error).toContain("Bravo");
  });

  it("marks a map failed when one of its files fails, and finishes the others", async () => {
    const plans = { a: plan("a", [asset(1, 10, null)]), b: plan("b", [asset(2, 20, null, "b")]) };
    const ensure = vi.fn(async (entry: PlannedDownloadAsset) => {
      if (entry.relativePath === "f2") throw new Error("503 from the object store");
    });
    const { downloads } = manager({ plans, ensure });
    await downloads.start({ preference: "low-no-foliage", maps: [{ mapVersionId: "a", label: "A" }, { mapVersionId: "b", label: "B" }] });
    const snapshot = downloads.getSnapshot();
    expect(snapshot.status).toBe("failed");
    expect(snapshot.maps.find((map) => map.mapVersionId === "a")!.state).toBe("done");
    expect(snapshot.maps.find((map) => map.mapVersionId === "b")!.failure).toMatch(/503/);
  });

  it("transfers content two maps share once", async () => {
    const shared = asset(9, 100, null);
    const plans = { a: plan("a", [shared]), b: plan("b", [{ ...shared, url: "/api/simforge/maps/b/browser-assets/f9" }]) };
    const ensure = vi.fn(async () => undefined);
    const isResident = vi.fn(() => false);
    const { downloads } = manager({ plans, ensure, isResident });
    await downloads.start({ preference: "low-no-foliage", maps: [{ mapVersionId: "a", label: "A" }, { mapVersionId: "b", label: "B" }] });
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(downloads.getSnapshot().status).toBe("complete");
    expect(downloads.getSnapshot().doneBytes).toBe(200);
  });

  it("resumes a running job after a reload, and restores a paused one paused", async () => {
    const running = manager();
    running.storage.setItem(MAP_DOWNLOAD_JOB_STORAGE_KEY, JSON.stringify({ preference: "low", maps: [{ mapVersionId: "a", label: "A" }], status: "running" }));
    await expect(running.downloads.restore()).resolves.toBe(true);
    await flush();
    expect(running.downloads.getSnapshot().status).toBe("downloading");
    expect(running.downloads.getSnapshot().preference).toBe("low");

    const paused = manager();
    paused.storage.setItem(MAP_DOWNLOAD_JOB_STORAGE_KEY, JSON.stringify({ preference: "low-no-foliage", maps: [{ mapVersionId: "a", label: "A" }], status: "paused" }));
    await expect(paused.downloads.restore()).resolves.toBe(true);
    const snapshot = paused.downloads.getSnapshot();
    expect(snapshot.status).toBe("paused");
    expect(snapshot.totalBytes).toBe(60);
    expect(paused.gate.ensure).not.toHaveBeenCalled();

    const none = manager();
    await expect(none.downloads.restore()).resolves.toBe(false);
  });

  it("will not start a second job over a running one", async () => {
    const { downloads } = manager();
    void downloads.start({ preference: "low-no-foliage", maps: [{ mapVersionId: "a", label: "A" }] });
    await flush();
    expect(() => downloads.start({ preference: "low-no-foliage", maps: [{ mapVersionId: "a", label: "A" }] })).toThrow(/already running/);
  });
});

describe("capacity verdict", () => {
  const capacity = { ceilingBytes: 1_000, originFreeBytes: 5_000 };
  it("fits, and says how much older content makes room", () => {
    expect(assessMapDownloadCapacity({ selectionBytes: 600, missingBytes: 600, cachedBytes: 700, capacity })).toEqual({ fits: true, evictsBytes: 300 });
    expect(assessMapDownloadCapacity({ selectionBytes: 600, missingBytes: 100, cachedBytes: 100, capacity })).toEqual({ fits: true, evictsBytes: 0 });
  });
  it("refuses a selection over the ceiling or over the free quota, with the numbers", () => {
    const over = assessMapDownloadCapacity({ selectionBytes: 2_000_000_000, missingBytes: 1, cachedBytes: 0, capacity: { ceilingBytes: 1_000_000_000, originFreeBytes: null } });
    expect(over.fits).toBe(false);
    expect(!over.fits && over.reason).toMatch(/1\.9 GB.*954 MB/);
    const quota = assessMapDownloadCapacity({ selectionBytes: 900, missingBytes: 900, cachedBytes: 0, capacity: { ceilingBytes: 1_000, originFreeBytes: 100 } });
    expect(quota.fits).toBe(false);
  });
});
