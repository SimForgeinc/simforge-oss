/**
 * The one map download job a browser runs: which maps, at which render
 * setting, how far along, how fast, and the controls to pause, resume and
 * cancel it.
 *
 * It lives at module scope rather than in a component so it keeps running
 * when the panel that started it closes or the page navigates inside the app,
 * and it writes its intent to storage so a reload picks it up again. Resuming
 * costs nothing that is already done: the cache is content addressed, so a
 * resumed job re-plans, skips every resident asset and downloads the rest.
 *
 * Nothing here is silent. A map that cannot be planned or whose files fail is
 * reported by name and never counted as downloaded; a selection that does not
 * fit the cache ceiling is refused before a byte moves, because the least
 * recently used eviction would otherwise quietly throw away the job's own
 * earlier files.
 *
 * The side effects (planning, one asset's transfer, residency, capacity,
 * storage) are injected, so the scheduling, pause/cancel and progress rules
 * are unit-tested without a browser.
 */

import type { RenderingPreference } from "../../../components/rendering-preference";
import type { MapDownloadPlan, PlannedDownloadAsset } from "./map-download-plan";

export type MapDownloadJobStatus = "idle" | "planning" | "downloading" | "paused" | "complete" | "failed" | "cancelled";

export type MapDownloadMapState = "planning" | "queued" | "downloading" | "done" | "failed";

export type MapDownloadMapProgress = {
  mapVersionId: string;
  label: string;
  state: MapDownloadMapState;
  totalBytes: number;
  doneBytes: number;
  /** Grid cells whose models and textures are all resident. */
  litCells: readonly string[];
  /** The cell whose files are transferring right now, for the "being built" highlight. */
  activeCell: string | null;
  failure: string | null;
  plan: MapDownloadPlan | null;
};

export type MapDownloadSnapshot = {
  status: MapDownloadJobStatus;
  preference: RenderingPreference | null;
  maps: readonly MapDownloadMapProgress[];
  totalBytes: number;
  doneBytes: number;
  /** Smoothed transfer rate; 0 when nothing is moving. */
  bytesPerSecond: number;
  /** Null while the rate is unknown. */
  etaSeconds: number | null;
  /** Recent throughput samples (bytes/s), oldest first, for the sparkline. */
  samples: readonly number[];
  startedAt: number | null;
  finishedAt: number | null;
  /** Why the job stopped or refused, in words a person can act on. */
  error: string | null;
};

export type MapDownloadRequest = {
  preference: RenderingPreference;
  maps: ReadonlyArray<{ mapVersionId: string; label: string }>;
  /** Plans the caller already has; missing ones are planned here. */
  plans?: ReadonlyMap<string, MapDownloadPlan>;
};

export type MapDownloadCapacity = {
  /** The enforced ceiling on map bytes. */
  ceilingBytes: number;
  /** Free origin quota, null when the browser will not say. */
  originFreeBytes: number | null;
};

export type MapDownloadDeps = {
  plan: (mapVersionIds: readonly string[], preference: RenderingPreference, signal: AbortSignal)
    => Promise<Array<{ mapVersionId: string; ok: true; plan: MapDownloadPlan } | { mapVersionId: string; ok: false; reason: string }>>;
  /**
   * Make one asset resident; throws on failure. Retries and deadlines are the
   * implementation's. `networkUrl` is a signed delivery URL when
   * {@link MapDownloadDeps.resolveUrls} issued one.
   */
  ensure: (asset: PlannedDownloadAsset, signal: AbortSignal, networkUrl?: string) => Promise<void>;
  /** Issue signed delivery URLs for a batch of assets (canonical URL → signed URL). */
  resolveUrls?: (assets: readonly PlannedDownloadAsset[], signal: AbortSignal) => Promise<ReadonlyMap<string, string>>;
  isResident: (asset: PlannedDownloadAsset) => boolean | Promise<boolean>;
  capacity: () => Promise<MapDownloadCapacity>;
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  concurrency: number;
  now?: () => number;
  /** Defaults to `setTimeout`; tests pass a synchronous scheduler. */
  schedule?: (callback: () => void, ms: number) => unknown;
  cancelSchedule?: (handle: unknown) => void;
};

export const MAP_DOWNLOAD_JOB_STORAGE_KEY = "simforge.map-downloads.job.v1";

type StoredJob = {
  preference: RenderingPreference;
  maps: Array<{ mapVersionId: string; label: string }>;
  status: "running" | "paused";
};

const SAMPLE_INTERVAL_MS = 500;
const MAX_SAMPLES = 48;
/** Weight of the newest sample in the smoothed rate. */
const RATE_SMOOTHING = 0.25;
const NOTIFY_INTERVAL_MS = 120;
/** Signed delivery URLs are issued per this many queued assets, just ahead of use. */
const URL_BATCH = 256;

export class MapDownloadCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MapDownloadCapacityError";
  }
}

export function formatDownloadBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(0, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * Whether a selection fits, and what it would cost. `selectionBytes` is the
 * full size of every selected map at the profile; `missingBytes` is what is
 * not resident yet. Exported so the panel shows the same verdict the job
 * enforces.
 */
export function assessMapDownloadCapacity(input: {
  selectionBytes: number;
  missingBytes: number;
  /** Map bytes in the cache right now. */
  cachedBytes: number;
  capacity: MapDownloadCapacity;
}): { fits: true; evictsBytes: number } | { fits: false; reason: string } {
  const { selectionBytes, missingBytes, cachedBytes, capacity } = input;
  if (selectionBytes > capacity.ceilingBytes) {
    return {
      fits: false,
      reason: `The selected maps need ${formatDownloadBytes(selectionBytes)}, but the map cache ceiling is ${formatDownloadBytes(capacity.ceilingBytes)}. `
        + "Downloading them would evict the job's own files. Raise the cache size or select fewer maps.",
    };
  }
  if (capacity.originFreeBytes !== null && missingBytes > capacity.originFreeBytes) {
    return {
      fits: false,
      reason: `The selected maps still need ${formatDownloadBytes(missingBytes)}, but this browser has only ${formatDownloadBytes(capacity.originFreeBytes)} of storage left for this site.`,
    };
  }
  // The selection fits under the ceiling; older, unselected map files may
  // have to make room, least recently used first.
  const evictsBytes = Math.max(0, cachedBytes + missingBytes - capacity.ceilingBytes);
  return { fits: true, evictsBytes };
}

const IDLE: MapDownloadSnapshot = Object.freeze({
  status: "idle",
  preference: null,
  maps: [],
  totalBytes: 0,
  doneBytes: 0,
  bytesPerSecond: 0,
  etaSeconds: null,
  samples: [],
  startedAt: null,
  finishedAt: null,
  error: null,
}) as MapDownloadSnapshot;

type LiveMap = {
  mapVersionId: string;
  label: string;
  state: MapDownloadMapState;
  plan: MapDownloadPlan | null;
  totalBytes: number;
  doneBytes: number;
  lit: Set<string>;
  /** Missing asset count per cell; a cell lights when it reaches zero. */
  cellPending: Map<string, number>;
  pending: number;
  activeCell: string | null;
  failure: string | null;
};

export class MapDownloadManager {
  readonly #deps: MapDownloadDeps;
  readonly #listeners = new Set<() => void>();
  #snapshot: MapDownloadSnapshot = IDLE;
  #maps: LiveMap[] = [];
  #status: MapDownloadJobStatus = "idle";
  #preference: RenderingPreference | null = null;
  #error: string | null = null;
  #controller: AbortController | null = null;
  #run: Promise<void> | null = null;
  #startedAt: number | null = null;
  #finishedAt: number | null = null;
  #rate = 0;
  #samples: number[] = [];
  #lastSampleBytes = 0;
  #sampler: unknown = null;
  #notifyHandle: unknown = null;
  #request: MapDownloadRequest | null = null;

  constructor(deps: MapDownloadDeps) {
    this.#deps = deps;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  };

  getSnapshot = (): MapDownloadSnapshot => this.#snapshot;

  /** Whether a job is holding the network (planning or transferring). */
  get active(): boolean {
    return this.#status === "planning" || this.#status === "downloading";
  }

  /**
   * Start (or replace a finished) job. Refuses while one is running: the
   * person pauses or cancels it first, so two selections never race.
   */
  start(request: MapDownloadRequest): Promise<void> {
    if (this.active) throw new Error("A map download is already running. Pause or cancel it first.");
    this.#request = request;
    this.#preference = request.preference;
    this.#error = null;
    this.#finishedAt = null;
    this.#startedAt = this.#now();
    this.#maps = request.maps.map((map) => ({
      mapVersionId: map.mapVersionId,
      label: map.label,
      state: "planning",
      plan: request.plans?.get(map.mapVersionId) ?? null,
      totalBytes: request.plans?.get(map.mapVersionId)?.totalBytes ?? 0,
      doneBytes: 0,
      lit: new Set(),
      cellPending: new Map(),
      pending: 0,
      activeCell: null,
      failure: null,
    }));
    this.#persist("running");
    this.#run = this.#execute();
    return this.#run;
  }

  /** Stop transferring and keep the job; everything finished stays resident. */
  pause(): void {
    if (!this.active) return;
    this.#status = "paused";
    this.#persist("paused");
    this.#controller?.abort(new DOMException("Paused", "AbortError"));
    this.#stopSampler();
    this.#notify(true);
  }

  /** Continue a paused job. Resident files are skipped, so nothing downloads twice. */
  resume(): Promise<void> {
    if (this.#status !== "paused" || !this.#request) return Promise.resolve();
    const request = this.#request;
    return this.start({
      ...request,
      plans: new Map(this.#maps.flatMap((map) => (map.plan ? [[map.mapVersionId, map.plan] as const] : []))),
    });
  }

  /**
   * Stop and forget the job. Files that finished stay in the cache (they are
   * valid, verified content and will be used); the job itself is gone.
   */
  cancel(): void {
    const wasRunning = this.active || this.#status === "paused";
    if (!wasRunning) return;
    this.#status = "cancelled";
    this.#controller?.abort(new DOMException("Cancelled", "AbortError"));
    this.#forgetStored();
    this.#stopSampler();
    this.#finishedAt = this.#now();
    this.#notify(true);
  }

  /** Clear a finished, failed or cancelled job from view. */
  dismiss(): void {
    if (this.active || this.#status === "paused") return;
    this.#status = "idle";
    this.#maps = [];
    this.#request = null;
    this.#error = null;
    this.#samples = [];
    this.#rate = 0;
    this.#notify(true);
  }

  /**
   * Pick up the job a previous page left: a running one resumes, a paused
   * one comes back paused (planned, so its progress is known). Returns
   * whether there was one.
   */
  async restore(): Promise<boolean> {
    if (this.#status !== "idle") return false;
    const stored = this.#readStored();
    if (!stored) return false;
    if (stored.status === "running") {
      // Errors land in the snapshot; the caller does not wait for the transfer.
      void this.start({ preference: stored.preference, maps: stored.maps });
      return true;
    }
    this.#request = { preference: stored.preference, maps: stored.maps };
    this.#preference = stored.preference;
    this.#maps = stored.maps.map((map) => ({
      mapVersionId: map.mapVersionId, label: map.label, state: "planning", plan: null, totalBytes: 0, doneBytes: 0,
      lit: new Set(), cellPending: new Map(), pending: 0, activeCell: null, failure: null,
    }));
    this.#status = "paused";
    this.#notify(true);
    const controller = new AbortController();
    try {
      await this.#planAndMeasure(controller.signal);
    } catch (error) {
      this.#error = describe(error);
    }
    for (const map of this.#maps) if (map.state !== "failed" && map.state !== "done") map.state = "queued";
    this.#notify(true);
    return true;
  }

  async #execute(): Promise<void> {
    const controller = new AbortController();
    this.#controller = controller;
    const { signal } = controller;
    this.#status = "planning";
    this.#notify(true);
    try {
      const queue = await this.#planAndMeasure(signal);
      if (signal.aborted) return;
      const missingBytes = queue.reduce((total, entry) => total + entry.asset.bytes, 0);
      const selectionBytes = this.#maps.reduce((total, map) => total + map.totalBytes, 0);
      const capacity = await this.#deps.capacity();
      const verdict = assessMapDownloadCapacity({ selectionBytes, missingBytes, cachedBytes: 0, capacity });
      if (!verdict.fits) throw new MapDownloadCapacityError(verdict.reason);

      this.#status = "downloading";
      this.#lastSampleBytes = this.#doneBytes();
      this.#startSampler();
      this.#notify(true);
      let cursor = 0;
      const batches = new Map<number, Promise<ReadonlyMap<string, string>>>();
      const signedUrl = async (index: number, url: string): Promise<string | undefined> => {
        if (!this.#deps.resolveUrls) return undefined;
        const batch = Math.floor(index / URL_BATCH);
        let pending = batches.get(batch);
        if (!pending) {
          const slice = queue.slice(batch * URL_BATCH, (batch + 1) * URL_BATCH).map((entry) => entry.asset);
          // An issuing failure is not the asset failing: the canonical route
          // authorizes and redirects on its own.
          pending = this.#deps.resolveUrls(slice, signal).catch(() => new Map<string, string>());
          batches.set(batch, pending);
        }
        return (await pending).get(url);
      };
      const worker = async () => {
        while (cursor < queue.length && !signal.aborted) {
          const index = cursor++;
          const entry = queue[index]!;
          const owners = entry.owners.filter((owner) => owner.map.state !== "failed");
          if (owners.length === 0) continue;
          for (const owner of owners) {
            owner.map.state = "downloading";
            if (owner.cell) owner.map.activeCell = owner.cell;
          }
          try {
            await this.#deps.ensure(entry.asset, signal, await signedUrl(index, entry.asset.url));
          } catch (error) {
            if (signal.aborted) return;
            for (const owner of owners) {
              owner.map.state = "failed";
              owner.map.failure = `${entry.asset.relativePath}: ${describe(error)}`;
            }
            this.#notify();
            continue;
          }
          for (const owner of owners) {
            // The same bytes under another path: teach that path its identity.
            if (owner.asset.url !== entry.asset.url) await this.#deps.isResident(owner.asset);
            this.#complete(owner.map, owner.cell, owner.asset.bytes);
          }
          this.#notify();
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, Math.min(this.#deps.concurrency, queue.length)) }, worker));
      if (signal.aborted) return;
      for (const map of this.#maps) {
        if (map.state !== "failed" && map.pending === 0) map.state = "done";
        map.activeCell = null;
      }
      const failed = this.#maps.filter((map) => map.state === "failed");
      this.#status = failed.length > 0 ? "failed" : "complete";
      this.#error = failed.length > 0
        ? `${failed.length === 1 ? `${failed[0]!.label} was` : `${failed.length} maps were`} not fully downloaded: ${failed.map((map) => `${map.label} (${map.failure})`).join("; ")}`
        : null;
      this.#finishedAt = this.#now();
      this.#forgetStored();
    } catch (error) {
      if (signal.aborted) return;
      this.#status = "failed";
      this.#error = describe(error);
      this.#finishedAt = this.#now();
      this.#forgetStored();
    } finally {
      this.#stopSampler();
      if (this.#controller === controller) this.#controller = null;
      this.#notify(true);
    }
  }

  /** Plan missing maps, measure residency, and return the de-duplicated transfer queue. */
  async #planAndMeasure(signal: AbortSignal): Promise<Array<{ asset: PlannedDownloadAsset; owners: Array<{ map: LiveMap; cell: string | null; asset: PlannedDownloadAsset }> }>> {
    const unplanned = this.#maps.filter((map) => !map.plan).map((map) => map.mapVersionId);
    if (unplanned.length > 0) {
      const outcomes = await this.#deps.plan(unplanned, this.#preference!, signal);
      for (const outcome of outcomes) {
        const map = this.#maps.find((candidate) => candidate.mapVersionId === outcome.mapVersionId);
        if (!map) continue;
        if (outcome.ok) {
          map.plan = outcome.plan;
          map.totalBytes = outcome.plan.totalBytes;
        } else {
          map.state = "failed";
          map.failure = outcome.reason;
        }
      }
    }
    const queue: Array<{ asset: PlannedDownloadAsset; owners: Array<{ map: LiveMap; cell: string | null; asset: PlannedDownloadAsset }> }> = [];
    const bySha = new Map<string, (typeof queue)[number]>();
    // Smallest remaining first: the first finished map arrives soonest.
    const measured: Array<{ map: LiveMap; missing: PlannedDownloadAsset[] }> = [];
    for (const map of this.#maps) {
      if (!map.plan || map.state === "failed") continue;
      map.doneBytes = 0;
      map.lit = new Set();
      map.cellPending = new Map();
      map.pending = 0;
      const missing: PlannedDownloadAsset[] = [];
      for (const asset of map.plan.assets) {
        if (await this.#deps.isResident(asset)) {
          map.doneBytes += asset.bytes;
          continue;
        }
        missing.push(asset);
        map.pending += 1;
        if (asset.cell) map.cellPending.set(asset.cell, (map.cellPending.get(asset.cell) ?? 0) + 1);
      }
      const drawn = new Set([...map.plan.cells.map((cell) => cell.id), ...map.plan.assets.flatMap((asset) => (asset.cell ? [asset.cell] : []))]);
      for (const cell of drawn) if (!map.cellPending.has(cell)) map.lit.add(cell);
      map.state = map.pending === 0 ? "done" : "queued";
      measured.push({ map, missing });
    }
    measured.sort((a, b) => (a.map.totalBytes - a.map.doneBytes) - (b.map.totalBytes - b.map.doneBytes));
    for (const { map, missing } of measured) {
      for (const asset of missing) {
        const shared = bySha.get(asset.sha256);
        if (shared) {
          shared.owners.push({ map, cell: asset.cell, asset });
          continue;
        }
        const entry = { asset, owners: [{ map, cell: asset.cell, asset }] };
        bySha.set(asset.sha256, entry);
        queue.push(entry);
      }
    }
    this.#notify(true);
    return queue;
  }

  #complete(map: LiveMap, cell: string | null, bytes: number): void {
    map.doneBytes += bytes;
    map.pending -= 1;
    if (cell) {
      const left = (map.cellPending.get(cell) ?? 1) - 1;
      map.cellPending.set(cell, left);
      if (left <= 0) map.lit.add(cell);
    }
    if (map.pending <= 0) {
      map.state = "done";
      map.activeCell = null;
    }
  }

  #doneBytes(): number {
    return this.#maps.reduce((total, map) => total + map.doneBytes, 0);
  }

  #startSampler(): void {
    this.#stopSampler();
    const schedule = this.#deps.schedule ?? ((callback, ms) => setTimeout(callback, ms));
    const tick = () => {
      const done = this.#doneBytes();
      const rate = Math.max(0, (done - this.#lastSampleBytes) / (SAMPLE_INTERVAL_MS / 1000));
      this.#lastSampleBytes = done;
      this.#rate = this.#samples.length === 0 ? rate : this.#rate + RATE_SMOOTHING * (rate - this.#rate);
      this.#samples = [...this.#samples, rate].slice(-MAX_SAMPLES);
      this.#notify();
      if (this.#status === "downloading") this.#sampler = schedule(tick, SAMPLE_INTERVAL_MS);
    };
    this.#sampler = schedule(tick, SAMPLE_INTERVAL_MS);
  }

  #stopSampler(): void {
    if (this.#sampler !== null) (this.#deps.cancelSchedule ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)))(this.#sampler);
    this.#sampler = null;
    if (this.#status !== "downloading") this.#rate = 0;
  }

  #notify(immediate = false): void {
    if (immediate) {
      if (this.#notifyHandle !== null) (this.#deps.cancelSchedule ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)))(this.#notifyHandle);
      this.#notifyHandle = null;
      this.#publish();
      return;
    }
    if (this.#notifyHandle !== null) return;
    const schedule = this.#deps.schedule ?? ((callback, ms) => setTimeout(callback, ms));
    this.#notifyHandle = schedule(() => {
      this.#notifyHandle = null;
      this.#publish();
    }, NOTIFY_INTERVAL_MS);
  }

  #publish(): void {
    const totalBytes = this.#maps.reduce((total, map) => total + map.totalBytes, 0);
    const doneBytes = this.#doneBytes();
    const rate = this.#status === "downloading" ? this.#rate : 0;
    this.#snapshot = {
      status: this.#status,
      preference: this.#preference,
      maps: this.#maps.map((map) => ({
        mapVersionId: map.mapVersionId,
        label: map.label,
        state: map.state,
        totalBytes: map.totalBytes,
        doneBytes: map.doneBytes,
        litCells: [...map.lit],
        activeCell: map.state === "downloading" ? map.activeCell : null,
        failure: map.failure,
        plan: map.plan,
      })),
      totalBytes,
      doneBytes,
      bytesPerSecond: rate,
      etaSeconds: rate > 0 ? Math.max(0, (totalBytes - doneBytes) / rate) : null,
      samples: this.#samples,
      startedAt: this.#startedAt,
      finishedAt: this.#finishedAt,
      error: this.#error,
    };
    for (const listener of this.#listeners) listener();
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now();
  }

  #persist(status: StoredJob["status"]): void {
    if (!this.#request) return;
    const job: StoredJob = {
      preference: this.#request.preference,
      maps: this.#request.maps.map((map) => ({ mapVersionId: map.mapVersionId, label: map.label })),
      status,
    };
    try {
      this.#deps.storage?.setItem(MAP_DOWNLOAD_JOB_STORAGE_KEY, JSON.stringify(job));
    } catch {
      // Without storage the job still runs; it just does not survive a reload.
    }
  }

  #forgetStored(): void {
    try {
      this.#deps.storage?.removeItem(MAP_DOWNLOAD_JOB_STORAGE_KEY);
    } catch {
      // Nothing to forget.
    }
  }

  #readStored(): StoredJob | null {
    try {
      const parsed = JSON.parse(this.#deps.storage?.getItem(MAP_DOWNLOAD_JOB_STORAGE_KEY) ?? "null") as Partial<StoredJob> | null;
      if (!parsed || (parsed.status !== "running" && parsed.status !== "paused")) return null;
      if (parsed.preference !== "low-no-foliage" && parsed.preference !== "low" && parsed.preference !== "medium") return null;
      if (!Array.isArray(parsed.maps) || parsed.maps.length === 0) return null;
      const maps = parsed.maps.filter((map): map is { mapVersionId: string; label: string } =>
        typeof map?.mapVersionId === "string" && typeof map.label === "string");
      return maps.length > 0 ? { preference: parsed.preference, maps, status: parsed.status } : null;
    } catch {
      return null;
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
