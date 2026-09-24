import { Box3, Group, Vector3 } from 'three';
import type { Camera, Object3D, Texture, WebGLRenderer, Scene } from 'three';
import type { ManifestLod } from './types';
import type { AssetResources } from './gltf';
import { assertMaterialsLinked, disposeResources, uploadTexture } from './gltf';
import { estimateLodBytes } from './manifest';

export class RequiredAssetBudgetError extends Error {
  constructor(readonly layerName: string, readonly assetId: string, readonly layer: TileStreamLayer, readonly generation: number, readonly estimatedBytes?: number) {
    super(`[${layerName}] required coarse asset ${assetId} cannot fit the memory budget`);
    this.name = 'RequiredAssetBudgetError';
  }
}

export interface StreamTileDef {
  id: string;
  box: Box3;
  /** LODs sorted coarse-first: index 0 is the cheapest fallback. */
  lods: ManifestLod[];
  /** Anything the asset builder needs (instance data, grid coords, ...). */
  userData?: unknown;
}

export interface PreparedAsset {
  object: Object3D;
  resources: AssetResources;
  bytes: number;
  /** Textures still to be pushed to the GPU, drained by the upload pacer. */
  pendingTextures: Texture[];
  /** Called on eviction, after the object leaves the scene graph. */
  dispose?: () => void;
}

export type AssetBuilder = (
  def: StreamTileDef,
  lod: ManifestLod,
  signal: AbortSignal,
) => Promise<PreparedAsset>;

interface Entry {
  def: StreamTileDef;
  resident: Map<number, PreparedAsset>;
  displayed: number;
  /** The layer's `want` predicate accepted this tile on the last update. */
  wanted: boolean;
  /** Within the subset readiness is judged on (what the camera can see). */
  required: boolean;
  /** Wanted LOD index, or -1 when the tile should not be resident at all. */
  desired: number;
  loading: { index: number; controller: AbortController } | null;
  /** Decoded/uploading/compiling LOD. Prevents duplicate fetches before swap-in. */
  preparing: number | null;
  /** The current desired LOD cannot fit without evicting another desired LOD. */
  budgetBlocked: boolean;
  /**
   * Finest LOD index allowed after the budget evicted the level this tile had
   * on screen: it falls back to a coarser level instead of going blank.
   * Cleared when the view changes, like `budgetBlocked`.
   */
  evictedCap: number | null;
  failures: number;
  /** Pixels of error we would win by loading `desired`. */
  gain: number;
  distance: number;
}

export interface EvictionCandidate {
  layer: TileStreamLayer;
  entryId: string;
  index: number;
  bytes: number;
  score: number;
}

export interface LayerStats {
  residentTiles: number;
  residentAssets: number;
  bytes: number;
  pendingBytes: number;
  loading: number;
  queued: number;
  uploading: number;
  pendingTextureUploads: number;
  decodedAssets: number;
  uploadedTextures: number;
  compiledAssets: number;
  compiling: number;
  requiredPendingAssets: number;
  /** Tiles the camera wants resident at any LOD. */
  wantedTiles: number;
  /** Wanted tiles with no LOD resident at all: a visible hole in the layer. */
  missingTiles: number;
  /** In-view tiles displaying nothing: what a ready scene must never have. */
  missingInViewTiles: number;
  /** Wanted tiles whose desired LOD cannot be admitted under the byte budget. */
  budgetBlockedTiles: number;
  /** Wanted tiles that hit their terminal failure count and will not retry. */
  failedTiles: number;
  largestAdmissionUnderestimate: { assetId: string; estimatedBytes: number; decodedBytes: number } | null;
  lastAdmissionRefusal: { assetId: string; lodIndex: number; estimatedBytes: number; priority: number; pendingBytes: number } | null;
}

export interface MemoryGovernor {
  /**
   * True if `bytes` more may be brought in right now. `priority` is the
   * requester's eviction score (smaller = more valuable); the governor may only
   * evict assets that score worse than that, which is what stops a distant tile
   * from kicking out a near one and thrashing the pipe.
   */
  admit(bytes: number, priority: number): boolean;
  /** Largest single asset worth holding; coarser LODs are used above this. */
  maxAssetBytes(): number;
  /** Shared in-flight estimates may shrink after decoding or replacement. */
  pendingBytes?(): number;
}

export interface TileStreamLayerOptions {
  name: string;
  renderer: WebGLRenderer;
  scene: Scene;
  defs: StreamTileDef[];
  build: AssetBuilder;
  maxConcurrent: number;
  /** Shared byte ledger; keeps in-flight decodes from blowing past the budget. */
  memory: MemoryGovernor;
  /**
   * Load required tiles' coarsest LODs before finer detail. Keep those fallbacks
   * resident while required; optional prefetch remains evictable under pressure.
   */
  pinCoarsest: boolean;
  /** Infrastructure such as the single road/ground asset must load even when its conservative estimate exceeds the quality budget. */
  essentialCoarsest?: boolean;
  /** Every LOD is required (used by progressive road fidelity, not optional city detail). */
  essentialAll?: boolean;
  /** Return false to keep a tile unloaded entirely (vegetation range limit). */
  want?: (def: StreamTileDef, distance: number) => boolean;
  /**
   * Subset of `want` that readiness is judged on. A layer prefetches a margin
   * beyond what is on screen so continued streaming is invisible; readiness
   * must not wait for that margin, only for what the viewer can actually see.
   */
  required?: (def: StreamTileDef, distance: number) => boolean;
  /** Dynamic upper LOD bound for runtime fidelity modes. */
  maxDesiredIndex?: (def: StreamTileDef) => number;
  /**
   * Decoded-but-not-displayed assets allowed at once (fetching + upload queue +
   * compiling). Defaults to {@link MAX_UPLOAD_BACKLOG}; the viewer widens it
   * while the first view is assembling, when nothing interactive is on screen
   * to protect and a depth of 3 serialises the load.
   */
  maxBacklog?: () => number;
  /** Optional admission/eviction bias. Larger values are lower priority (vegetation uses this). */
  priorityBias?: number;
  onDisplay?: (def: StreamTileDef, asset: PreparedAsset, index: number) => void;
  /** Called every frame for the displayed asset (vegetation density LOD). */
  onTick?: (def: StreamTileDef, asset: PreparedAsset, distance: number, index: number) => void;
  /** Terminal preparation failures; never publish a failed asset as ready. */
  onError?: (error: Error) => void;
}

const MAX_FAILURES = 2;
const MAX_UPLOAD_BACKLOG = 3;

/**
 * Screen-space-error driven LOD streaming for one class of tiles.
 *
 * Selection is the 3D-Tiles rule: project a LOD's geometric error to pixels
 * (`error * screenHeight / (distance * 2 * tan(fov/2))`) and take the coarsest
 * LOD whose projected error is under the threshold. Fetches are ordered by the
 * error a tile would *win*, so the tile that is worst on screen goes first.
 * Nothing is removed before its replacement is on the GPU. With `pinCoarsest`,
 * required index 0 fallbacks stay resident so visible tiles cannot become holes.
 */
export class TileStreamLayer {
  readonly group = new Group();
  readonly entries = new Map<string, Entry>();

  private readonly opts: TileStreamLayerOptions;
  private readonly uploadQueue: { entry: Entry; index: number; asset: PreparedAsset }[] = [];
  /**
   * Shader compilation is asynchronous inside Three.js and cannot be aborted.
   * Keep the promises so the owning viewer can leave its WebGL renderer alive
   * until Three's readiness poll has finished during a map teardown.
   */
  private readonly compilationJobs = new Set<Promise<void>>();
  private readonly compiling = new Set<PreparedAsset>();
  private bytes = 0;
  private pending = 0;
  private disposed = false;
  private generation = 0;
  private bootstrapped: boolean;
  /**
   * In-view tiles with nothing displayed, as of the last `update`. Unlike
   * `bootstrapped` this is live: it rises again when the camera turns towards
   * tiles that are not resident yet, which is exactly the popping-into-view a
   * ready scene must never show.
   */
  private requiredMissing = 0;
  private decodedAssets = 0;
  private uploadedTextures = 0;
  private compiledAssets = 0;
  private lastAdmissionRefusal: LayerStats['lastAdmissionRefusal'] = null;
  private largestAdmissionUnderestimate: LayerStats['largestAdmissionUnderestimate'] = null;
  private estimateRatio = 1;

  constructor(opts: TileStreamLayerOptions) {
    this.opts = opts;
    this.group.name = opts.name;
    this.bootstrapped = !opts.pinCoarsest;
    for (const def of opts.defs) {
      this.entries.set(def.id, {
        def,
        resident: new Map(),
        displayed: -1,
        wanted: false,
        required: false,
        desired: 0,
        loading: null,
        preparing: null,
        budgetBlocked: false,
        evictedCap: null,
        failures: 0,
        gain: Infinity,
        distance: Infinity,
      });
    }
  }

  get residentBytes(): number {
    return this.bytes;
  }

  /** Estimated bytes of assets that are decoding or waiting on the GPU. */
  get pendingBytes(): number {
    return this.pending;
  }

  get generationId(): number {
    return this.generation;
  }

  /** True once every in-view tile has its coarsest LOD on screen. */
  get ready(): boolean {
    return this.bootstrapped;
  }

  /** In-view tiles displaying nothing right now; 0 means the view is complete. */
  get missingInView(): number {
    return this.requiredMissing;
  }

  /** Retry optional detail after the caller changes the shared memory budget. */
  clearBudgetBlocks(): void {
    for (const entry of this.entries.values()) entry.budgetBlocked = false;
  }

  stats(): LayerStats {
    let residentTiles = 0;
    let residentAssets = 0;
    let queued = 0;
    let loading = 0;
    let requiredPendingAssets = 0;
    let wantedTiles = 0;
    let missingTiles = 0;
    let budgetBlockedTiles = 0;
    let failedTiles = 0;
    for (const entry of this.entries.values()) {
      if (entry.resident.size > 0) residentTiles++;
      residentAssets += entry.resident.size;
      if (entry.loading) loading++;
      else if (entry.preparing === null && !entry.budgetBlocked && entry.desired > this.finestResident(entry)) queued++;
      if ((this.opts.essentialAll || this.opts.pinCoarsest)
        && (this.opts.essentialAll || (this.opts.required ?? this.opts.want)?.(entry.def, entry.distance) !== false)) {
        const requiredIndex = this.opts.essentialAll
          ? (this.opts.maxDesiredIndex?.(entry.def) ?? entry.def.lods.length - 1)
          : 0;
        if (!entry.resident.has(requiredIndex)) requiredPendingAssets++;
      }
      if (entry.wanted) {
        wantedTiles++;
        if (entry.resident.size === 0) missingTiles++;
        if (entry.budgetBlocked) budgetBlockedTiles++;
        if (entry.failures >= MAX_FAILURES) failedTiles++;
      }
    }
    let pendingTextureUploads = 0;
    for (const job of this.uploadQueue) pendingTextureUploads += job.asset.pendingTextures.length;
    return {
      residentTiles,
      residentAssets,
      bytes: this.bytes,
      pendingBytes: this.pending,
      loading,
      queued,
      uploading: this.uploadQueue.length + this.compiling.size,
      pendingTextureUploads,
      decodedAssets: this.decodedAssets,
      uploadedTextures: this.uploadedTextures,
      compiledAssets: this.compiledAssets,
      compiling: this.compiling.size,
      largestAdmissionUnderestimate: this.largestAdmissionUnderestimate,
      requiredPendingAssets,
      wantedTiles,
      missingTiles,
      missingInViewTiles: this.requiredMissing,
      budgetBlockedTiles,
      failedTiles,
      lastAdmissionRefusal: this.lastAdmissionRefusal,
    };
  }

  private finestResident(entry: Entry): number {
    let best = -1;
    for (const index of entry.resident.keys()) if (index > best) best = index;
    return best;
  }

  /**
   * Refreshes desired LODs, starts/cancels fetches and swaps ready assets in.
   * `sseScale` is `screenHeight / (2 * tan(fov / 2))`.
   */
  update(cameraPos: Vector3, sseScale: number, maxSse: number): void {
    if (this.disposed) return;

    let bootstrapped = true;
    let requiredMissing = 0;
    for (const entry of this.entries.values()) {
      const distance = Math.max(1e-3, entry.def.box.distanceToPoint(cameraPos));
      const previousDistance = entry.distance;
      entry.distance = distance;
      const lods = entry.def.lods;

      const wanted = this.opts.want ? this.opts.want(entry.def, distance) : true;
      let desired = -1;
      if (wanted && entry.failures < MAX_FAILURES) {
        desired = lods.length - 1;
        for (let i = 0; i < lods.length; i++) {
          const err = lods[i]?.geometricError ?? 0;
          if ((err * sseScale) / distance <= maxSse) {
            desired = i;
            break;
          }
        }
        // A single asset that would eat most of the budget is never worth it:
        // one LOD0 tile in this dataset can be ~900 MB of RGBA.
        if (!this.opts.essentialAll) {
          const cap = this.opts.memory.maxAssetBytes();
          while (desired > 0) {
            const candidate = lods[desired];
            if (!candidate || estimateLodBytes(candidate) <= cap) break;
            desired--;
          }
        }
        if (this.opts.maxDesiredIndex) desired = Math.min(desired, this.opts.maxDesiredIndex(entry.def));
        if (!this.bootstrapped || (this.opts.pinCoarsest && !entry.resident.has(0))) desired = 0;
      }
      const viewMoved = Number.isFinite(previousDistance) && Math.abs(distance - previousDistance) > Math.max(10, previousDistance * 0.2);
      if (viewMoved || desired < 0) entry.evictedCap = null;
      if (entry.evictedCap !== null && desired > entry.evictedCap) desired = entry.evictedCap;
      if (desired !== entry.desired || viewMoved) {
        entry.budgetBlocked = false;
      }
      if (entry.budgetBlocked && this.opts.pinCoarsest && !entry.resident.has(0)
        && (this.opts.required?.(entry.def, distance) ?? wanted)
        && this.opts.memory.pendingBytes?.() === 0) entry.budgetBlocked = false;
      entry.wanted = wanted;
      entry.desired = desired;

      // Readiness is judged on what the viewer can see, not on the prefetch
      // margin around it: a tile is missing only if nothing of it is on screen.
      const required = wanted
        && (this.opts.required ? this.opts.required(entry.def, distance) : true);
      entry.required = required;
      if (required && entry.displayed < 0) {
        requiredMissing++;
        bootstrapped = false;
      }

      const finest = this.finestResident(entry);
      const currentErr = finest >= 0 ? (lods[finest]?.geometricError ?? 0) : Infinity;
      const desiredErr = desired >= 0 ? (lods[desired]?.geometricError ?? 0) : 0;
      entry.gain = ((currentErr - desiredErr) * sseScale) / distance;

      // A queued fetch nobody wants any more (camera moved away) is dropped
      // instead of finished — it would only burn budget on an evictable LOD.
      if (entry.loading && entry.loading.index > Math.max(desired, finest)) {
        entry.loading.controller.abort();
        entry.loading = null;
      }
    }
    this.bootstrapped = this.bootstrapped || bootstrapped;
    this.requiredMissing = requiredMissing;

    this.pumpFetches();
  }

  private pumpFetches(): void {
    // A decoded asset holds its whole texture set as ImageBitmaps until the
    // pacer uploads it. Letting the fetchers run ahead of the (deliberately
    // slow) upload pacer is how the transient footprint explodes, so the
    // backlog is capped.
    const backlog = this.opts.maxBacklog?.() ?? MAX_UPLOAD_BACKLOG;
    if (this.uploadQueue.length + this.compiling.size >= backlog) return;
    let active = 0;
    for (const entry of this.entries.values()) if (entry.loading) active++;
    if (active >= this.opts.maxConcurrent) return;

    const wanted: Entry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.loading || entry.preparing !== null || entry.budgetBlocked || entry.desired < 0) continue;
      if (entry.desired <= this.finestResident(entry)) continue;
      wanted.push(entry);
    }
    if (wanted.length === 0) return;
    // Biggest screen-space win first; not-yet-loaded tiles (gain Infinity) lead.
    // Required/in-view tiles sort ahead of prefetch and vegetation.
    wanted.sort((a, b) => Number(b.required) - Number(a.required) || b.gain - a.gain || a.distance - b.distance);

    for (const entry of wanted) {
      if (active >= this.opts.maxConcurrent
        || active + this.uploadQueue.length + this.compiling.size >= backlog) break;

      // If the selected detail cannot fit, walk toward the coarsest LOD. A
      // resident fallback is immediately usable; otherwise try to admit the
      // cheapest candidate before declaring the tile blocked. This keeps
      // buildings visible under pressure and lets the next update re-promote
      // them when budget is released.
      let admitted = false;
      for (let index = entry.desired; index >= 0; index--) {
        if (entry.resident.has(index)) {
          entry.desired = index;
          entry.budgetBlocked = false;
          admitted = true;
          break;
        }
        if (this.startLoad(entry, index, false)) {
          entry.desired = index;
          admitted = true;
          active++;
          break;
        }
      }
      if (!admitted) entry.budgetBlocked = true;
    }
  }

  private startLoad(entry: Entry, index: number, markBudgetBlocked = true): boolean {
    const lod = entry.def.lods[index];
    if (!lod) return false;
    const rawEstimate = estimateLodBytes(lod);
    const estimate = rawEstimate * this.estimateRatio;
    const essential = this.opts.essentialAll === true
      || (this.opts.essentialCoarsest === true && index === 0);
    const priority = (entry.required ? -Infinity : entry.distance) + (this.opts.priorityBias ?? 0);
    if (!essential && !this.opts.memory.admit(estimate, priority)) {
      this.lastAdmissionRefusal = {
        assetId: entry.def.id,
        lodIndex: index,
        estimatedBytes: estimate,
        priority,
        pendingBytes: this.opts.memory.pendingBytes?.() ?? this.pending,
      };
      if (markBudgetBlocked) entry.budgetBlocked = true;
      if (entry.required && this.opts.pinCoarsest && index === 0 && this.opts.memory.pendingBytes?.() === 0) {
        entry.failures = MAX_FAILURES;
        this.reportFailure(entry, index, new RequiredAssetBudgetError(this.opts.name, entry.def.id, this, this.generation, estimate));
      }
      return false;
    }
    this.pending += estimate;
    const controller = new AbortController();
    const generation = this.generation;
    entry.loading = { index, controller };
    this.opts
      .build(entry.def, lod, controller.signal)
      .then((asset) => {
        if (entry.loading?.controller === controller) entry.loading = null;
        this.pending -= estimate;
        if (this.disposed || controller.signal.aborted || generation !== this.generation) {
          asset.dispose?.();
          disposeResources(asset.resources);
          return;
        }
        const observedRatio = asset.bytes / Math.max(rawEstimate, 1);
        this.estimateRatio = this.estimateRatio * 0.8 + observedRatio * 0.2;
        const previous = this.largestAdmissionUnderestimate;
        if (asset.bytes > rawEstimate && (!previous || asset.bytes * previous.estimatedBytes > previous.decodedBytes * rawEstimate)) {
          this.largestAdmissionUnderestimate = { assetId: entry.def.id, estimatedBytes: rawEstimate, decodedBytes: asset.bytes };
        }
        entry.preparing = index;
        this.decodedAssets++;
        this.pending += asset.bytes;
        this.uploadQueue.push({ entry, index, asset });
        this.pumpFetches();
      })
      .catch((err: unknown) => {
        if (entry.loading?.controller === controller) entry.loading = null;
        this.pending -= estimate;
        if (controller.signal.aborted || generation !== this.generation) return;
        entry.failures++;
        const error = new Error(`[${this.opts.name}] downloading/decoding ${entry.def.id} lod${lod.level} failed`, { cause: err });
        console.error(error);
        if (entry.failures >= MAX_FAILURES) this.reportFailure(entry, index, error);
      });
    return true;
  }


  /**
   * Pushes queued textures to the GPU under a per-frame time budget so a 140 MB
   * LOD0 tile cannot stall a frame, then compiles and swaps the asset in.
   */
  pumpUploads(deadline: number, pixelBudget: { remaining: number }, camera: Camera): void {
    if (this.disposed || this.uploadQueue.length === 0) return;
    this.uploadQueue.sort(
      (a, b) => Number(b.entry.required) - Number(a.entry.required) || b.entry.gain - a.entry.gain || a.entry.distance - b.entry.distance,
    );
    while (this.uploadQueue.length > 0 && performance.now() < deadline && pixelBudget.remaining > 0) {
      const job = this.uploadQueue[0];
      if (!job) break;
      const tex = job.asset.pendingTextures.pop();
      if (tex) {
        const image = tex.image as { width?: number; height?: number } | undefined;
        // Charged before the upload so one 2048px texture (~4.2 Mpx, the
        // dominant cost at LOD0/LOD1) is all a frame ever does.
        pixelBudget.remaining -= (image?.width ?? 0) * (image?.height ?? 0);
        try {
          uploadTexture(this.opts.renderer, tex);
          this.uploadedTextures++;
        } catch (cause) {
          this.uploadQueue.shift();
          this.pending -= job.asset.bytes;
          job.entry.preparing = null;
          job.entry.failures = MAX_FAILURES;
          job.asset.dispose?.();
          disposeResources(job.asset.resources);
          this.reportFailure(job.entry, job.index, new Error(`[${this.opts.name}] uploading ${job.entry.def.id} failed`, { cause }));
        }
        continue;
      }
      this.uploadQueue.shift();
      this.pending -= job.asset.bytes;
      this.finishAsset(job.entry, job.index, job.asset, camera);
    }
  }

  private finishAsset(entry: Entry, index: number, asset: PreparedAsset, camera: Camera): void {
    this.compiling.add(asset);
    this.pending += asset.bytes;
    // Start in a promise so synchronous driver/compile failures use the same
    // cleanup path as asynchronous shader failures.
    const job = Promise.resolve()
      .then(() => {
        asset.object.updateMatrixWorld(true);
        return this.opts.renderer.compileAsync(asset.object, camera, this.opts.scene);
      })
      .then((): void => {
        if (this.disposed) {
          asset.dispose?.();
          disposeResources(asset.resources);
          return;
        }
        assertMaterialsLinked(this.opts.renderer, asset.resources.materials);
        this.compiledAssets++;
        this.swapIn(entry, index, asset);
      })
      .catch((cause: unknown): void => {
        asset.dispose?.();
        disposeResources(asset.resources);
        if (!this.disposed) {
          entry.failures = MAX_FAILURES;
          this.reportFailure(entry, index, new Error(`[${this.opts.name}] compiling ${entry.def.id} failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause }), true);
        }
      })
      .finally(() => {
        this.compiling.delete(asset);
        this.pending -= asset.bytes;
        if (entry.preparing === index) entry.preparing = null;
      });
    this.compilationJobs.add(job);
    void job.then(
      () => this.compilationJobs.delete(job),
      (error: unknown) => {
        this.compilationJobs.delete(job);
        this.reportFailure(entry, index, new Error(`[${this.opts.name}] finalizing ${entry.def.id} failed`, { cause: error }));
      },
    );
  }

  private reportFailure(entry: Entry, index: number, error: Error, shaderFailure = false): void {
    console.error(error);
    if (shaderFailure || this.opts.essentialAll || (this.opts.pinCoarsest && index === 0)) this.opts.onError?.(error);
  }

  /** Resolves after all non-cancellable Three.js shader polls have stopped. */
  whenCompilationIdle(): Promise<void> {
    return Promise.allSettled([...this.compilationJobs]).then(() => undefined);
  }

  /** Drop every resident/uploaded asset so a source-variant change can rebuild the layer. */
  async resetAssets(): Promise<void> {
    if (this.disposed) return;
    await this.whenCompilationIdle();
    if (this.disposed) return;
    this.generation++;
    for (const entry of this.entries.values()) {
      entry.loading?.controller.abort();
      entry.loading = null;
      entry.preparing = null;
      entry.budgetBlocked = false;
      entry.evictedCap = null;
      for (const asset of entry.resident.values()) {
        this.group.remove(asset.object);
        asset.dispose?.();
        disposeResources(asset.resources);
      }
      entry.resident.clear();
      entry.displayed = -1;
      entry.failures = 0;
      entry.gain = Infinity;
    }
    for (const job of this.uploadQueue.splice(0)) {
      this.pending -= job.asset.bytes;
      job.asset.dispose?.();
      disposeResources(job.asset.resources);
    }
    this.bytes = 0;
    this.largestAdmissionUnderestimate = null;
    this.pending = Math.max(0, this.pending);
    this.bootstrapped = !this.opts.pinCoarsest;
    this.group.clear();
  }

  private swapIn(entry: Entry, index: number, asset: PreparedAsset): void {
    if (entry.resident.has(index)) {
      asset.dispose?.();
      disposeResources(asset.resources);
      return;
    }
    entry.resident.set(index, asset);
    this.bytes += asset.bytes;

    if (index > entry.displayed) {
      const old = entry.displayed >= 0 ? entry.resident.get(entry.displayed) : undefined;
      this.group.add(asset.object);
      if (old) this.group.remove(old.object);
      entry.displayed = index;
      this.opts.onDisplay?.(entry.def, asset, index);
    }

    // Keep at most the pinned fallback plus whatever is on screen.
    for (const [level, resident] of [...entry.resident]) {
      if (level === entry.displayed) continue;
      if (level === 0 && this.opts.pinCoarsest) continue;
      entry.resident.delete(level);
      this.bytes -= resident.bytes;
      this.group.remove(resident.object);
      resident.dispose?.();
      disposeResources(resident.resources);
    }
  }

  /** Per-frame hook for LOD behaviour that needs no reload (veg density/range). */
  tickDisplayed(): void {
    const onTick = this.opts.onTick;
    if (!onTick) return;
    for (const entry of this.entries.values()) {
      if (entry.displayed < 0) continue;
      const asset = entry.resident.get(entry.displayed);
      if (asset) onTick(entry.def, asset, entry.distance, entry.displayed);
    }
  }

  evictionCandidates(out: EvictionCandidate[]): void {
    for (const entry of this.entries.values()) {
      for (const [index, asset] of entry.resident) {
        if (index === 0 && this.opts.pinCoarsest && entry.required) continue;
        // Evicting the exact asset this stationary view still wants creates an
        // endless fetch -> upload -> eviction loop. Refuse the new admission
        // instead; a camera/quality change will make it eligible later.
        if (index === entry.desired && entry.required) continue;
        // The level on screen while a finer one is on its way is all this tile
        // shows: evicting it leaves a hole for the few bytes a coarse level holds.
        if (entry.wanted && index === entry.displayed && index < entry.desired) continue;
        const unwanted = entry.desired < 0 ? 100 : index > entry.desired ? 5 : 1;
        out.push({
          layer: this,
          entryId: entry.def.id,
          index,
          bytes: asset.bytes,
          score: entry.distance * unwanted + (this.opts.priorityBias ?? 0),
        });
      }
    }
  }

  evict(candidate: EvictionCandidate): number {
    const entry = this.entries.get(candidate.entryId);
    const asset = entry?.resident.get(candidate.index);
    if (!entry || !asset) return 0;
    entry.resident.delete(candidate.index);
    this.bytes -= asset.bytes;
    // A budget-evicted prefetch must not compete for the same bytes again until
    // the view changes or it becomes required. A tile that loses the level it
    // had on screen falls back to a coarser one rather than going blank.
    if (!entry.required && entry.wanted) {
      if (entry.displayed === candidate.index && candidate.index > 0) entry.evictedCap = candidate.index - 1;
      else entry.budgetBlocked = true;
    }
    this.group.remove(asset.object);
    if (entry.displayed === candidate.index) {
      const fallback = entry.resident.get(0);
      if (fallback) {
        this.group.add(fallback.object);
        entry.displayed = 0;
      } else {
        entry.displayed = -1;
      }
    }
    asset.dispose?.();
    disposeResources(asset.resources);
    return asset.bytes;
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.entries.values()) {
      entry.loading?.controller.abort();
      entry.preparing = null;
      for (const asset of entry.resident.values()) {
        this.group.remove(asset.object);
        asset.dispose?.();
        disposeResources(asset.resources);
      }
      entry.resident.clear();
    }
    for (const job of this.uploadQueue) {
      job.asset.dispose?.();
      disposeResources(job.asset.resources);
    }
    this.uploadQueue.length = 0;
    this.pending = 0;
    this.group.clear();
    this.entries.clear();
    this.bytes = 0;
  }
}

export function boxOf(min: number[], max: number[]): Box3 {
  return new Box3(
    new Vector3(min[0] ?? 0, min[1] ?? 0, min[2] ?? 0),
    new Vector3(max[0] ?? 0, max[1] ?? 0, max[2] ?? 0),
  );
}

export type { Object3D };
