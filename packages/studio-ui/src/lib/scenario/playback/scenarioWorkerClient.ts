"use client";

import type { ScenarioTemplateV2 } from '@simforge-oss/scenario';
import { contentHash, type AmbientTrafficProfile, type EvaluateFilters, type IntentRubricInput } from '@simforge-oss/engine';
import type { MapEntry } from '../maps';
import { parsePlaybackPair, type PlaybackBundle } from '@simforge-oss/playback';
import type {
  AmbientRobustnessSummary,
  ScenarioWorkerAssetRequest,
  ScenarioWorkerAssetResponse,
  ScenarioWorkerEngineIdentity,
  ScenarioWorkerEngineRequest,
  ScenarioWorkerOutbound,
  ScenarioWorkerRequest,
  ScenarioWorkerResponse,
} from './scenario-worker';
import type { ScenarioWorkerStartRequest } from './scenario-worker';
import { RevisionGate } from '@simforge-oss/playback';
import { primeGalleryEntriesForDocument } from '../../asset-gallery/editor-bridge';
import { primeCarlaObjectsForDocument } from '../carla-objects';
import { listExternalCatalogEntries } from '@simforge-oss/asset-catalog';
import { resolveMapAssetUrl } from '../../maps/frontend/map-asset-cache';

export interface LivePlaybackCounters {
  readonly startupMs: number | null;
  readonly progressMessages: number;
  readonly demandMessages: number;
}

export interface LivePlaybackRun {
  readonly bundle: PlaybackBundle;
  readonly completion: Promise<PlaybackBundle>;
  recordedUntil(): number;
  setPlaying(playing: boolean, time?: number): void;
  counters(): LivePlaybackCounters;
}

interface PendingRequest {
  readonly revision: string;
  readonly onMessage: (message: ScenarioWorkerResponse) => void;
  reject: (reason: Error) => void;
  timeout?: ReturnType<typeof setTimeout>;
}

/** One long-lived worker owns map loading, document compilation and live play. */
export class ScenarioWorkerClient {
  private worker: Worker | null = null;
  private sequence = 0;
  private pending = new Map<number, PendingRequest>();
  private compileGate = new RevisionGate();
  private activeCompile: number | null = null;
  private activeLive: number | null = null;
  private runtimeByInput = new Map<string, string>();
  private engine: Promise<ScenarioWorkerEngineIdentity> | null = null;

  /**
   * Identity of the native engine this client executes with. Resolved once per
   * worker; a persisted preview is admitted only when it was produced by it.
   */
  engineIdentity(): Promise<ScenarioWorkerEngineIdentity> {
    if (this.engine) return this.engine;
    const worker = this.ensureWorker();
    const id = ++this.sequence;
    const identity = new Promise<ScenarioWorkerEngineIdentity>((resolve, reject) => {
      this.pending.set(id, { revision: '', reject, onMessage: (message) => {
        this.pending.delete(id);
        if (!message.ok) reject(new Error(message.error));
        else if (message.kind === 'engine') resolve(message.engine);
        else reject(new Error('Simulation worker answered an engine identity request with a different message'));
      } });
      worker.postMessage({ kind: 'engine', id } satisfies ScenarioWorkerEngineRequest);
    });
    identity.catch(() => { if (this.engine === identity) this.engine = null; });
    this.engine = identity;
    return identity;
  }

  async prepare(
    template: ScenarioTemplateV2,
    map: MapEntry,
    ambientTraffic: AmbientTrafficProfile,
    baseInstance?: PlaybackBundle['instance'],
    options: {
      timeoutMs?: number;
      /** Build only the warmed t=0 authoring world; Play streams the trace live. */
      materializeOnly?: boolean;
      /** Run the complete trace for editor visualization without export/collider work. */
      backgroundPreview?: boolean;
    } = {},
  ): Promise<PlaybackBundle> {
    this.cancelCompile();
    const id = ++this.sequence;
    const revision = contentHash({ template, ambientTraffic, baseInstance: baseInstance?.manifest.inputHash ?? null });
    this.compileGate.begin(revision);
    this.activeCompile = id;
    const timeoutMs = options.timeoutMs ?? 45_000;
    // The worker materialises against its own catalog instance, and the
    // editor's own priming races this call. Resolving both runtime catalogs
    // here is idempotent and makes a gallery or CARLA id impossible to
    // materialise as an unknown default model.
    try {
      await withPreparationTimeout(
        Promise.all([
          primeGalleryEntriesForDocument(template).catch(() => []),
          primeCarlaObjectsForDocument(template).catch(() => []),
        ]),
        timeoutMs,
        'asset catalog',
      );
    } catch (error) {
      if (this.activeCompile === id) this.activeCompile = null;
      throw error;
    }
    if (this.activeCompile !== id) {
      throw new DOMException('Scenario preparation was canceled', 'AbortError');
    }
    const worker = this.ensureWorker();
    return new Promise((resolve, reject) => {
      let phase = 'starting';
      const pending: PendingRequest = { revision, reject, onMessage: (message) => {
        if (!this.compileGate.accepts(message.revision)) return;
        if (message.ok && message.kind === 'prepare-progress') {
          phase = message.phase;
          armTimeout();
          return;
        }
        if (pending.timeout) clearTimeout(pending.timeout);
        this.pending.delete(id);
        if (this.activeCompile === id) this.activeCompile = null;
        if (!message.ok) {
          reject(new Error(message.error));
          return;
        }
        if (message.kind !== 'prepare') {
          reject(new Error('Simulation worker returned a robustness report to a playback request'));
          return;
        }
        try {
          const bundle = parsePlaybackPair(message.instance, message.trace, {
            instanceName: 'authored scenario', traceName: 'simulation worker',
          });
          const result = {
            ...bundle,
            ambientTraffic: message.ambientTraffic,
            mapCollisions: deepFreeze(message.mapCollisions),
            openScenario: deepFreeze(message.openScenario),
          };
          this.runtimeByInput.set(contentHash(result.instance.input), message.runtimeKey);
          resolve(result);
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      }};
      const armTimeout = () => {
        if (pending.timeout) clearTimeout(pending.timeout);
        pending.timeout = setTimeout(() => {
          if (!this.pending.has(id)) return;
          this.pending.delete(id);
          if (this.activeCompile === id) this.activeCompile = null;
          reject(new Error(`Scenario preparation stopped making progress for ${timeoutMs} ms during ${phase}.`));
        }, timeoutMs);
      };
      this.pending.set(id, pending);
      armTimeout();
      worker.postMessage({
        kind: options.materializeOnly || options.backgroundPreview ? 'compile' : 'export',
        externalCatalog: listExternalCatalogEntries(),
        id,
        revision,
        template,
        ambientTraffic,
        ...(baseInstance ? { baseInstance } : {}),
        operation: options.materializeOnly ? 'materialize' : 'prepare',
        map: workerMap(map),
      } satisfies ScenarioWorkerRequest);
    });
  }

  start(base: PlaybackBundle, _map: MapEntry): LivePlaybackRun {
    this.cancelLive();
    const worker = this.ensureWorker();
    const id = ++this.sequence;
    const revision = contentHash(base.instance.input);
    const runtimeKey = this.runtimeByInput.get(revision);
    if (!runtimeKey) throw new Error('This world was not compiled by the active map runtime.');
    this.activeLive = id;
    const startedAt = performance.now();
    let startupMs: number | null = null;
    let progressMessages = 0;
    let demandMessages = 0;
    let available = base.trace.ticks.t.at(-1) ?? 0;
    const liveBundle: PlaybackBundle = { ...base, endTime: base.instance.input.clipSeconds };
    let resolveCompletion!: (bundle: PlaybackBundle) => void;
    let rejectCompletion!: (reason: Error) => void;
    const completion = new Promise<PlaybackBundle>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    this.pending.set(id, { revision, reject: rejectCompletion, onMessage: (message) => {
        if (message.revision !== revision) return;
        if (!message.ok) {
          const error = new Error(message.error);
          this.pending.delete(id);
          rejectCompletion(error);
          return;
        }
        if (message.kind !== 'ready' && message.kind !== 'progress' && message.kind !== 'complete') return;
        const parsed = parsePlaybackPair(base.instance, message.trace, {
          instanceName: 'live authored scenario', traceName: 'live fixed-step simulation',
        });
        available = message.recordedUntil;
        progressMessages++;
        if (startupMs === null) startupMs = performance.now() - startedAt;
        (liveBundle as { trace: PlaybackBundle['trace'] }).trace = parsed.trace;
        if (message.kind === 'complete') {
          this.pending.delete(id);
          if (this.activeLive === id) this.activeLive = null;
          resolveCompletion(liveBundle);
        }
      }});
    worker.postMessage({ kind: 'start', id, revision, runtimeKey, input: base.instance.input, externalCatalog: listExternalCatalogEntries() } satisfies ScenarioWorkerStartRequest);
    return {
      bundle: liveBundle,
      completion,
      recordedUntil: () => available,
      setPlaying: (playing, time) => {
        if (playing && typeof time === 'number') demandMessages++;
        worker.postMessage({ kind: 'transport', id, playing, time });
      },
      counters: () => ({ startupMs, progressMessages, demandMessages }),
    };
  }

  cancel(): void {
    this.cancelCompile();
    this.cancelLive();
  }

  dispose(): void {
    this.cancel();
    this.worker?.terminate();
    this.worker = null;
    this.engine = null;
    this.runtimeByInput.clear();
  }

  private cancelCompile(): void {
    this.compileGate.invalidate();
    if (this.activeCompile === null) return;
    this.rejectRequest(this.activeCompile, new DOMException('Scenario preparation was canceled', 'AbortError'));
    this.activeCompile = null;
  }

  private cancelLive(): void {
    if (this.activeLive === null) return;
    const id = this.activeLive;
    this.worker?.postMessage({ kind: 'cancel', id });
    this.rejectRequest(id, new DOMException('Live simulation was canceled', 'AbortError'));
    this.activeLive = null;
  }

  private rejectRequest(id: number, reason: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    if (pending.timeout) clearTimeout(pending.timeout);
    this.pending.delete(id);
    pending.reject(reason);
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./scenario-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<ScenarioWorkerOutbound>) => {
      if ('resolveId' in event.data) {
        serveAssetResolution(worker, event.data);
        return;
      }
      this.pending.get(event.data.id)?.onMessage(event.data);
    };
    worker.onerror = (event) => {
      const error = new Error(event.message || 'Simulation worker failed');
      for (const id of [...this.pending.keys()]) this.rejectRequest(id, error);
      this.worker?.terminate();
      this.worker = null;
      this.engine = null;
    };
    this.worker = worker;
    return worker;
  }
}

/**
 * Answer a worker's map-asset lookup from the page's cache backend. A failure
 * (integrity, authorization, network) is returned as the worker's fetch error
 * rather than a silent network fallback, so a desktop install never quietly
 * bypasses its verified disk store.
 */
function serveAssetResolution(worker: Worker, request: ScenarioWorkerAssetRequest): void {
  void resolveMapAssetUrl(request.url, { sha256: request.sha256 }).then(
    (url) => worker.postMessage({ kind: 'asset', resolveId: request.resolveId, url } satisfies ScenarioWorkerAssetResponse),
    (reason: unknown) => worker.postMessage({
      kind: 'asset',
      resolveId: request.resolveId,
      error: reason instanceof Error ? reason.message : String(reason),
    } satisfies ScenarioWorkerAssetResponse),
  );
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

async function withPreparationTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  phase: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Scenario preparation stopped making progress for ${timeoutMs} ms during ${phase}.`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

/** Run the deterministic Off/Light/Moderate robustness matrix in an isolated browser worker. */
export function evaluateAuthoredAmbientRobustness(
  template: ScenarioTemplateV2,
  map: MapEntry,
  filters: EvaluateFilters,
  intentRubric?: IntentRubricInput,
): Promise<AmbientRobustnessSummary> {
  const worker = new Worker(new URL('./scenario-worker.js', import.meta.url), { type: 'module' });
  const id = Date.now() + Math.floor(Math.random() * 10_000);
  const revision = contentHash({ template, filters, intentRubric: intentRubric ?? null });
  return new Promise((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<ScenarioWorkerOutbound>) => {
      if ('resolveId' in event.data) {
        serveAssetResolution(worker, event.data);
        return;
      }
      if (event.data.id !== id || event.data.revision !== revision) return;
      worker.terminate();
      if (!event.data.ok) { reject(new Error(event.data.error)); return; }
      if (event.data.kind !== 'robustness') { reject(new Error('Worker returned playback instead of a robustness report')); return; }
      resolve(event.data.report);
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || 'Ambient robustness worker failed'));
    };
    worker.postMessage({
      id,
      revision,
      kind: 'robustness',
      operation: 'robustness',
      template,
      evaluationFilters: filters,
      ...(intentRubric ? { intentRubric } : {}),
      ambientTraffic: { version: 1, preset: 'off', seed: 'robustness' },
      map: workerMap(map),
      externalCatalog: listExternalCatalogEntries(),
    } satisfies ScenarioWorkerRequest);
  });
}

function workerMap(map: MapEntry): ScenarioWorkerRequest['map'] {
  return {
    runtimeAssetId: map.mapVersionId,
    mapVersionId: map.mapVersionId,
    sourceMapId: map.sourceMapId,
    browserClosureSha256: map.browserClosureSha256,
    manifest: map.manifest,
    topology: map.topology,
    derivedTopology: map.derivedTopology,
    locations: map.locations,
    xodr: map.xodr,
    signals: map.signals,
    digests: {
      topology: map.artifacts.topologySha256,
      derivedTopology: map.artifacts.derivedTopologySha256,
      locations: map.artifacts.locationsSha256,
      xodr: map.artifacts.xodrSha256,
      signals: map.artifacts.signalsSha256,
    },
  };
}
