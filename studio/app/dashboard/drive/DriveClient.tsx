"use client";

import { studioHost } from "@/app/lib/host";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Camera,
  CircleDot,
  Eye,
  LayoutGrid,
  LogIn,
  LogOut,
  Map as MapIcon,
  RotateCcw,
  Save,
  Trash2,
  Video,
} from "lucide-react";
import type {
  EditorController,
  EditorDocument,
  EditorState,
  ScenarioMapEntry,
} from "@simforge-oss/editor";
import type { ScenarioTemplateV2 } from "@simforge-oss/scenario";
import type { CityViewerOptions } from "@simforge-oss/viewer";
import { CityViewer } from "@simforge-oss/viewer";
import { CityView } from "@simforge-oss/viewer/react";
import { toast } from "sonner";
import { contentHash } from "@simforge-oss/engine";

import { TopBarActionsPortal, TopBarTrailingPortal } from "@simforge-oss/studio-ui/components/TopBarSlot";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import { cn } from "@simforge-oss/studio-ui/lib/utils";
import { AUTHORING_QUALITY, defaultAuthoringQuality } from "@simforge-oss/studio-ui/scenario/editor/authoring-quality";
import { EditorConfigurationBlockProvider } from "@simforge-oss/studio-ui/scenario/editor/inspector/EditorDetailsPanel";
import { EditorOverlayHost } from "@simforge-oss/studio-ui/scenario/editor/inspector/EditorOverlayHost";
import {
  EditorOverlayProvider,
  useEditorOverlay,
} from "@simforge-oss/studio-ui/scenario/editor/inspector/editor-overlay-selection";
import { ActorLibraryRail } from "@simforge-oss/studio-ui/scenario/editor/regions/ActorLibraryRail";
import type { ViewportTool } from "@simforge-oss/studio-ui/scenario/editor/regions/actor-catalog";
import { EditorHeader } from "@simforge-oss/studio-ui/scenario/editor/regions/EditorHeader";
import { EditorModeBanner } from "@simforge-oss/studio-ui/scenario/editor/regions/EditorModeBanner";
import { PlacementCursorHint } from "@simforge-oss/studio-ui/scenario/editor/regions/PlacementCursorHint";
import { ScenarioTimelineDock } from "@simforge-oss/studio-ui/scenario/editor/ScenarioTimelineDock";
import {
  timelineActorLabels,
  type V1TimelineBrowserPlayback,
} from "@simforge-oss/studio-ui/scenario/editor/timeline/V1TimelineRail";
import { ScenarioEditorReadout, ScenarioEditorShell } from "@simforge-oss/studio-ui/scenario/editor/shell";
import {
  MANUAL_DRIVE_TAKE_QUERY,
  useManualDriveTakeSession,
  type ManualDriveTakeSession,
} from "@simforge-oss/studio-ui/scenario/editor/manual-drive/take-handoff";
import { useDriveAmbientTraffic } from "@/app/lib/scenario/ambient/useDriveAmbientTraffic";
import { createMultiplexedCameraFeeds, type CameraFeeds } from "@/app/lib/live-world/camera-feeds";
import {
  createAuthoredWorldSource,
  type AuthoredWorldSource,
} from "@/app/lib/live-world/authored-world-source";
import type { AuthoredDriveMode, ManualDriveRecording } from "@/app/lib/live-world/authored-world-session";
import { createRemoteWorldSource } from "@/app/lib/live-world/remote-world-source";
import { createTruthViewerBridge, type TruthViewerBridge } from "@/app/lib/live-world/truth-viewer-bridge";
import type {
  WorldClock,
  WorldReplayCapabilities,
  WorldSource,
  WorldSourceStatus,
} from "@/app/lib/live-world/types";
import { useWorldSource } from "@/app/lib/live-world/use-world-source";
import type { LocalMapDescriptor } from "@/app/lib/cloud/maps";
import { useStudioCloudStatus } from "@/app/lib/host/cloud";
import type { ScenarioAuthoringQuality } from "@/app/lib/scenario/contracts";
import { useEditorRuntime } from "@simforge-oss/studio-ui/lib/scenario/editor/use-editor-runtime";
import { EditorSceneEnvironmentBridge } from "@simforge-oss/studio-ui/scenario/editor/EditorSceneEnvironmentBridge";
import { PoleCameraGrid } from "./cameras/PoleCameraGrid";
import { DriveMapChooser, driveMapUsable } from "./DriveMapChooser";
import { DrivingControls } from "./DrivingControls";
import { HistoryDock } from "./history/HistoryDock";
import { usePoleCameras } from "./pole-cameras";
import { actorSpeedKph, formatClipTime } from "./drive-telemetry";

type DriveView = "world" | "cameras";
/** Chase and dash follow the ego; free hands the orbit camera back to the operator. */
type CameraMode = "chase" | "dash" | "free";

type ControlTarget = { source: WorldSource | null; actorId: string | null };
const NO_CONTROL_TARGET: ControlTarget = { source: null, actorId: null };
const MAP_QUERY = "map";

/**
 * Page entry: a `?manualDriveTake=` id resolves to the editor's take session
 * (null when absent or unknown — then this is an ordinary drive page).
 */
export function DriveEntry({ maps }: { maps: LocalMapDescriptor[] }) {
  const searchParams = useSearchParams();
  const take = useManualDriveTakeSession(searchParams.get(MANUAL_DRIVE_TAKE_QUERY));
  return <DriveClient maps={maps} take={take} />;
}

/**
 * `take`: a "Manual drive" take opened from the scenario editor. The editor
 * owns the document transaction; Drive owns the wheel, the world and the
 * recording, and echoes `revision` back untouched.
 */
export function DriveClient({ maps, take = null }: { maps: LocalMapDescriptor[]; take?: ManualDriveTakeSession | null }) {
  const router = useRouter();
  const cloudState = useStudioCloudStatus().status?.state;
  const [directMap, setDirectMap] = useState<{ map: ScenarioMapEntry | null; error: string | null } | null>(null);
  const [activeMap, setActiveMap] = useState<ScenarioMapEntry | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [controlTarget, setControlTarget] = useState<ControlTarget>(NO_CONTROL_TARGET);
  // Read after hydration: the server render has no query string, and a
  // pre-selected map in the chooser must not differ between the two.
  const [requestedMapId, setRequestedMapId] = useState<string | null>(take?.mapVersionId ?? null);
  useEffect(() => {
    if (take) return;
    setRequestedMapId(new URLSearchParams(window.location.search).get(MAP_QUERY));
  }, [take]);

  // A direct bundle bypasses the catalog entirely (un-ingested maps, see README).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const manifestOverride = params.get("manifest") ?? process.env.NEXT_PUBLIC_DRIVE_MAP_MANIFEST_URL ?? null;
    const lanesOverride = params.get("lanes") ?? process.env.NEXT_PUBLIC_DRIVE_MAP_LANES_URL ?? null;
    if (!manifestOverride) return;
    try {
      setDirectMap({
        map: directMapEntry({ manifestUrl: manifestOverride, topologyUrl: lanesOverride, label: params.get("label") ?? "Direct bundle" }),
        error: null,
      });
    } catch (error) {
      const message = errorMessage(error);
      setDirectMap({ map: null, error: message });
      toast.error("Drive could not use the direct map bundle", { description: message });
    }
  }, []);

  // Authorization changes re-read the catalog, exactly as the Maps app does.
  useEffect(() => {
    if (cloudState && cloudState !== "connecting") router.refresh();
  }, [cloudState, router]);

  const openMap = useCallback(async (mapVersionId: string, signal?: AbortSignal) => {
    setOpening(mapVersionId);
    setNotice(null);
    try {
      // The usable catalog is the server's decision: installed closure and
      // current authorization. Drive never assembles a map entry itself.
      const entry = (await studioHost.artifacts.listMaps(signal, { fresh: true }))
        .find((candidate) => candidate.mapVersionId === mapVersionId);
      if (!entry) throw new Error("This map is not prepared or authorized on this computer.");
      if (signal?.aborted) return;
      setActiveMap(entry);
      const url = new URL(window.location.href);
      url.searchParams.set(MAP_QUERY, mapVersionId);
      window.history.replaceState(window.history.state, "", url);
    } catch (error) {
      if (signal?.aborted) return;
      const message = errorMessage(error);
      setNotice(message);
      if (take) {
        toast.error("Manual drive take could not open its map", { description: message });
        take.onCancel();
      } else {
        toast.error("Drive could not open the map", { description: message });
      }
    } finally {
      if (!signal?.aborted) setOpening(null);
    }
  }, [take]);

  // Deep link (`?map=`) or an editor take: open the requested map directly,
  // through the same gate as an explicit choice.
  useEffect(() => {
    if (!requestedMapId || activeMap || directMap) return;
    const controller = new AbortController();
    void openMap(requestedMapId, controller.signal);
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per requested id
  }, [requestedMapId]);

  // Loss of access: a fresh catalog that no longer allows the active map
  // disposes the world (DriveSurface unmount) and returns to the chooser.
  useEffect(() => {
    if (!activeMap) return;
    const descriptor = maps.find((map) => map.mapVersionId === activeMap.mapVersionId);
    if (descriptor && driveMapUsable(descriptor, cloudState)) return;
    if (cloudState === undefined || cloudState === "connecting") return;
    setActiveMap(null);
    setNotice(`${activeMap.label} is no longer available on this computer; the world was closed.`);
    if (take) take.onCancel();
  }, [activeMap, cloudState, maps, take]);

  const leaveMap = useCallback(() => {
    setActiveMap(null);
    const url = new URL(window.location.href);
    url.searchParams.delete(MAP_QUERY);
    window.history.replaceState(window.history.state, "", url);
  }, []);

  const surfaceMap = directMap?.map ?? activeMap;
  const takeRecord = useMemo(
    () => take ? { id: take.documentId, content: take.content } : null,
    [take],
  );

  return (
    <div className="relative flex h-full min-h-0">
      <div className="min-h-0 min-w-0 flex-1">
        {surfaceMap ? (
          <DriveSurface
            key={surfaceMap.mapVersionId}
            map={surfaceMap}
            record={takeRecord}
            take={take}
            onLeave={directMap ? null : leaveMap}
            onControlTarget={setControlTarget}
          />
        ) : directMap?.error ? (
          <div className="grid h-full min-h-0 place-items-center bg-background text-sm text-destructive" role="alert">
            {directMap.error}
          </div>
        ) : take ? (
          <div className="grid h-full min-h-0 place-items-center gap-3 bg-background text-sm text-muted-foreground" role={notice ? "alert" : "status"}>
            <span>{notice ?? `Opening the take's map…`}</span>
            {notice ? (
              <Button type="button" size="sm" variant="outline" onClick={take.onCancel}>Back to the editor</Button>
            ) : null}
          </div>
        ) : (
          <DriveMapChooser
            maps={maps}
            initialMapVersionId={requestedMapId}
            opening={opening}
            notice={notice}
            onDrive={(map) => void openMap(map.mapVersionId)}
          />
        )}
      </div>
      {/* Mounted once for the life of the page so device choice and wheel
          calibration survive map changes; it only transmits with an ego. */}
      <div
        className={cn(
          "pointer-events-none z-20 w-80 shrink-0",
          surfaceMap ? "absolute bottom-4 right-4 max-h-[calc(100%-6rem)] overflow-auto" : "border-l border-white/10 bg-[#07100d] p-3",
        )}
        data-testid="driving-controls-dock"
      >
        <DrivingControls source={controlTarget.source} actorId={controlTarget.actorId} />
      </div>
    </div>
  );
}

type TakePhase =
  | { kind: "idle" }
  | { kind: "recording" }
  | { kind: "review"; recording: ManualDriveRecording; sourceRevision: number }
  | { kind: "saving" };

function DriveSurface({ map, record, take, onLeave, onControlTarget }: {
  map: ScenarioMapEntry;
  record: { id: string; content: ScenarioTemplateV2 } | null;
  take: ManualDriveTakeSession | null;
  onLeave: (() => void) | null;
  onControlTarget: (target: ControlTarget) => void;
}) {
  const [source, setSource] = useState<WorldSource | null>(null);
  const [authoredSource, setAuthoredSource] = useState<AuthoredWorldSource | null>(null);
  const [sourceCreationError, setSourceCreationError] = useState<string | null>(null);
  const [viewer, setViewer] = useState<CityViewer | null>(null);
  const [bridge, setBridge] = useState<TruthViewerBridge | null>(null);
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [quality, setQuality] = useState<ScenarioAuthoringQuality>("high");
  const [view, setView] = useState<DriveView>("world");
  const [cameraFeeds, setCameraFeeds] = useState<CameraFeeds | null>(null);
  const [clock, setClock] = useState<WorldClock | null>(null);
  const [replay, setReplay] = useState<WorldReplayCapabilities | null>(null);
  const [replayError, setReplayError] = useState<string | null>(null);
  const [cameraMode, setCameraMode] = useState<CameraMode>("chase");
  const [egoActorId, setEgoActorId] = useState<string | null>(null);
  const [egoActorLabel, setEgoActorLabel] = useState<string | null>(null);
  const [cameraNotice, setCameraNotice] = useState<string | null>(null);
  const [driving, setDriving] = useState(false);
  const [driveMode, setDriveMode] = useState<AuthoredDriveMode>("free");
  const [enteringDrive, setEnteringDrive] = useState(false);
  const [takePhase, setTakePhase] = useState<TakePhase>({ kind: "idle" });
  const [expandedTool, setExpandedTool] = useState<ViewportTool | null>(null);
  const [transportRevision, setTransportRevision] = useState(0);
  const [documentRevision, setDocumentRevision] = useState(0);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const preparedDocumentHashRef = useRef<string | null>(null);
  const sourceRevisionRef = useRef(0);
  const remoteWorld = useMemo(() => resolveRemoteWorld(), []);
  const world = useWorldSource(source);
  const transport = authoredSource?.transport ?? null;
  const poleCameras = usePoleCameras(map.browserManifestUrl);
  const onDocumentChange = useCallback((document: EditorDocument) => {
    const nextHash = contentHash(document.data);
    if (preparedDocumentHashRef.current === nextHash) return;
    preparedDocumentHashRef.current = nextHash;
    setDocumentRevision((revision) => revision + 1);
  }, []);

  useEffect(() => setQuality(defaultAuthoringQuality()), []);

  const runtime = useEditorRuntime({
    record,
    map,
    viewer,
    runtimeReady: mapLoaded,
    hostRef,
    onDocumentChange,
  });
  const { controller, editorDocument, state } = runtime;
  const selectedActor = state?.actors.find((actor) => state.selection.includes(actor.id)) ?? null;
  const selectedVehicleRole = selectedActor
    ? editorDocument?.data.roles.find((role) => role.id === selectedActor.id && isVehicleRole(role)) ?? null
    : null;
  // A take is bound to its role; otherwise the selected vehicle, else the best authored runway.
  const availableEgoActorId = authoredSource?.selectEgo(take?.actorRoleId ?? selectedVehicleRole?.id) ?? null;
  const takeEgoMismatch = take && authoredSource && availableEgoActorId
    ? authoredSource.roleIdForActor(availableEgoActorId) !== take.actorRoleId
    : false;

  useEffect(() => {
    if (!remoteWorld && !editorDocument) return;
    let disposed = false;
    let live: WorldSource | null = null;
    preparedDocumentHashRef.current = editorDocument ? contentHash(editorDocument.data) : null;
    setSourceCreationError(null);
    setSource(null);
    setAuthoredSource(null);
    setTakePhase({ kind: "idle" });
    const open = async () => remoteWorld
      ? createRemoteWorldSource({ truthUrl: `${remoteWorld}/twin`, commandUrl: `${remoteWorld}/drive` })
      : createAuthoredWorldSource({ document: editorDocument!, map, tickHz: 20 });
    void open()
      .then((nextSource) => {
        if (disposed) return nextSource.close();
        live = nextSource;
        sourceRevisionRef.current += 1;
        setSource(nextSource);
        setAuthoredSource(remoteWorld ? null : nextSource as AuthoredWorldSource);
      })
      .catch((error: unknown) => {
        if (disposed) return;
        const message = errorMessage(error);
        setSourceCreationError(message);
        toast.error("Drive world could not start", { description: message });
      });
    return () => {
      disposed = true;
      setSource(null);
      setAuthoredSource(null);
      live?.close();
    };
  }, [documentRevision, editorDocument, map, remoteWorld]);

  useEffect(() => {
    if (!authoredSource) return;
    setTransportRevision((revision) => revision + 1);
    return authoredSource.subscribeTransport(() => setTransportRevision((revision) => revision + 1));
  }, [authoredSource]);

  useEffect(() => {
    if (!source?.subscribeWarnings) return;
    return source.subscribeWarnings((message) => {
      toast.warning("Drive world notice", { description: message, duration: 12000 });
    });
  }, [source]);

  useEffect(() => {
    if (!source?.subscribeClock) {
      setClock(null);
      return;
    }
    return source.subscribeClock(setClock);
  }, [source]);

  useEffect(() => {
    if (!source?.subscribeReplay) {
      setReplay(null);
      setReplayError(null);
      return;
    }
    return source.subscribeReplay((capabilities, error) => {
      setReplay(capabilities);
      setReplayError(error);
    });
  }, [source]);

  useEffect(() => {
    if (!remoteWorld) {
      setCameraFeeds(null);
      return;
    }
    const feeds = createMultiplexedCameraFeeds({ url: `${remoteWorld}/camera-feeds` });
    setCameraFeeds(feeds);
    return () => {
      setCameraFeeds(null);
      feeds.close();
    };
  }, [remoteWorld]);

  // Reuses Studio's browser SUMO lifecycle. Without this the rail's Traffic tool
  // was a dead affordance: it advertised availability but nothing mounted the
  // ambient runtime, so selecting SUMO produced no traffic and no error.
  const ambientTraffic = useDriveAmbientTraffic({
    document: editorDocument,
    map,
    viewer,
    mapLoaded,
    latestFrame: world.latestFrame,
    mode: transport?.playing ? "playing" : transport?.inspecting ? "paused" : "authoring",
    time: transport?.time ?? 0,
    onFallback: (reason) => toast.error("SUMO unavailable", { description: reason }),
  });

  useEffect(() => {
    if (!bridge || !source) return;
    return source.subscribeFrames((frame) => bridge.apply(frame));
  }, [bridge, source]);
  const followingEgo = driving && !transport?.completed && cameraMode !== "free";
  useEffect(() => {
    if (!bridge) return;
    bridge.setFollow(followingEgo ? egoActorId : null, cameraMode === "dash" ? "dash" : "chase");
  }, [bridge, cameraMode, egoActorId, followingEgo, transportRevision]);
  useEffect(() => () => bridge?.dispose(), [bridge]);

  // The wheel/keyboard owner transmits only with an active ego; a map change
  // or an exited drive hands it `null` and it neutralises on its own.
  useEffect(() => {
    onControlTarget({ source, actorId: driving ? egoActorId : null });
    return () => onControlTarget(NO_CONTROL_TARGET);
  }, [driving, egoActorId, onControlTarget, source]);

  const onViewerReady = useCallback((readyViewer: CityViewer) => {
    setViewer(readyViewer);
    setBridge(createTruthViewerBridge(readyViewer, { layer: "drive-live", groundLift: true }));
    setViewerError(null);
  }, []);

  // Entering a free drive or a clip drive resumes the world in place. A take
  // starts only from `beginTake`, which rebuilds the world at t = 0.
  useEffect(() => {
    if (!driving || !authoredSource || !egoActorId || take) return;
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => authoredSource.transport.play());
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
    };
  }, [authoredSource, driving, egoActorId, take]);

  const selectActor = useCallback((actorId: string | null) => {
    setExpandedTool(null);
    controller?.setSelection(actorId ? [actorId] : []);
  }, [controller]);
  const selectLibraryTool = useCallback((tool: ViewportTool | null) => {
    setExpandedTool(tool);
    if (tool) controller?.setSelection([]);
  }, [controller]);

  const enterDrive = useCallback((mode: AuthoredDriveMode) => {
    if (!authoredSource || !viewer || !editorDocument || enteringDrive) return;
    setEnteringDrive(true);
    try {
      const selectedRole = selectedVehicleRole;
      const actorId = availableEgoActorId;
      if (!actorId) throw new Error("Place an authored vehicle before entering drive");
      if (takeEgoMismatch) throw new Error("The take's vehicle is not a controllable actor in this document");
      authoredSource.setEgo(actorId, mode);
      setDriveMode(mode);
      setEgoActorId(actorId);
      const roleId = authoredSource.roleIdForActor(actorId);
      const role = editorDocument.data.roles.find((candidate) => candidate.id === roleId)
        ?? (selectedRole && isVehicleRole(selectedRole) ? selectedRole : null)
        ?? editorDocument.data.roles.find(isVehicleRole)
        ?? null;
      const timelineLabel = role
        ? timelineActorLabels(editorDocument.data.roles).get(role.id)
        : null;
      setEgoActorLabel(timelineLabel ?? role?.label ?? actorId);
      setCameraNotice(null);
      // A take is the driver's own view of the vehicle; free driving keeps the
      // last camera choice. Either can be changed from the top bar afterwards.
      if (mode === "take") setCameraMode("dash");
      setExpandedTool(null);
      setDriving(true);
    } catch (error) {
      toast.error("Drive mode could not start", { description: errorMessage(error) });
    } finally {
      setEnteringDrive(false);
    }
  }, [
    authoredSource,
    availableEgoActorId,
    editorDocument,
    enteringDrive,
    selectedVehicleRole,
    takeEgoMismatch,
    viewer,
  ]);

  const exitDrive = useCallback(() => {
    // Clearing UI state happens in `finally` because any of these calls can
    // throw -- the authored source rejects control once the ego is released or
    // the clip has completed. A throw here previously aborted the rest of the
    // teardown, leaving `driving` true, the button stuck on "Exit drive" and
    // re-entry blocked until a reload.
    try {
      bridge?.setFollow(null);
      if (source && egoActorId) {
        source.control({ actorId: egoActorId, steer: 0, throttle: 0, brake: 0 });
      }
      authoredSource?.setEgo(null);
    } catch (error) {
      toast.warning("Drive released with a warning", { description: errorMessage(error) });
    } finally {
      setDriving(false);
      setEgoActorId(null);
      setEgoActorLabel(null);
      setCameraNotice(null);
      setTakePhase({ kind: "idle" });
    }
  }, [authoredSource, bridge, egoActorId, source]);

  // A world that errored or a map that stopped serving assets (revoked access,
  // closed service) cannot be driven: release the ego so controls go neutral.
  const worldLost = world.status === "error" || world.status === "closed" || Boolean(viewerError);
  useEffect(() => {
    if (driving && worldLost) exitDrive();
  }, [driving, exitDrive, worldLost]);

  const switchView = useCallback((next: DriveView) => {
    if (next === "cameras" && driving) exitDrive();
    setView(next);
  }, [driving, exitDrive]);

  /** Back to t = 0 and rolling: a fresh take, or a replay of the clip/free world. */
  const restartDrive = useCallback(() => {
    if (!authoredSource) return;
    try {
      if (take) {
        authoredSource.beginTake();
        setTakePhase({ kind: "recording" });
      } else {
        authoredSource.transport.reset();
        authoredSource.transport.play();
      }
      setCameraNotice(null);
    } catch (error) {
      toast.error("Drive could not restart", { description: errorMessage(error) });
    }
  }, [authoredSource, take]);

  useEffect(() => {
    if (!authoredSource || !take) return;
    const revision = sourceRevisionRef.current;
    return authoredSource.subscribeTakes((event) => {
      if (event.kind === "failed") {
        setTakePhase({ kind: "idle" });
        toast.error("Take discarded", { description: event.message });
        return;
      }
      setTakePhase({ kind: "review", recording: event.recording, sourceRevision: revision });
    });
  }, [authoredSource, take]);

  // The input owner neutralises and disengages whenever the window loses
  // focus or the tab is hidden. A take must not keep recording a coasting
  // ego through that, so the world pauses too (the sim clock is
  // authoritative, so pausing loses nothing) and the operator resumes explicitly.
  const takeRecording = Boolean(take) && takePhase.kind === "recording";
  useEffect(() => {
    if (!takeRecording || !authoredSource) return;
    const pause = () => {
      if (authoredSource.transport.playing) authoredSource.transport.stop();
    };
    const onVisibility = () => {
      if (document.visibilityState !== "visible") pause();
    };
    window.addEventListener("blur", pause);
    window.addEventListener("pagehide", pause);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("blur", pause);
      window.removeEventListener("pagehide", pause);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [authoredSource, takeRecording]);

  const saveTake = useCallback(async () => {
    if (!take || takePhase.kind !== "review") return;
    // The document was edited or recompiled since this take ran: its samples
    // no longer describe this scenario. Never hand a stale take to the editor.
    if (takePhase.sourceRevision !== sourceRevisionRef.current) {
      setTakePhase({ kind: "idle" });
      toast.error("Take is stale", { description: "The scenario changed while the take was being reviewed. Drive it again." });
      return;
    }
    setTakePhase({ kind: "saving" });
    try {
      await take.onSave(takePhase.recording, take.revision);
    } catch (error) {
      setTakePhase({ kind: "review", recording: takePhase.recording, sourceRevision: takePhase.sourceRevision });
      toast.error("Take could not be saved", { description: errorMessage(error) });
    }
  }, [take, takePhase]);

  const discardTake = useCallback(() => {
    exitDrive();
    take?.onCancel();
  }, [exitDrive, take]);

  const driveSpeedKph = actorSpeedKph(world.latestFrame, driving ? egoActorId : null);
  const driveTime = transport
    ? driveMode === "free" ? `${Math.max(0, transport.time).toFixed(1)} s` : formatClipTime(transport.time, transport.duration)
    : null;
  useEffect(() => {
    if (!driving || !bridge || !egoActorId || !world.latestFrame || transport?.completed) return;
    const followedActorIsPresent = world.latestFrame.scene.actors.some(
      (actor) => actor.id === egoActorId && actor.kind !== "despawn",
    );
    if (followedActorIsPresent || cameraNotice) return;
    bridge.setFollow(null);
    setCameraNotice(`Driving view released because ${egoActorLabel ?? "the ego vehicle"} is unavailable.`);
  }, [
    bridge,
    cameraNotice,
    driving,
    egoActorId,
    egoActorLabel,
    transport?.completed,
    world.latestFrame,
  ]);
  const timelinePlayback = useMemo<V1TimelineBrowserPlayback | null>(() => {
    if (!transport) return null;
    return {
      sessionId: transport.sessionId,
      playing: transport.playing,
      inspecting: transport.inspecting || transport.playing || driving,
      time: transport.time,
      onPlay: () => transport.play(),
      onStop: () => transport.stop(),
      onReset: () => transport.reset(),
      onPlayPause: () => transport.playPause(),
      onSeek: (seconds) => transport.seek(seconds),
      onExitInspection: () => transport.exitInspection(),
    };
  }, [driving, transport, transportRevision]);

  const effectiveStatus: WorldSourceStatus = sourceCreationError || runtime.error
    ? "error"
    : world.status;
  const effectiveError = sourceCreationError ?? runtime.error ?? world.error;
  const driveUnavailableReason = authoredSource && !availableEgoActorId
    ? take
      ? "The take's vehicle is not present in this scenario."
      : "Place an authored vehicle and wait for it to finish preparing before entering drive."
    : takeEgoMismatch
      ? "The take's vehicle is not a controllable actor in this document."
      : null;
  const canEnterDrive = Boolean(authoredSource && viewer && world.status === "running" && availableEgoActorId && !takeEgoMismatch && !enteringDrive);
  const takeComplete = Boolean(take && driving && takePhase.kind !== "idle" && takePhase.kind !== "recording");
  const clipEnded = Boolean(transport?.completed);
  const editingLocked = driving || Boolean(take);

  return (
    <EditorConfigurationBlockProvider blocked={editingLocked}>
      <EditorOverlayProvider
        documentKey={editorDocument}
        selectedActorId={selectedActor?.id ?? null}
        suppressActorDetails={editingLocked || state?.mode === "drawingRoute"}
        onSelectActor={selectActor}
      >
        <EditorHeader
          document={editorDocument}
          quality={quality}
          onQualityChange={setQuality}
          viewer={viewer}
          experience="advanced"
        />
        <TopBarActionsPortal>
          <div className="flex items-center gap-1" aria-label="Drive view">
            {onLeave ? (
              <Button type="button" size="sm" variant="ghost" onClick={() => { if (driving) exitDrive(); onLeave(); }} title="Choose another map">
                <MapIcon /> {map.label}
              </Button>
            ) : null}
            <Button type="button" size="sm" variant={view === "world" ? "secondary" : "ghost"} onClick={() => switchView("world")} aria-pressed={view === "world"}>
              <LayoutGrid /> World
            </Button>
            <Button type="button" size="sm" variant={view === "cameras" ? "secondary" : "ghost"} onClick={() => switchView("cameras")} aria-pressed={view === "cameras"}>
              <Video /> Cameras
            </Button>
          </div>
        </TopBarActionsPortal>
        <TopBarTrailingPortal>
          {view === "world" ? (
            <div className="flex items-center gap-1">
              {driving ? (
                <>
                  <div className="flex items-center gap-0.5" role="group" aria-label="Driving camera">
                    <Button type="button" size="sm" variant={cameraMode === "chase" ? "secondary" : "ghost"} aria-pressed={cameraMode === "chase"} onClick={() => setCameraMode("chase")}>
                      <Camera /> Chase
                    </Button>
                    <Button type="button" size="sm" variant={cameraMode === "dash" ? "secondary" : "ghost"} aria-pressed={cameraMode === "dash"} onClick={() => setCameraMode("dash")}>
                      <Camera /> Dash
                    </Button>
                    <Button type="button" size="sm" variant={cameraMode === "free" ? "secondary" : "ghost"} aria-pressed={cameraMode === "free"} onClick={() => setCameraMode("free")}>
                      <Eye /> Free
                    </Button>
                  </div>
                  <Button type="button" size="sm" variant="outline" onClick={restartDrive} disabled={takePhase.kind === "saving"} title={take ? "Restart the take from the beginning" : "Restart the world from the beginning"}>
                    <RotateCcw /> {take ? "Restart take" : "Restart"}
                  </Button>
                  {take ? (
                    <Button type="button" size="sm" variant="secondary" onClick={discardTake} disabled={takePhase.kind === "saving"}>
                      <LogOut /> Discard & leave
                    </Button>
                  ) : (
                    <Button type="button" size="sm" variant="secondary" onClick={exitDrive}>
                      <LogOut /> Exit drive
                    </Button>
                  )}
                </>
              ) : take ? (
                <>
                  <Button type="button" size="sm" disabled={!canEnterDrive} title={driveUnavailableReason ?? undefined} onClick={() => enterDrive("take")}>
                    <CircleDot /> {enteringDrive ? "Entering…" : "Take the wheel"}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={take.onCancel}>
                    <LogOut /> Cancel take
                  </Button>
                </>
              ) : (
                <>
                  <Button type="button" size="sm" disabled={!canEnterDrive} title={driveUnavailableReason ?? "Drive the live world with no time limit"} onClick={() => enterDrive("free")}>
                    <LogIn /> {enteringDrive ? "Entering…" : "Free drive"}
                  </Button>
                  <Button type="button" size="sm" variant="outline" disabled={!canEnterDrive} title={driveUnavailableReason ?? `Drive the authored ${transport ? transport.duration.toFixed(0) : ""} s clip; the world parks at its end`} onClick={() => enterDrive("take")}>
                    <CircleDot /> Drive clip
                  </Button>
                </>
              )}
            </div>
          ) : null}
        </TopBarTrailingPortal>
        {/* The authored document owns weather and time of day. Drive previously
            applied its own fixed-daylight environment here, which silently
            overwrote every change made in the Weather panel: the document
            updated, then the override repainted the scene. */}
        <EditorSceneEnvironmentBridge
          active={mapLoaded}
          actorRenderer={bridge?.actors ?? null}
          document={editorDocument}
          quality={quality}
          viewer={viewer}
        />
        <ScenarioEditorShell
          className="h-full min-h-0 bg-background text-foreground"
          data-testid="drive-surface"
          canvasMode="interactive"
          header={null}
          leftSidebar={view === "world" && !editingLocked ? (slotProps) => (
            <div {...slotProps} className={cn(slotProps.className, "flex h-full")}>
              <ActorLibraryRail
                controller={controller}
                state={state}
                hostRef={hostRef}
                canvas={viewer?.renderer.domElement ?? null}
                activeTool={expandedTool}
                onExpandedToolChange={selectLibraryTool}
                document={editorDocument}
                trafficDetails={ambientTraffic.trafficDetails}
                sumoAvailable={ambientTraffic.sumoAvailable}
                sumoStatus={ambientTraffic.sumoStatus}
              />
            </div>
          ) : null}
          canvas={(slotProps) => (
            <div {...slotProps} className={cn(slotProps.className, "relative bg-background")}>
              <div ref={hostRef} className={cn("absolute inset-0", view === "world" ? "visible" : "invisible pointer-events-none")}>
                <CityView
                  key={quality}
                  manifestUrl={map.browserManifestUrl}
                  options={viewerOptions(quality)}
                  onReady={onViewerReady}
                  onMapLoaded={() => {
                    setMapLoaded(true);
                    setViewerError(null);
                  }}
                  onError={(reason) => {
                    const message = errorMessage(reason);
                    setMapLoaded(false);
                    setViewerError(message);
                    toast.error("Drive map could not load", { description: message });
                  }}
                  className="h-full w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  ariaLabel={`${map.label} authored driving scenario`}
                  role="application"
                  tabIndex={0}
                />
              </div>
              {view === "cameras" ? (
                <div className="absolute inset-0 overflow-auto bg-background p-4">
                  <PoleCameraGrid
                    rigs={poleCameras.rigs}
                    features={poleCameras.features}
                    feeds={cameraFeeds}
                    viewer={viewer}
                    clock={clock}
                    archiveUrlTemplate={replay?.archiveUrlTemplate}
                    archiveOffsetSeconds={replay?.archiveOffsetSeconds}
                  />
                </div>
              ) : null}
            </div>
          )}
          statusOverlay={(slotProps) => (
            <div {...slotProps}>
              {view === "world" && state?.mode === "placing" ? (
                <PlacementCursorHint state={state} hostRef={hostRef} canvas={viewer?.renderer.domElement ?? null} />
              ) : view === "world" && state?.mode && state.mode !== "idle" ? (
                <div className="pointer-events-auto"><EditorModeBanner state={state} controller={controller} /></div>
              ) : null}
              {view === "world" && driving && driveTime ? (
                <ScenarioEditorReadout
                  className="absolute left-4 top-4 flex items-baseline gap-3"
                  role="status"
                  aria-label={`Driving ${egoActorLabel ?? "vehicle"}, speed ${driveSpeedKph.toFixed(1)} kilometers per hour, ${driveMode === "free" ? "elapsed" : "clip time"} ${driveTime}${transport?.playing ? "" : ", paused"}`}
                >
                  <span className="text-editor-text">{egoActorLabel ? `Driving ${egoActorLabel}` : "Driving"}</span>
                  <span className="text-editor-text tabular-nums">{driveSpeedKph.toFixed(1)} km/h</span>
                  <span className="tabular-nums">{driveTime}</span>
                  {takeRecording ? <span className="text-red-400">● Recording</span> : null}
                  {!transport?.playing && !clipEnded ? (
                    takeRecording ? (
                      <Button type="button" size="sm" variant="outline" className="pointer-events-auto" onClick={() => transport?.play()} title="Re-engage your controls first, then continue the take from where it paused">
                        Resume take
                      </Button>
                    ) : <span>Paused</span>
                  ) : null}
                </ScenarioEditorReadout>
              ) : null}
              {view === "world" && cameraNotice ? (
                <ScenarioEditorReadout className="absolute left-4 top-14" role="status">
                  <span className="text-editor-text">{cameraNotice}</span>
                </ScenarioEditorReadout>
              ) : null}
              {view === "world" && take && driving && takePhase.kind === "idle" && !clipEnded ? (
                <ScenarioEditorReadout className="pointer-events-auto absolute left-1/2 top-4 flex -translate-x-1/2 items-center gap-3" role="status">
                  <span className="text-editor-text">
                    Ready to record {take.clipSeconds.toFixed(1)} s of {egoActorLabel ?? "the vehicle"} · the world restarts from t = 0
                  </span>
                  <Button type="button" size="sm" onClick={restartDrive}>
                    <CircleDot /> Start take
                  </Button>
                </ScenarioEditorReadout>
              ) : view === "world" && takeComplete && take ? (
                <ScenarioEditorReadout className="pointer-events-auto absolute left-1/2 top-4 flex -translate-x-1/2 items-center gap-3" role="status">
                  <span className="text-editor-text">
                    Take complete · {takePhase.kind === "review" ? `${takePhase.recording.samples.length} samples over ${takePhase.recording.clipSeconds.toFixed(1)} s` : "saving…"}
                  </span>
                  <Button type="button" size="sm" onClick={() => void saveTake()} disabled={takePhase.kind !== "review"}>
                    <Save /> Save take
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={restartDrive} disabled={takePhase.kind !== "review"}>
                    <RotateCcw /> Drive again
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={discardTake} disabled={takePhase.kind !== "review"}>
                    <Trash2 /> Discard
                  </Button>
                </ScenarioEditorReadout>
              ) : view === "world" && clipEnded && transport ? (
                <ScenarioEditorReadout className="pointer-events-auto absolute left-1/2 top-4 flex -translate-x-1/2 items-center gap-3" role="status">
                  <span className="text-editor-text">
                    {driving ? "Clip ended" : "Scenario complete"} · {formatClipTime(transport.time, transport.duration)}{driving ? "" : " · Free camera restored"}
                  </span>
                  <Button type="button" size="sm" variant="secondary" onClick={driving ? restartDrive : () => transport.play()}>
                    <RotateCcw /> {driving ? "Drive again" : "Replay"}
                  </Button>
                </ScenarioEditorReadout>
              ) : effectiveStatus !== "running" || viewerError || driveUnavailableReason ? (
                <div className="absolute left-1/2 top-4 -translate-x-1/2" role={effectiveStatus === "error" || viewerError ? "alert" : "status"}>
                  <div className={cn("rounded-md border bg-card/95 px-3 py-2 text-xs shadow-lg backdrop-blur", effectiveStatus === "error" || viewerError ? "border-destructive/50 text-destructive" : "border-border text-muted-foreground")}>
                    <WorldStatus status={effectiveStatus} error={effectiveError ?? viewerError ?? driveUnavailableReason} mapLoaded={mapLoaded} />
                  </div>
                </div>
              ) : null}
            </div>
          )}
          floatingOverlay={source && replay?.coverageUrl && clock ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 flex h-auto max-h-[min(65vh,520px)] justify-center px-4" data-testid="floating-history-layer">
              <div className="pointer-events-auto relative h-auto max-h-[min(65vh,520px)] w-full max-w-[1100px] min-w-0">
                <HistoryDock source={source} capabilities={replay} clock={clock} replayError={replayError} />
              </div>
            </div>
          ) : view === "world" && editorDocument && !(driving && driveMode === "free") ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 flex h-auto max-h-[min(65vh,520px)] justify-center px-4 pr-[21rem]" data-testid="floating-timeline-layer">
              <div className="pointer-events-auto relative h-auto max-h-[min(65vh,520px)] w-full max-w-[920px] min-w-0">
                <DriveTimelineDock
                  controller={controller}
                  document={editorDocument}
                  state={state}
                  playback={timelinePlayback}
                  readOnly={editingLocked}
                />
              </div>
            </div>
          ) : null}
        />
        <EditorOverlayHost controller={controller} document={editorDocument} showActorMotionControls />
      </EditorOverlayProvider>
    </EditorConfigurationBlockProvider>
  );
}

function DriveTimelineDock({ controller, document, state, playback, readOnly }: {
  controller: EditorController | null;
  document: EditorDocument;
  state: EditorState | null;
  playback: V1TimelineBrowserPlayback | null;
  readOnly: boolean;
}) {
  const { selection, actions } = useEditorOverlay();
  return (
    <ScenarioTimelineDock
      document={document}
      state={state ?? undefined}
      playback={playback}
      selectedInteractionId={selection.kind === "interaction" ? selection.interactionId : null}
      onFocusActor={actions.selectActor}
      onSelectActor={actions.selectActor}
      onSelectInteraction={actions.selectInteraction}
      onClearSelection={actions.clear}
      readOnly={readOnly}
      experience="advanced"
    />
  );
}

function WorldStatus({ status, error, mapLoaded }: { status: WorldSourceStatus; error: string | null; mapLoaded: boolean }) {
  if (error) return <>{error}</>;
  if (status === "running") return <>{mapLoaded ? "World running" : "World running · loading map"}</>;
  if (status === "connecting") return <>Connecting authored world…</>;
  if (status === "closed") return <>World closed</>;
  return <>Preparing authored world…</>;
}

const TWIN_DEFAULT_PORT = "8765";
function resolveRemoteWorld(): string | null {
  if (typeof window === "undefined") return null;
  const raw = new URLSearchParams(window.location.search).get("twin")
    ?? process.env.NEXT_PUBLIC_DRIVE_TWIN_URL
    ?? null;
  if (!raw) return null;
  if (/^wss?:\/\//.test(raw)) return raw.replace(/\/+$/, "");
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  const port = raw === "1" || raw === "true" ? TWIN_DEFAULT_PORT : raw;
  return `${scheme}://${window.location.hostname}:${port}`;
}

function directMapEntry({ manifestUrl, topologyUrl, label }: { manifestUrl: string; topologyUrl: string | null; label: string }): ScenarioMapEntry {
  const suffix = "/3d/manifest.json";
  if (!manifestUrl.endsWith(suffix)) throw new Error(`Direct manifest must end in ${suffix}`);
  const root = manifestUrl.slice(0, -suffix.length);
  const id = `direct:${manifestUrl}`;
  const emptyDigest = "0".repeat(64);
  return {
    id,
    versionId: id,
    mapVersionId: id,
    sourceMapId: id,
    label,
    locality: "",
    browserAssetRootUrl: root,
    browserManifestUrl: manifestUrl,
    browserClosureSha256: emptyDigest,
    artifacts: {
      xodrSha256: emptyDigest,
      topologySha256: emptyDigest,
      derivedTopologySha256: emptyDigest,
      locationsSha256: emptyDigest,
      signalsSha256: emptyDigest,
      lanePolygonsSha256: emptyDigest,
    },
    sumoNetworkSha256: null,
    manifestUrl,
    topologyUrl: topologyUrl ?? `${root}/topology-index.json.gz`,
  };
}

type ScenarioRole = EditorDocument["data"]["roles"][number];
function isVehicleRole(role: ScenarioRole): boolean {
  return !role.actor.static && role.actor.class !== "pedestrian" && role.actor.class !== "static_object";
}

function viewerOptions(quality: ScenarioAuthoringQuality): CityViewerOptions {
  const preset = AUTHORING_QUALITY[quality];
  return {
    maxPixelRatio: preset.maxPixelRatio,
    antialias: preset.antialias,
    cinematicLighting: preset.cinematicLighting,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
