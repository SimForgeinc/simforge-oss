"use client";

import { useStudioHost } from "../../host";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DashCameraSensor, ScenarioTemplateV2 } from "@simforge-oss/scenario";
import type { ActorRenderer } from "@simforge-oss/viewer";
import type { CityViewer } from "@simforge-oss/viewer";
import { indexedWorldHeightSampler } from "@simforge-oss/viewer";
import {
  ambientTrafficProviderFromExtensions,
  DISABLED_SUMO_STATUS,
  type SumoTrafficStatus,
} from "@simforge-oss/playback/traffic";
import { ambientTrafficProfileFromExtensions } from "@simforge-oss/playback/traffic";
import type {
  ScenarioAmbientProvenance,
  ScenarioDocumentDto,
  ScenarioMaterializedTrafficReference,
} from "../../lib/scenario/contracts";
import { contentHash, type MaterializedTrafficArtifactEnvelope } from "@simforge-oss/engine";
import {
  CollisionActorOverrides,
  type PlaybackBundle,
  type PlaybackController,
} from "@simforge-oss/playback";
import { downloadSimulationPreview, encodeSimulationPreview } from "../../lib/scenario/playback/simulationPreview";
import { ScenarioWorkerClient } from "../../lib/scenario/playback/scenarioWorkerClient";
import { usePlayback } from "../../lib/scenario/playback/usePlayback";
import { playbackMapEntry } from "../../lib/scenario/maps";
import type { MapOverlayHandle } from "../../lib/scenario/mapOverlays";
import { useMapSignalOverlays } from "../../lib/scenario/useMapSignalOverlays";
import { loadSumoAssets } from "../../lib/scenario/ambient/sumoAssets";
import { uploadAndConsumeMaterializedTraffic } from "../../lib/scenario/editor/materialized-traffic";
import { normalizeAuthoringGraph } from "@simforge-oss/editor";
import type { ScenarioMapOption } from "../list/document-map-groups";
import {
  mapSupportsScenarioPreview,
  previewAmbientTrafficProfile,
  previewExecutionTrafficProvider,
} from "./previewPolicy";
import { pickRandomMap, preloadMapManifests } from "./mapCatalog";
import {
  ambientProvenanceForRevisionTraffic,
  materializeBrowserRevisionTraffic,
} from "./revisionEvidence";

export type ScenarioRevisionEvidence = {
  readonly ambient: ScenarioAmbientProvenance;
  readonly materializedTraffic: ScenarioMaterializedTrafficReference;
};

export type ScenarioEvidenceRequest = {
  readonly key: string;
};

export type ScenarioSharedPlayback = {
  readonly bundle: PlaybackBundle | null;
  /** Canonical authored-content identity that produced `bundle`; null fails browser capture closed. */
  readonly sourceContentIdentity: string | null;
  readonly controller: ReturnType<typeof usePlayback>["controller"];
  readonly state: ReturnType<typeof usePlayback>["state"];
  readonly error: string | null;
  /** Preparation failure text retained even when no playback controller exists. */
  readonly preparationMessage?: string | null;
  readonly inspecting: boolean;
  readonly setInspecting: (inspecting: boolean) => void;
  /** Status published by the one workspace-owned SUMO runtime. */
  readonly sumoStatus: SumoTrafficStatus;
  readonly setSumoStatus: (status: SumoTrafficStatus) => void;
  readonly collisionActorOverrides?: CollisionActorOverrides;
  /** World-owned traffic-signal furniture, state orbs, picking, and highlights. */
  readonly overlays: MapOverlayHandle | null;
  /**
   * Optional actor-mounted camera that temporarily owns the shared playback
   * view while the Render workspace is previewing or recording. The stable
   * actor/sensor ids remain the authored source of truth; this snapshot only
   * configures the current read-only controller.
   */
  readonly recordingCamera?: ScenarioRecordingCamera | null;
  readonly setRecordingCamera?: (camera: ScenarioRecordingCamera | null) => void;
};

export type ScenarioRecordingCamera = {
  readonly actorId: string;
  readonly sensor: DashCameraSensor;
};

export interface ScenarioSession {
  readonly maps: ScenarioMapOption[] | null;
  readonly map: ScenarioMapOption | null;
  readonly document: ScenarioDocumentDto | null;
  readonly bundle: PlaybackBundle | null;
  readonly message: string | null;
  readonly failed: boolean;
  readonly playback: ScenarioSharedPlayback;
  /** Narrow browser-capture host; it never owns or replaces the persistent world. */
  readonly capture?: {
    readonly viewer: CityViewer | null;
    readonly actorRenderer: ActorRenderer | null;
    readonly loadedMapVersionId: string | null;
  };
  /** Present only while an explicit action is materializing SUMO output. */
  readonly evidenceRequest: ScenarioEvidenceRequest | null;
  prepareRevisionEvidence(documentId: string): Promise<ScenarioRevisionEvidence>;
  completeRevisionEvidence(requestKey: string, artifact: MaterializedTrafficArtifactEnvelope): void;
  failRevisionEvidence(requestKey: string, reason: unknown): void;
  updateDocument(document: ScenarioDocumentDto): void;
}

export class ScenarioSessionResultFence {
  private generation = 0;
  private identity = "";

  begin(identity: string): number {
    this.identity = identity;
    return ++this.generation;
  }

  accepts(generation: number, identity: string): boolean {
    return generation === this.generation && identity === this.identity;
  }

  invalidate(): void {
    this.identity = "";
    this.generation += 1;
  }
}

export function applyScenarioPresentationVisibility(
  controller: Pick<PlaybackController, "setPresentationActive">,
  renderer: Pick<ActorRenderer, "setLayerVisible"> | null,
  playbackActive: boolean,
) {
  controller.setPresentationActive(playbackActive);
  // Browser SUMO owns an independent, warmed authoring frame. Playback may
  // hide its trace while the editor is active, but parked/queued SUMO traffic
  // should remain visible before Play and after Pause.
  if (typeof renderer?.setLayerVisible === "function") {
    renderer.setLayerVisible("sumo-traffic", true);
  }
}

/**
 * Canonical in-memory simulation session for the integrated datasets workspace.
 *
 * The worker and playback controller live for the workspace lifetime. A UI mode
 * change only changes presentation; document identity/content changes are the
 * only inputs that can fetch or compile a scenario.
 */
export function useScenarioSession({
  documentId,
  listPresentationActive,
  viewer,
  actorRenderer,
  loadedMapVersionId,
}: {
  documentId: string | null;
  listPresentationActive: boolean;
  viewer: CityViewer | null;
  actorRenderer: ActorRenderer | null;
  loadedMapVersionId: string | null;
}): ScenarioSession {
  const studioHost = useStudioHost();
  const [maps, setMaps] = useState<ScenarioMapOption[] | null>(null);
  const [map, setMap] = useState<ScenarioMapOption | null>(null);
  const [document, setDocument] = useState<ScenarioDocumentDto | null>(null);
  const [bundle, setBundle] = useState<PlaybackBundle | null>(null);
  const collisionActorOverrides = useMemo(() => new CollisionActorOverrides(), []);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [inspecting, setInspectingState] = useState(false);
  const [recordingCamera, setRecordingCamera] = useState<ScenarioRecordingCamera | null>(null);
  const [sumoStatus, setSumoStatus] = useState<SumoTrafficStatus>(DISABLED_SUMO_STATUS);
  const [evidenceRequest, setEvidenceRequest] = useState<ScenarioEvidenceRequest | null>(null);
  const workerRef = useRef<ScenarioWorkerClient | null>(null);
  /** The one in-flight or completed upload of the current trace, by content identity and saved version. */
  const previewSaveRef = useRef<{ key: string; abort: AbortController } | null>(null);
  const fetchGenerationRef = useRef(0);
  const prepareFenceRef = useRef(new ScenarioSessionResultFence());
  const preparedKeyRef = useRef<string | null>(null);
  /** Simulation identity the worker is compiling right now, so a save landing mid-compile keeps that run. */
  const compilingKeyRef = useRef<string | null>(null);
  const pickedIdleMapRef = useRef(false);
  const evidenceCacheRef = useRef<{ key: string; evidence: ScenarioRevisionEvidence } | null>(null);
  const bundleContentIdentityRef = useRef(new WeakMap<PlaybackBundle, string>());
  const persistedDocumentIdentityRef = useRef<{
    id: string;
    draftVersion: number;
    contentIdentity: string;
  } | null>(null);
  const evidencePendingRef = useRef<{
    key: string;
    promise: Promise<ScenarioRevisionEvidence>;
    resolve: (evidence: ScenarioRevisionEvidence) => void;
    reject: (reason: Error) => void;
    uploading: boolean;
    abort: AbortController;
  } | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    void studioHost.artifacts.listMaps(abort.signal).then(setMaps).catch((reason) => {
      if ((reason as { name?: string } | null)?.name !== "AbortError") setFailed(true);
    });
    return () => abort.abort();
  }, [studioHost, documentId]);

  useEffect(() => {
    if (!maps) return;
    const generation = ++fetchGenerationRef.current;
    if (!documentId) {
      workerRef.current?.cancel();
      prepareFenceRef.current.invalidate();
      preparedKeyRef.current = null;
      compilingKeyRef.current = null;
      persistedDocumentIdentityRef.current = null;
      setDocument(null);
      setBundle(null);
      setMessage(null);
      if (!pickedIdleMapRef.current) {
        pickedIdleMapRef.current = true;
        setMap(pickRandomMap(maps));
      }
      return;
    }
    if (document?.id === documentId) return;

    const abort = new AbortController();
    workerRef.current?.cancel();
    prepareFenceRef.current.invalidate();
    preparedKeyRef.current = null;
    compilingKeyRef.current = null;
    persistedDocumentIdentityRef.current = null;
    setBundle(null);
    setMessage("Preparing scenario preview…");
    void studioHost.projects.getDocument(documentId, abort.signal).then((nextDocument) => {
      if (abort.signal.aborted || generation !== fetchGenerationRef.current) return;
      const canonical = withCanonicalEditorTimeline(nextDocument);
      persistedDocumentIdentityRef.current = {
        id: canonical.id,
        draftVersion: canonical.draftVersion,
        contentIdentity: contentHash(canonical.content),
      };
      setDocument(canonical);
    }).catch((reason) => {
      if (abort.signal.aborted || generation !== fetchGenerationRef.current) return;
      setMessage(reason instanceof Error
        ? `Preview unavailable: ${reason.message}`
        : "Preview unavailable for this scenario.");
    });
    return () => abort.abort();
  }, [document?.id, documentId, maps, studioHost]);

  useEffect(() => {
    if (!maps || !document || document.id !== documentId) return;
    const nextMap = maps.find((candidate) => candidate.mapVersionId === document.mapVersionId) ?? null;
    setMap(nextMap);
    if (!nextMap || !mapSupportsScenarioPreview(nextMap)) {
      workerRef.current?.cancel();
      prepareFenceRef.current.invalidate();
      preparedKeyRef.current = null;
      compilingKeyRef.current = null;
      setBundle(null);
      setMessage("Preview unavailable for this map.");
      return;
    }
    // Everything that determines the trace: authored content and the immutable
    // map. Mode and draft version only decide whether a saved copy may be used.
    const simulationKey = contentHash({
      documentId: document.id,
      content: document.content,
      mapVersionId: nextMap.mapVersionId,
      sourceMapId: nextMap.sourceMapId,
    });
    const sourceContentIdentity = contentHash(document.content);
    const prepareKey = `${listPresentationActive ? "saved" : "editor"}:${simulationKey}:${document.draftVersion}`;
    if (preparedKeyRef.current === prepareKey) return;
    preparedKeyRef.current = prepareKey;
    const worker = () => {
      const client = workerRef.current ?? new ScenarioWorkerClient();
      workerRef.current = client;
      return client;
    };
    const previewRuntime = async () => ({
      engine: await worker().engineIdentity(),
      mapClosureSha256: nextMap.browserClosureSha256,
    });
    // Persist a trace only as the preview of content the server holds at that
    // exact version, once per (content, version). A trace of unsaved edits is
    // never uploaded under the last saved version; the autosave that lands
    // later re-enters this effect and publishes the same in-memory trace.
    const publishPreview = (nextBundle: PlaybackBundle) => {
      const persisted = persistedDocumentIdentityRef.current;
      if (persisted?.id !== document.id || persisted.contentIdentity !== sourceContentIdentity) return;
      const key = `${sourceContentIdentity}:${persisted.draftVersion}`;
      if (previewSaveRef.current?.key === key) return;
      previewSaveRef.current?.abort.abort();
      const abort = new AbortController();
      previewSaveRef.current = { key, abort };
      const target = { id: persisted.id, draftVersion: persisted.draftVersion };
      void previewRuntime()
        .then((runtime) => encodeSimulationPreview(nextBundle, target.draftVersion, runtime))
        .then(({ bytes, sha256 }) => studioHost.projects.saveSimulationPreview(target, bytes, sha256, abort.signal))
        .catch(() => { if (previewSaveRef.current?.key === key) previewSaveRef.current = null; });
    };
    // The exact trace for this content is already on screen: a mode change,
    // a title edit or an autosave echo must not drop it, re-parse it or rebuild
    // the playback controller and its per-actor presentation tables.
    if (bundle && bundleContentIdentityRef.current.get(bundle) === sourceContentIdentity) {
      setMessage(null);
      publishPreview(bundle);
      return;
    }
    // The worker is already computing this exact content (typically the autosave
    // landed mid-compile). Its continuation reads the persisted identity when it
    // resolves, so nothing is cancelled or requested twice.
    if (compilingKeyRef.current === simulationKey) return;
    const generation = prepareFenceRef.current.begin(simulationKey);
    const compileScenarioPreview = () => {
      const client = worker();
      client.cancel();
      compilingKeyRef.current = simulationKey;
      const provider = ambientTrafficProviderFromExtensions(document.content.extensions);
      setBundle(null);
      setMessage("Preparing scenario preview…");
      void client.prepare(
        document.content as ScenarioTemplateV2,
        playbackMapEntry(nextMap),
        previewAmbientTrafficProfile(
          provider,
          document.content.extensions,
          document.content.mapSignalPlans.length > 0,
        ),
        undefined,
        { backgroundPreview: true },
      ).then((nextBundle) => {
        if (compilingKeyRef.current === simulationKey) compilingKeyRef.current = null;
        if (!prepareFenceRef.current.accepts(generation, simulationKey)) return;
        bundleContentIdentityRef.current.set(nextBundle, sourceContentIdentity);
        setBundle(nextBundle);
        setMessage(null);
        publishPreview(nextBundle);
      }).catch((reason) => {
        if (compilingKeyRef.current === simulationKey) compilingKeyRef.current = null;
        if (!prepareFenceRef.current.accepts(generation, simulationKey)
            || (reason as { name?: string } | null)?.name === "AbortError") return;
        setMessage(reason instanceof Error
          ? `Preview unavailable: ${reason.message}`
          : "Preview unavailable for this scenario.");
      });
    };
    setBundle(null);
    setMessage("Preparing scenario preview…");
    // A saved simulation stands in for compilation only when the server holds
    // exactly this content at this version and the copy was produced by this
    // engine build on this map closure; anything else recompiles.
    const persisted = persistedDocumentIdentityRef.current;
    if (persisted?.id !== document.id
        || persisted.draftVersion !== document.draftVersion
        || persisted.contentIdentity !== sourceContentIdentity) {
      compileScenarioPreview();
      return;
    }
    const abort = new AbortController();
    void Promise.all([
      studioHost.projects.getSimulationPreview(document.id, abort.signal),
      previewRuntime(),
    ]).then(async ([descriptor, runtime]) => {
      if (!prepareFenceRef.current.accepts(generation, simulationKey)) return;
      if (!descriptor || descriptor.draftVersion !== document.draftVersion) {
        compileScenarioPreview();
        return;
      }
      const saved = await downloadSimulationPreview(descriptor, runtime, abort.signal);
      if (!prepareFenceRef.current.accepts(generation, simulationKey)) return;
      bundleContentIdentityRef.current.set(saved, sourceContentIdentity);
      previewSaveRef.current = { key: `${sourceContentIdentity}:${document.draftVersion}`, abort: new AbortController() };
      setBundle(saved);
      setMessage(null);
    }).catch((reason) => {
      if (!prepareFenceRef.current.accepts(generation, simulationKey)
          || (reason as { name?: string } | null)?.name === "AbortError") return;
      compileScenarioPreview();
    });
    return () => abort.abort();
  }, [bundle, document, documentId, listPresentationActive, maps, studioHost]);

  useEffect(() => () => { previewSaveRef.current?.abort.abort(); workerRef.current?.dispose(); }, []);

  useEffect(() => {
    if (!bundle) setSumoStatus(DISABLED_SUMO_STATUS);
  }, [bundle]);

  const documentRef = useRef(document);
  documentRef.current = document;
  const sumoPreloadActive = !listPresentationActive && document !== null && previewExecutionTrafficProvider(
    ambientTrafficProviderFromExtensions(document.content.extensions),
    document.content.mapSignalPlans.length > 0,
  ) === "sumo";
  useEffect(() => {
    const current = documentRef.current;
    if (!sumoPreloadActive || !current || !map || !mapSupportsScenarioPreview(map)) return;
    const abort = new AbortController();
    // Start immutable SUMO downloads and XML indexing alongside scenario
    // compilation. The viewport-owned runtime consumes the completed cache
    // once its renderer and height sampler are ready. The cache is keyed by
    // map alone, so only the map or the execution provider restarts this;
    // an edit must not abort a multi-megabyte runtime download mid-flight.
    void loadSumoAssets(
      playbackMapEntry(map),
      ambientTrafficProfileFromExtensions(current.content.extensions),
      fetch,
      [],
      false,
      abort.signal,
    ).catch((reason: unknown) => {
      if ((reason as { name?: string } | null)?.name !== "AbortError") {
        // The owning SUMO surface publishes the actionable failure. Preloading
        // is deliberately silent so it cannot create a duplicate notification.
      }
    });
    return () => abort.abort();
  }, [map, sumoPreloadActive]);

  const bundleReady = bundle !== null;
  useEffect(() => {
    if (!maps?.length || (documentId && !bundleReady)) return;
    const abort = new AbortController();
    const preload = () => {
      void preloadMapManifests(maps, { signal: abort.signal });
    };
    const idleHandle = window.requestIdleCallback?.(preload, { timeout: 5_000 });
    const timeoutHandle = idleHandle === undefined ? window.setTimeout(preload, 4_000) : undefined;
    return () => {
      if (idleHandle !== undefined) window.cancelIdleCallback?.(idleHandle);
      if (timeoutHandle !== undefined) window.clearTimeout(timeoutHandle);
      abort.abort();
    };
  }, [bundleReady, documentId, maps]);

  const sampleHeight = useMemo(
    () => viewer && loadedMapVersionId === map?.mapVersionId
      ? indexedWorldHeightSampler(viewer)
      : null,
    [loadedMapVersionId, map?.mapVersionId, viewer],
  );

  // The persistent world owns one overlay set for the immutable map version.
  // Switching list/editor/playback modes retains the same GPU resources.
  const overlays = useMapSignalOverlays({
    viewer,
    map: map && mapSupportsScenarioPreview(map) ? map : null,
    ready: Boolean(
      map && mapSupportsScenarioPreview(map) && loadedMapVersionId === map.mapVersionId
    ),
  });
  const cameraActorIds = useMemo(
    () => bundle?.actors
      .filter((actor) => !["pedestrian", "animal", "static_object"].includes(actor.kind))
      .map((actor) => actor.id)
      .sort(),
    [bundle],
  );
  const runtimePlayback = usePlayback({
    // The integrated workspace has one renderer owner. Waiting for it avoids a
    // transient, privately-owned playback renderer during WorldHost startup.
    viewer: actorRenderer ? viewer : null,
    bundle,
    sampleHeight,
    overlays,
    // Authoring owns the camera. Scenario recompilation happens after every
    // edit, including object placement, so constructing the background
    // playback controller with an auto-framing policy would move the camera
    // even while its playback layer is hidden.
    cameraPolicy: recordingCamera ? "dash-camera" : "free",
    dashCamera: recordingCamera,
    loop: false,
    cameraActorIds,
    renderer: actorRenderer,
    collisionActorOverrides,
    subscribeState: false,
  });
  const presentationActive = listPresentationActive || inspecting || recordingCamera !== null;
  useEffect(() => {
    const controller = runtimePlayback.controller;
    if (!controller) return;
    applyScenarioPresentationVisibility(
      controller,
      actorRenderer,
      presentationActive,
    );
    // The list scene owns its smooth single-actor focus transition. Keep the
    // controller free so it cannot briefly zoom out to the full scenario first.
    // Entering playback from the editor likewise retains the authored view.
    controller.setCameraPolicy(
      recordingCamera ? "dash-camera" : "free",
    );
  }, [actorRenderer, listPresentationActive, presentationActive, recordingCamera, runtimePlayback.controller]);

  const setInspecting = useCallback((next: boolean) => {
    setInspectingState(next);
    if (!next) runtimePlayback.controller?.pause();
  }, [runtimePlayback.controller]);
  const updateDocument = useCallback((nextDocument: ScenarioDocumentDto) => {
    if (nextDocument.id !== documentId) return;
    const canonical = withCanonicalEditorTimeline(nextDocument);
    const contentIdentity = contentHash(canonical.content);
    if (document && canonical.draftVersion > document.draftVersion) {
      persistedDocumentIdentityRef.current = {
        id: canonical.id,
        draftVersion: canonical.draftVersion,
        contentIdentity,
      };
    }
    // A completed trace belongs to exactly one content identity. A content
    // change drops it so the previous revision's trace is never shown beside
    // new authoring state; a title edit or the autosave echo keeps it.
    setBundle((current) => (
      current && bundleContentIdentityRef.current.get(current) === contentIdentity ? current : null
    ));
    setDocument(canonical);
  }, [document, documentId]);

  const evidenceIdentity = useMemo(() => document && map && bundle
    ? contentHash({
        documentId: document.id,
        draftVersion: document.draftVersion,
        mapVersionId: map.mapVersionId,
        sourceMapId: map.sourceMapId,
        inputHash: bundle.instance.manifest.inputHash,
      })
    : null, [bundle, document, map]);

  const failRevisionEvidence = useCallback((requestKey: string, reason: unknown) => {
    const pending = evidencePendingRef.current;
    if (!pending || pending.key !== requestKey) return;
    pending.abort.abort();
    evidencePendingRef.current = null;
    setEvidenceRequest(null);
    setInspectingState(false);
    runtimePlayback.controller?.pause();
    pending.reject(reason instanceof Error ? reason : new Error(String(reason)));
  }, [runtimePlayback.controller]);

  const completeRevisionEvidence = useCallback((requestKey: string, artifact: MaterializedTrafficArtifactEnvelope) => {
    const pending = evidencePendingRef.current;
    if (!pending || pending.key !== requestKey || pending.uploading
        || requestKey !== evidenceIdentity || !document || !map || !bundle) return;
    if (!mapSupportsScenarioPreview(map)) {
      failRevisionEvidence(requestKey, new Error("The active map is missing its immutable browser runtime closure."));
      return;
    }
    pending.uploading = true;
    const runtimeMap = playbackMapEntry(map);
    const profile = ambientTrafficProfileFromExtensions(document.content.extensions);
    const replaceActorIds = new Set(bundle.ambientTraffic?.actors.map((actor) => actor.id) ?? []);
    void uploadAndConsumeMaterializedTraffic(
      studioHost,
      document,
      artifact,
      artifact.artifact.sourceInputDigest,
      bundle.trace,
      replaceActorIds,
      { signal: pending.abort.signal },
    ).then(({ reference }) => {
      if (evidencePendingRef.current !== pending || requestKey !== evidenceIdentity) return;
      const evidence = {
        ambient: ambientProvenanceForRevisionTraffic(artifact, profile, runtimeMap),
        materializedTraffic: reference,
      } satisfies ScenarioRevisionEvidence;
      evidenceCacheRef.current = { key: requestKey, evidence };
      evidencePendingRef.current = null;
      setEvidenceRequest(null);
      setInspectingState(false);
      runtimePlayback.controller?.pause();
      pending.resolve(evidence);
    }).catch((reason: unknown) => failRevisionEvidence(requestKey, reason));
  }, [bundle, document, evidenceIdentity, failRevisionEvidence, map, runtimePlayback.controller, studioHost]);

  const prepareRevisionEvidence = useCallback((requestedDocumentId: string) => {
    if (!document || !map || !mapSupportsScenarioPreview(map) || !bundle
        || !evidenceIdentity || document.id !== requestedDocumentId) {
      return Promise.reject(new Error("Open this saved scenario in the canonical browser session before preparing revision evidence."));
    }
    const cached = evidenceCacheRef.current;
    if (cached?.key === evidenceIdentity) return Promise.resolve(cached.evidence);
    const existing = evidencePendingRef.current;
    if (existing?.key === evidenceIdentity) return existing.promise;
    if (existing) failRevisionEvidence(existing.key, new Error("Revision evidence preparation was superseded."));

    let resolve!: (evidence: ScenarioRevisionEvidence) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<ScenarioRevisionEvidence>((accept, decline) => {
      resolve = accept;
      reject = decline;
    });
    const pending = {
      key: evidenceIdentity,
      promise,
      resolve,
      reject,
      uploading: false,
      abort: new AbortController(),
    };
    evidencePendingRef.current = pending;
    const requestedProvider = ambientTrafficProviderFromExtensions(document.content.extensions);
    const executionProvider = previewExecutionTrafficProvider(
      requestedProvider,
      document.content.mapSignalPlans.length > 0,
    );
    if (executionProvider === "sumo") {
      setEvidenceRequest({ key: evidenceIdentity });
    } else {
      try {
        const artifact = materializeBrowserRevisionTraffic(
          executionProvider,
          ambientTrafficProfileFromExtensions(document.content.extensions),
          playbackMapEntry(map),
          bundle,
        );
        completeRevisionEvidence(evidenceIdentity, artifact);
      } catch (reason) {
        failRevisionEvidence(evidenceIdentity, reason);
      }
    }
    return promise;
  }, [bundle, completeRevisionEvidence, document, evidenceIdentity, failRevisionEvidence, map]);

  useEffect(() => {
    const pending = evidencePendingRef.current;
    if (pending && pending.key !== evidenceIdentity) {
      failRevisionEvidence(pending.key, new Error("Revision evidence preparation was superseded by another scenario state."));
    }
    if (evidenceCacheRef.current?.key !== evidenceIdentity) evidenceCacheRef.current = null;
  }, [evidenceIdentity, failRevisionEvidence]);

  useEffect(() => () => {
    const pending = evidencePendingRef.current;
    if (!pending) return;
    pending.abort.abort();
    pending.reject(new Error("Revision evidence preparation was canceled."));
    evidencePendingRef.current = null;
  }, []);

  return {
    maps,
    map,
    document,
    bundle,
    message,
    failed,
    playback: {
      bundle,
      sourceContentIdentity: bundle
        ? (bundleContentIdentityRef.current.get(bundle) ?? null)
        : null,
      controller: runtimePlayback.controller,
      state: runtimePlayback.state,
      error: runtimePlayback.error,
      preparationMessage: message,
      inspecting,
      setInspecting,
      sumoStatus,
      setSumoStatus,
      collisionActorOverrides,
      overlays,
      recordingCamera,
      setRecordingCamera,
    },
    capture: { viewer, actorRenderer, loadedMapVersionId },
    evidenceRequest,
    prepareRevisionEvidence,
    completeRevisionEvidence,
    failRevisionEvidence,
    updateDocument,
  };
}

function withCanonicalEditorTimeline(document: ScenarioDocumentDto): ScenarioDocumentDto {
  const content = normalizeAuthoringGraph(document.content).template;
  return content === document.content ? document : { ...document, content };
}
