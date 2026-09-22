"use client";

import { useStudioHost } from "../../host";
import { resolveScenarioMap } from "@simforge-oss/studio-host";
import {
  previewAmbientTrafficProfile,
  previewExecutionTrafficProvider,
} from "@simforge-oss/playback/traffic";
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
import { ambientProfileMissingDefault, ambientTrafficProfileForDocument, ambientTrafficProfileForEditor } from "@simforge-oss/playback/traffic";
import type { ScenarioDocumentDto } from "../../lib/scenario/contracts";
import { contentHash } from "@simforge-oss/engine";
import {
  CollisionActorOverrides,
  type PlaybackBundle,
  type PlaybackController,
} from "@simforge-oss/playback";
import {
  authoritativePlaybackBundle,
  comparableTraceSha256,
  type SimulationVerificationState,
} from "../../lib/scenario/playback/authoritativeSimulation";
import { ScenarioWorkerClient } from "../../lib/scenario/playback/scenarioWorkerClient";
import { usePlayback } from "../../lib/scenario/playback/usePlayback";
import { playbackMapEntry } from "../../lib/scenario/maps";
import type { MapOverlayHandle } from "../../lib/scenario/mapOverlays";
import { useMapSignalOverlays } from "../../lib/scenario/useMapSignalOverlays";
import { loadSumoAssets } from "../../lib/scenario/ambient/sumoAssets";
import { normalizeAuthoringGraph } from "@simforge-oss/editor";
import type { ScenarioMapOption } from "../list/document-map-groups";
import { mapSupportsScenarioPreview } from "./previewPolicy";

/** Per request the host waits this long on a simulation someone else holds. */
const VERIFY_WAIT_MS = 15_000;
/** Queued simulations are awaited for about three minutes before the preview stays "Local preview". */
const VERIFY_ATTEMPTS = 12;

export type { SimulationVerificationState } from "../../lib/scenario/playback/authoritativeSimulation";

export type ScenarioSharedPlayback = {
  readonly bundle: PlaybackBundle | null;
  /** Canonical authored-content identity that produced `bundle`; null fails browser capture closed. */
  readonly sourceContentIdentity: string | null;
  readonly controller: ReturnType<typeof usePlayback>["controller"];
  readonly state: ReturnType<typeof usePlayback>["state"];
  readonly error: string | null;
  /** Preparation failure text retained even when no playback controller exists. */
  readonly preparationMessage?: string | null;
  /**
   * The preview's standing against the host's authoritative simulation of the
   * saved draft: "Local preview" until the authoritative trace for the same
   * content arrives, "Verified" when the digests are equal. A mismatch shows
   * the authoritative trace instead and is reported as a determinism bug.
   * Nothing is uploaded: the host computes the authoritative result itself.
   */
  readonly simulationVerification?: SimulationVerificationState;
  readonly retrySimulationVerification?: () => void;
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
 * Canonical in-memory simulation session for the scenario being edited.
 *
 * The worker and playback controller live for as long as the editor is mounted. Document identity
 * and content are the only inputs that fetch or compile a scenario; presentation changes never do.
 */
export function useScenarioSession({
  documentId,
  viewer,
  actorRenderer,
  loadedMapVersionId,
}: {
  documentId: string | null;
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
  const [simulationVerification, setSimulationVerification] = useState<SimulationVerificationState>({ status: "local" });
  const verifyPreviewRef = useRef<((nextBundle: PlaybackBundle, force?: boolean) => void) | null>(null);
  const workerRef = useRef<ScenarioWorkerClient | null>(null);
  /** The one in-flight or completed verification of the current trace, by content identity and saved version. */
  const verificationRef = useRef<{ key: string; abort: AbortController } | null>(null);
  const fetchGenerationRef = useRef(0);
  const prepareFenceRef = useRef(new ScenarioSessionResultFence());
  const preparedKeyRef = useRef<string | null>(null);
  /** Simulation identity the worker is compiling right now, so a save landing mid-compile keeps that run. */
  const compilingKeyRef = useRef<string | null>(null);
  const bundleContentIdentityRef = useRef(new WeakMap<PlaybackBundle, string>());
  const persistedDocumentIdentityRef = useRef<{
    id: string;
    draftVersion: number;
    contentIdentity: string;
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
      setMap(null);
      setBundle(null);
      setMessage(null);
      setSimulationVerification({ status: "local" });
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
    setSimulationVerification({ status: "local" });
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
    let resolvedMap: ScenarioMapOption | null = null;
    let resolutionError: string | null = null;
    try {
      resolvedMap = resolveScenarioMap(document, maps);
    } catch (reason) {
      resolutionError = reason instanceof Error ? reason.message : String(reason);
    }
    const nextMap = resolvedMap;
    setMap(nextMap);
    setFailed(resolutionError !== null);
    if (!nextMap || !mapSupportsScenarioPreview(nextMap)) {
      workerRef.current?.cancel();
      prepareFenceRef.current.invalidate();
      preparedKeyRef.current = null;
      compilingKeyRef.current = null;
      setBundle(null);
      setMessage(resolutionError ?? "Preview unavailable for this map.");
      return;
    }
    // Everything that determines the trace: authored content and the immutable
    // map. The draft version only decides whether a saved copy may be used.
    const simulationKey = contentHash({
      documentId: document.id,
      content: document.content,
      mapVersionId: nextMap.mapVersionId,
      sourceMapId: nextMap.sourceMapId,
    });
    const sourceContentIdentity = contentHash(document.content);
    const prepareKey = `${simulationKey}:${document.draftVersion}`;
    if (preparedKeyRef.current === prepareKey) return;
    preparedKeyRef.current = prepareKey;
    const worker = () => {
      const client = workerRef.current ?? new ScenarioWorkerClient();
      workerRef.current = client;
      return client;
    };
    // Verify the local preview against the host's authoritative simulation of
    // the saved draft, once per (content, version). Unsaved edits stay "Local
    // preview": the autosave that lands later re-enters this effect and
    // verifies the same in-memory trace. Nothing is uploaded.
    const verifyPreview = (nextBundle: PlaybackBundle, force = false) => {
      const persisted = persistedDocumentIdentityRef.current;
      if (persisted?.id !== document.id || persisted.contentIdentity !== sourceContentIdentity) {
        setSimulationVerification({ status: "local", detail: "Unsaved edits" });
        return;
      }
      const key = `${sourceContentIdentity}:${persisted.draftVersion}`;
      if (!force && verificationRef.current?.key === key) return;
      verificationRef.current?.abort.abort();
      const abort = new AbortController();
      verificationRef.current = { key, abort };
      const current = () => verificationRef.current?.key === key && !abort.signal.aborted;
      const target = { id: persisted.id, draftVersion: persisted.draftVersion };
      setSimulationVerification({ status: "verifying" });
      void (async () => {
        for (let attempt = 0; attempt < VERIFY_ATTEMPTS && current(); attempt += 1) {
          const status = await studioHost.projects.resolveSimulation(target, { waitMs: VERIFY_WAIT_MS, signal: abort.signal });
          if (!current()) return;
          if (status.state === "failed") {
            setSimulationVerification({ status: "unavailable", message: status.message ?? status.failureCode });
            return;
          }
          if (status.state !== "succeeded") {
            setSimulationVerification({ status: "verifying", queued: true });
            continue;
          }
          const result = status.result;
          const localTraceSha256 = nextBundle.traceSha256 ?? null;
          const verified = localTraceSha256 !== null && comparableTraceSha256(result).includes(localTraceSha256);
          const runtime = await worker().engineIdentity().catch(() => null);
          if (localTraceSha256) {
            void studioHost.projects.verifySimulation(result.simKey, {
              documentId: document.id,
              localTraceSha256,
              localRuntime: {
                ...(runtime ? { engineVersion: runtime.engineVersion, abiVersion: runtime.abiVersion } : {}),
                ...(typeof navigator === "undefined" ? {} : { userAgent: navigator.userAgent.slice(0, 400) }),
              },
            }).catch(() => undefined);
          }
          if (verified) {
            setSimulationVerification({
              status: "verified",
              simKey: result.simKey,
              traceSha256: result.traceSha256,
              engineSemVer: result.engineSemVer,
            });
            return;
          }
          // A different trace under the same content is a determinism bug: show
          // the authority's trace (it is what every render and evaluation
          // replays) and keep the mismatch on screen.
          const mismatch = {
            status: "mismatch" as const,
            simKey: result.simKey,
            localTraceSha256,
            authoritativeTraceSha256: result.traceSha256,
          };
          setSimulationVerification({ ...mismatch, showingAuthoritative: false });
          console.error(`[simulation] local preview ${localTraceSha256 ?? "(no digest)"} differs from authoritative ${result.traceSha256} (${result.simKey})`);
          const authoritative = await authoritativePlaybackBundle(result, nextBundle, abort.signal);
          if (!current()) return;
          bundleContentIdentityRef.current.set(authoritative, sourceContentIdentity);
          setBundle(authoritative);
          setSimulationVerification({ ...mismatch, showingAuthoritative: true });
          return;
        }
        if (current()) setSimulationVerification({ status: "local", detail: "Authoritative simulation is still queued" });
      })().catch((reason: unknown) => {
        if (!current() || (reason as { name?: string } | null)?.name === "AbortError") return;
        setSimulationVerification({ status: "unavailable", message: reason instanceof Error ? reason.message : String(reason) });
      });
    };
    verifyPreviewRef.current = verifyPreview;
    // The exact trace for this content is already on screen: a mode change,
    // a title edit or an autosave echo must not drop it, re-parse it or rebuild
    // the playback controller and its per-actor presentation tables.
    if (bundle && bundleContentIdentityRef.current.get(bundle) === sourceContentIdentity) {
      setMessage(null);
      verifyPreview(bundle);
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
      let ambientProfile: ReturnType<typeof previewAmbientTrafficProfile>;
      try {
        ambientProfile = previewAmbientTrafficProfile(
          provider,
          document.content.extensions,
          document.content.mapSignalPlans.length > 0,
          ambientProfileMissingDefault(document.content),
        );
      } catch (reason) {
        // A malformed ambient profile is a validation error, never a silent City fallback.
        if (compilingKeyRef.current === simulationKey) compilingKeyRef.current = null;
        setMessage(`Preview unavailable: ${reason instanceof Error ? reason.message : String(reason)}`);
        return;
      }
      setMessage("Preparing scenario preview…");
      void client.prepare(
        document.content as ScenarioTemplateV2,
        playbackMapEntry(nextMap),
        ambientProfile,
        undefined,
        { backgroundPreview: true },
      ).then((nextBundle) => {
        if (compilingKeyRef.current === simulationKey) compilingKeyRef.current = null;
        if (!prepareFenceRef.current.accepts(generation, simulationKey)) return;
        bundleContentIdentityRef.current.set(nextBundle, sourceContentIdentity);
        setBundle(nextBundle);
        setMessage(null);
        verifyPreview(nextBundle);
      }).catch((reason) => {
        if (compilingKeyRef.current === simulationKey) compilingKeyRef.current = null;
        if (!prepareFenceRef.current.accepts(generation, simulationKey)
            || (reason as { name?: string } | null)?.name === "AbortError") return;
        setMessage(reason instanceof Error
          ? `Preview unavailable: ${reason.message}`
          : "Preview unavailable for this scenario.");
      });
    };
    // The editor always runs its own local simulation: it is instant (the same
    // Rust core, in WASM) and it prepares the live world Play resumes from.
    // The authoritative result is fetched by key and compared, never uploaded.
    compileScenarioPreview();
  }, [bundle, document, documentId, maps, studioHost]);

  useEffect(() => () => {
    verificationRef.current?.abort.abort();
    workerRef.current?.dispose();
  }, []);

  useEffect(() => {
    if (!bundle) setSumoStatus(DISABLED_SUMO_STATUS);
  }, [bundle]);

  const documentRef = useRef(document);
  documentRef.current = document;
  const sumoPreloadActive = document !== null && previewExecutionTrafficProvider(
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
      ambientTrafficProfileForEditor(current.content),
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
  const presentationActive = inspecting || recordingCamera !== null;
  useEffect(() => {
    const controller = runtimePlayback.controller;
    if (!controller) return;
    applyScenarioPresentationVisibility(
      controller,
      actorRenderer,
      presentationActive,
    );
    // Entering playback from the editor retains the authored view, so the
    // controller stays free rather than auto-framing the whole scenario.
    controller.setCameraPolicy(
      recordingCamera ? "dash-camera" : "free",
    );
  }, [actorRenderer, presentationActive, recordingCamera, runtimePlayback.controller]);

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
    if (document && contentIdentity !== contentHash(document.content)) {
      verificationRef.current?.abort.abort();
      verificationRef.current = null;
      setSimulationVerification({ status: "local" });
    }
    setBundle((current) => (
      current && bundleContentIdentityRef.current.get(current) === contentIdentity ? current : null
    ));
    setDocument(canonical);
  }, [document, documentId]);

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
      simulationVerification,
      retrySimulationVerification: () => {
        if (bundle) verifyPreviewRef.current?.(bundle, true);
      },
      setInspecting,
      sumoStatus,
      setSumoStatus,
      collisionActorOverrides,
      overlays,
      recordingCamera,
      setRecordingCamera,
    },
    capture: { viewer, actorRenderer, loadedMapVersionId },
    updateDocument,
  };
}

function withCanonicalEditorTimeline(document: ScenarioDocumentDto): ScenarioDocumentDto {
  const content = normalizeAuthoringGraph(document.content).template;
  return content === document.content ? document : { ...document, content };
}
