import { mkdir, readFile, readdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  contentAddressedBlobPath,
  INPUT_URLS_MAX_BATCH,
  RENDER_WORKER_CONTROL_V2_SCHEMA,
  type PrewarmManifestResponse,
  type PrewarmMember,
  type PrewarmSet,
  type WorkerCacheStatus,
} from '@simforge-oss/render';
import {
  PINNED_ACTOR_ASSETS_DIGEST,
  PINNED_ACTOR_ASSETS_SIZE_BYTES,
  actorAssetBlobUrl,
  actorAssetsClosureUrl,
  nativeActorAssetsCacheDir,
} from '@simforge-oss/render/native';

import { listCachedBlobs, type BlobSource, type BlobStore } from './blob-store.js';
import { isUnsupportedControlRoute, type RenderControlTransport } from './transport.js';

export interface PrewarmConfig {
  readonly enabled: boolean;
  readonly intervalMs: number;
  readonly pollMs: number;
  readonly budgetBytes: number;
  readonly minFreeBytes: number;
  readonly unwantedGraceMs: number;
  /** Also keep the pinned native actor closure warm. */
  readonly actorAssets: boolean;
}

interface WantedBlob {
  readonly sha256: string;
  readonly sizeBytes: number;
  /** Destination when it lives outside the main blob root (actor closure blobs). */
  readonly path?: string;
  readonly url?: string;
  /** The published set that authorizes signing this blob. */
  readonly setId?: string;
}

interface PlannedSet {
  readonly set: PrewarmSet;
  readonly members: readonly PrewarmMember[];
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      signal.removeEventListener('abort', done);
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Keeps every published native map closure (and the pinned actor closure)
 * in the worker's content-addressed cache so jobs never wait on map bytes.
 *
 * - Plans from the control plane's published sets; a set's member list is
 *   fetched once per closure digest and kept on disk.
 * - Recently rendered maps first, then newer map versions, then smaller ones.
 * - Fetches only what is missing, at `prewarm` priority: a job's downloads
 *   park it, a running render throttles it, idle runs it at full speed; a job
 *   that needs a blob prewarm is fetching joins that transfer.
 * - Evicts blobs no published set wants once they have gone unused for
 *   `unwantedGraceMs`, and least-recently-used blobs beyond the byte budget.
 * - Publishes its status (maps ready X/Y, bytes) to the health endpoint and
 *   the control plane.
 */
export class Prewarmer {
  private statusValue: WorkerCacheStatus;
  private lastReportedAt = 0;
  private readonly usageFile: string;

  constructor(
    private readonly store: BlobStore,
    private readonly transport: RenderControlTransport,
    private readonly config: PrewarmConfig,
    private readonly registrationId: () => string | undefined,
    private readonly log: (event: Record<string, unknown>) => void = (event) => console.error(JSON.stringify(event)),
  ) {
    this.usageFile = path.join(store.root, 'prewarm', 'usage.json');
    this.statusValue = {
      state: config.enabled ? 'starting' : 'disabled',
      maps: { ready: 0, total: 0 },
      blobs: { cached: 0, wanted: 0 },
      bytes: { cached: 0, wanted: 0, budget: config.budgetBytes },
      updatedAt: new Date().toISOString(),
    };
  }

  status(): WorkerCacheStatus {
    return this.statusValue;
  }

  /** Records that a job rendered this map version, so it is kept and warmed first. */
  async noteMapUsed(mapVersionId: string): Promise<void> {
    const usage = await this.readUsage();
    usage[mapVersionId] = Date.now();
    await mkdir(path.dirname(this.usageFile), { recursive: true });
    const temporary = `${this.usageFile}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(usage));
    await rename(temporary, this.usageFile);
  }

  async run(signal: AbortSignal): Promise<void> {
    if (!this.config.enabled) return;
    if (!this.transport.prewarmManifest || !this.transport.prewarmMembers || !this.transport.blobUrls) {
      this.update({ state: 'disabled', lastError: 'control transport has no prewarm routes' });
      return;
    }
    let generation: string | undefined;
    let lastFullAt = 0;
    while (!signal.aborted) {
      try {
        const manifest = await this.transport.prewarmManifest({ schema: RENDER_WORKER_CONTROL_V2_SCHEMA, type: 'worker.prewarm-manifest' }, signal);
        if (manifest.generation !== generation || Date.now() - lastFullAt >= this.config.intervalMs || this.statusValue.state !== 'ready') {
          await this.cycle(manifest, signal);
          generation = manifest.generation;
          lastFullAt = Date.now();
        }
      } catch (error) {
        if (signal.aborted) return;
        if (isUnsupportedControlRoute(error)) {
          this.update({ state: 'disabled', lastError: 'control plane does not serve workers/prewarm' });
          await delay(this.config.intervalMs, signal);
          continue;
        }
        this.log({ event: 'prewarm.error', error: errorMessage(error) });
        this.update({ state: 'error', lastError: errorMessage(error).slice(0, 2048) });
      }
      await delay(this.config.pollMs, signal);
    }
  }

  /** One full pass: plan, collect garbage, fetch what is missing. Exposed for tests. */
  async cycle(manifest: PrewarmManifestResponse, signal: AbortSignal): Promise<void> {
    const startedAt = Date.now();
    const usage = await this.readUsage();
    const sets = [...manifest.sets].sort((left, right) =>
      (usage[right.mapVersionId] ?? 0) - (usage[left.mapVersionId] ?? 0)
      || right.createdAt.localeCompare(left.createdAt)
      || left.byteLength - right.byteLength);
    const planned: PlannedSet[] = [];
    for (const set of sets) planned.push({ set, members: await this.members(set, signal) });

    const actor = this.config.actorAssets ? await this.actorClosureBlobs(signal).catch((error: unknown) => {
      this.log({ event: 'prewarm.actor_assets_failed', error: errorMessage(error) });
      return [] as WantedBlob[];
    }) : [];

    // Budget: admit whole sets in priority order while they fit.
    const budget = await this.effectiveBudget();
    const wanted = new Map<string, WantedBlob>();
    for (const blob of actor) wanted.set(blob.sha256, blob);
    let wantedBytes = actor.reduce((sum, blob) => sum + blob.sizeBytes, 0);
    const admitted: PlannedSet[] = [];
    let overBudget = false;
    for (const plan of planned) {
      let extra = 0;
      for (const member of plan.members) if (!wanted.has(member.sha256)) extra += member.sizeBytes;
      if (wantedBytes + extra > budget) {
        overBudget = true;
        continue;
      }
      for (const member of plan.members) wanted.set(member.sha256, { sha256: member.sha256, sizeBytes: member.sizeBytes });
      wantedBytes += extra;
      admitted.push(plan);
    }

    // Co-located workers (dev/staging/prod on one box) may share this root:
    // publish our wanted set and keep theirs.
    await this.publishWanted(wanted);
    if (planned.length > 0) await this.collectGarbage(await this.withPeerWanted(wanted), budget, signal);

    // Presence, then fetch per set so maps become ready one by one.
    let readySets = 0;
    const countStatus = async () => {
      let cachedBlobs = 0;
      let cachedBytes = 0;
      for (const blob of wanted.values()) {
        if (await this.present(blob)) {
          cachedBlobs += 1;
          cachedBytes += blob.sizeBytes;
        }
      }
      return { cachedBlobs, cachedBytes };
    };
    const initial = await countStatus();
    this.update({
      state: initial.cachedBlobs === wanted.size ? (overBudget ? 'over-budget' : 'ready') : 'prewarming',
      maps: { ready: 0, total: planned.length },
      blobs: { cached: initial.cachedBlobs, wanted: wanted.size },
      bytes: { cached: initial.cachedBytes, wanted: wantedBytes, budget, ...(await this.diskFree()) },
      lastError: undefined,
    });
    let cachedBlobs = initial.cachedBlobs;
    let cachedBytes = initial.cachedBytes;
    const onFetched = (blob: WantedBlob) => {
      cachedBlobs += 1;
      cachedBytes += blob.sizeBytes;
      this.update({ blobs: { cached: cachedBlobs, wanted: wanted.size }, bytes: { ...this.statusValue.bytes, cached: cachedBytes } }, false);
    };

    if (actor.length > 0) await this.fetchAll(actor, signal, onFetched);
    for (const plan of admitted) {
      if (signal.aborted) return;
      const blobs = plan.members.map((member) => ({ sha256: member.sha256, sizeBytes: member.sizeBytes, setId: plan.set.setId }));
      await this.fetchAll(blobs, signal, onFetched);
      readySets += 1;
      this.update({ maps: { ready: readySets, total: planned.length } }, false);
    }
    const final = await countStatus();
    this.update({
      state: final.cachedBlobs === wanted.size ? (overBudget ? 'over-budget' : 'ready') : 'prewarming',
      maps: { ready: readySets, total: planned.length },
      blobs: { cached: final.cachedBlobs, wanted: wanted.size },
      bytes: { cached: final.cachedBytes, wanted: wantedBytes, budget, ...(await this.diskFree()) },
    });
    this.log({ event: 'prewarm.cycle', sets: planned.length, admitted: admitted.length, wantedBlobs: wanted.size, wantedBytes, cachedBytes: final.cachedBytes, elapsedMs: Date.now() - startedAt });
  }

  private async present(blob: WantedBlob): Promise<boolean> {
    if (!blob.path) return this.store.present(blob.sha256, blob.sizeBytes);
    try {
      const info = await stat(blob.path);
      return info.isFile() && info.size === blob.sizeBytes;
    } catch {
      return false;
    }
  }

  /** Fetches every missing blob; waits out job downloads (which park prewarm) and resumes. */
  private async fetchAll(blobs: readonly WantedBlob[], signal: AbortSignal, onFetched: (blob: WantedBlob) => void): Promise<void> {
    const missing: WantedBlob[] = [];
    for (const blob of blobs) if (!await this.present(blob)) missing.push(blob);
    for (let start = 0; start < missing.length && !signal.aborted; start += INPUT_URLS_MAX_BATCH) {
      let batch = missing.slice(start, start + INPUT_URLS_MAX_BATCH);
      for (let pass = 0; batch.length > 0 && pass < 50 && !signal.aborted; pass += 1) {
        while (this.store.mode === 'job-downloading' && !signal.aborted) await delay(1000, signal);
        const signed = await this.sign(batch.filter((blob) => !blob.url), signal);
        const failed: WantedBlob[] = [];
        await Promise.all(batch.map(async (blob) => {
          const source: BlobSource = blob.url
            ? { url: async () => ({ url: blob.url!, headers: {} }) }
            : {
              url: async (refresh) => {
                const download = refresh ? (await this.sign([blob], signal)).get(blob.sha256) : signed.get(blob.sha256);
                if (!download) throw new Error(`control plane did not sign blob ${blob.sha256}`);
                return download;
              },
            };
          try {
            await this.store.ensure({ sha256: blob.sha256, sizeBytes: blob.sizeBytes, source, priority: 'prewarm', ...(blob.path ? { path: blob.path } : {}) }, signal);
            onFetched(blob);
          } catch (error) {
            if (signal.aborted) return;
            if (!(error instanceof Error && error.name === 'ParkedError')) {
              this.log({ event: 'prewarm.blob_failed', sha256: blob.sha256, error: errorMessage(error) });
            }
            failed.push(blob);
          }
        }));
        batch = failed;
        if (failed.length > 0 && this.store.mode !== 'job-downloading') await delay(Math.min(60_000, 2000 * (pass + 1)), signal);
      }
    }
  }

  private async sign(blobs: readonly WantedBlob[], signal: AbortSignal): Promise<Map<string, { url: string; headers: Readonly<Record<string, string>> }>> {
    const result = new Map<string, { url: string; headers: Readonly<Record<string, string>> }>();
    const bySet = new Map<string, string[]>();
    for (const blob of blobs) {
      if (!blob.setId) continue;
      bySet.set(blob.setId, [...(bySet.get(blob.setId) ?? []), blob.sha256]);
    }
    for (const [setId, digests] of bySet) {
      for (let start = 0; start < digests.length; start += INPUT_URLS_MAX_BATCH) {
        const response = await this.transport.blobUrls!({
          schema: RENDER_WORKER_CONTROL_V2_SCHEMA,
          type: 'worker.blob-urls',
          setId,
          sha256s: digests.slice(start, start + INPUT_URLS_MAX_BATCH),
        }, signal);
        for (const [sha256, download] of Object.entries(response.downloads)) result.set(sha256, download);
      }
    }
    return result;
  }

  private async members(set: PrewarmSet, signal: AbortSignal): Promise<PrewarmMember[]> {
    const file = path.join(this.store.root, 'prewarm', 'sets', `${set.closureSha256}.json`);
    try {
      const cached = JSON.parse(await readFile(file, 'utf8')) as PrewarmMember[];
      if (Array.isArray(cached) && cached.length === set.objectCount) return cached;
    } catch {
      // Not cached yet.
    }
    const members: PrewarmMember[] = [];
    let after: string | null = null;
    do {
      const page = await this.transport.prewarmMembers!({ schema: RENDER_WORKER_CONTROL_V2_SCHEMA, type: 'worker.prewarm-members', setId: set.setId, after }, signal);
      members.push(...page.members);
      after = page.next;
    } while (after !== null && !signal.aborted);
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(members));
    await rename(temporary, file);
    return members;
  }

  /** The pinned actor closure document (into the main store) and its members (into the actor blob cache). */
  private async actorClosureBlobs(signal: AbortSignal): Promise<WantedBlob[]> {
    const closureUrl = actorAssetsClosureUrl(PINNED_ACTOR_ASSETS_DIGEST);
    const closureFile = await this.store.ensure({
      sha256: PINNED_ACTOR_ASSETS_DIGEST,
      sizeBytes: PINNED_ACTOR_ASSETS_SIZE_BYTES,
      source: { url: async () => ({ url: closureUrl, headers: {} }) },
      priority: 'prewarm',
    }, signal);
    const document = JSON.parse(await readFile(closureFile, 'utf8')) as { members?: Record<string, { sha256: string; bytes: number }> };
    const actorRoot = nativeActorAssetsCacheDir(path.join(this.store.root, 'actor-assets'));
    const blobs: WantedBlob[] = [{ sha256: PINNED_ACTOR_ASSETS_DIGEST, sizeBytes: PINNED_ACTOR_ASSETS_SIZE_BYTES }];
    const seen = new Set<string>();
    for (const member of Object.values(document.members ?? {})) {
      if (seen.has(member.sha256)) continue;
      seen.add(member.sha256);
      blobs.push({
        sha256: member.sha256,
        sizeBytes: member.bytes,
        path: contentAddressedBlobPath(actorRoot, member.sha256),
        url: actorAssetBlobUrl(member.sha256),
      });
    }
    return blobs;
  }

  private wantedFile(): string {
    return path.join(this.store.root, 'prewarm', 'wanted', `${this.store.instanceTag}.txt`);
  }

  private async publishWanted(wanted: ReadonlyMap<string, WantedBlob>): Promise<void> {
    const file = this.wantedFile();
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, [...wanted.keys()].join('\n'));
    await rename(temporary, file);
  }

  /** Our wanted set plus every co-located worker's published one from the last two days. */
  private async withPeerWanted(wanted: ReadonlyMap<string, WantedBlob>): Promise<ReadonlyMap<string, WantedBlob>> {
    const directory = path.dirname(this.wantedFile());
    const merged = new Map(wanted);
    let names: string[] = [];
    try {
      names = await readdir(directory);
    } catch {
      return merged;
    }
    for (const name of names) {
      const file = path.join(directory, name);
      if (file === this.wantedFile() || !name.endsWith('.txt')) continue;
      try {
        if (Date.now() - (await stat(file)).mtimeMs > 2 * 86_400_000) continue;
        for (const sha256 of (await readFile(file, 'utf8')).split('\n')) {
          if (/^[0-9a-f]{64}$/.test(sha256) && !merged.has(sha256)) merged.set(sha256, { sha256, sizeBytes: 0 });
        }
      } catch {
        // A peer is rewriting its file.
      }
    }
    return merged;
  }

  private async readUsage(): Promise<Record<string, number>> {
    try {
      return JSON.parse(await readFile(this.usageFile, 'utf8')) as Record<string, number>;
    } catch {
      return {};
    }
  }

  private async diskFree(): Promise<{ diskFree?: number }> {
    try {
      const info = await statfs(this.store.root);
      return { diskFree: info.bavail * info.bsize };
    } catch {
      return {};
    }
  }

  /** The configured budget, lowered so the disk keeps `minFreeBytes` free. */
  private async effectiveBudget(): Promise<number> {
    const { diskFree } = await this.diskFree();
    if (diskFree === undefined) return this.config.budgetBytes;
    const cached = (await listCachedBlobs(this.store.root)).reduce((sum, entry) => sum + entry.sizeBytes, 0);
    return Math.max(0, Math.min(this.config.budgetBytes, cached + diskFree - this.config.minFreeBytes));
  }

  /**
   * Deletes unwanted blobs unused for the grace period, then evicts least
   * recently used blobs (unwanted first) while over budget. Blobs used in the
   * last hour are never evicted (a job may be reading them). Also prunes
   * stale partial downloads and staged trees.
   */
  async collectGarbage(wanted: ReadonlyMap<string, WantedBlob>, budget: number, signal?: AbortSignal): Promise<{ deleted: number; freedBytes: number }> {
    const now = Date.now();
    const entries = await listCachedBlobs(this.store.root);
    let total = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
    let deleted = 0;
    let freedBytes = 0;
    const remove = async (file: string, size: number) => {
      await rm(file, { force: true });
      deleted += 1;
      freedBytes += size;
      total -= size;
    };
    const survivors = [];
    for (const entry of entries) {
      if (signal?.aborted) break;
      if (!wanted.has(entry.sha256) && now - entry.lastUsedMs > this.config.unwantedGraceMs) await remove(entry.file, entry.sizeBytes);
      else survivors.push(entry);
    }
    if (total > budget) {
      survivors.sort((left, right) =>
        Number(wanted.has(left.sha256)) - Number(wanted.has(right.sha256)) || left.lastUsedMs - right.lastUsedMs);
      for (const entry of survivors) {
        if (total <= budget || signal?.aborted) break;
        if (now - entry.lastUsedMs < 3_600_000) continue;
        await remove(entry.file, entry.sizeBytes);
      }
    }
    await this.pruneDirectory(path.join(this.store.root, 'partial'), 86_400_000, false);
    await this.pruneDirectory(path.join(this.store.root, 'native-textures'), this.config.unwantedGraceMs, true);
    await this.pruneDirectory(path.join(nativeActorAssetsCacheDir(path.join(this.store.root, 'actor-assets')), 'trees'), this.config.unwantedGraceMs, true);
    if (deleted > 0) this.log({ event: 'prewarm.gc', deleted, freedBytes, remainingBytes: total, budget });
    return { deleted, freedBytes };
  }

  private async pruneDirectory(directory: string, olderThanMs: number, directoriesOnly: boolean): Promise<void> {
    let names: string[];
    try {
      names = await readdir(directory);
    } catch {
      return;
    }
    const now = Date.now();
    for (const name of names) {
      const entry = path.join(directory, name);
      try {
        const info = await stat(entry);
        if (directoriesOnly && !info.isDirectory()) continue;
        if (now - info.mtimeMs > olderThanMs) await rm(entry, { recursive: true, force: true });
      } catch {
        // Raced with another cleaner.
      }
    }
  }

  private update(patch: Partial<WorkerCacheStatus> & { lastError?: string | undefined }, force = true): void {
    const next = { ...this.statusValue, ...patch, updatedAt: new Date().toISOString() } as WorkerCacheStatus & { lastError?: string };
    if (patch.lastError === undefined && 'lastError' in patch) delete next.lastError;
    this.statusValue = next;
    if (!force && Date.now() - this.lastReportedAt < 30_000) return;
    this.lastReportedAt = Date.now();
    void this.report();
  }

  private async report(): Promise<void> {
    const registrationId = this.registrationId();
    if (!registrationId || !this.transport.reportCacheStatus) return;
    try {
      await this.transport.reportCacheStatus({
        schema: RENDER_WORKER_CONTROL_V2_SCHEMA,
        type: 'worker.cache-status',
        registrationId,
        cache: this.statusValue,
      }, AbortSignal.timeout(15_000));
    } catch (error) {
      if (!isUnsupportedControlRoute(error)) this.log({ event: 'prewarm.report_failed', error: errorMessage(error) });
    }
  }
}
