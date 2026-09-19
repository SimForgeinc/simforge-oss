"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Vector3 } from "three";
import { toast } from "sonner";
import * as stylex from "@stylexjs/stylex";
import type { CatalogId } from "@simforge-oss/asset-catalog";
import {
  EditorDocument,
  recordedManualDrive,
  type LaneIndex,
  type ScenarioMapEntry,
} from "@simforge-oss/editor";
import type { ManualDriveRecording, ScenarioTemplateV2 } from "@simforge-oss/scenario";
import type { TruthFrame } from "@simforge-oss/training-env/browser";
import type { CityViewer } from "@simforge-oss/viewer";
import { CityView } from "@simforge-oss/viewer/react";
import { EditorSceneEnvironmentBridge } from "@simforge-oss/studio-ui/scenario/editor/EditorSceneEnvironmentBridge";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import { MapLoadDebugPanel } from "@simforge-oss/studio-ui/scenario/scene/MapLoadDebugPanel";
import { AMBIENT_TRAFFIC_PROVIDER_EXTENSION_KEY } from "@simforge-oss/playback/traffic";
import { sceneViewerOptions } from "@simforge-oss/studio-ui/scenario/editor/authoring-quality";
import { useRegisterRenderingBenchmarkTarget } from "@simforge-oss/studio-ui/components/rendering-benchmark-target";
import {
  DriveCameraRig,
  DriveHud,
  ORBIT_MAX_DISTANCE_M,
  ORBIT_MAX_PITCH_RAD,
  ORBIT_MIN_DISTANCE_M,
  ORBIT_MIN_PITCH_RAD,
  PauseMenu,
  createDriveInput,
  driveChrome,
  emptyDriveTelemetry,
  type DriveAction,
  type DriveCameraKind,
  type DriveHudHandle,
  type DriveInput,
  type SpeedUnits,
} from "@simforge-oss/studio-ui/drive";
import {
  createVehicleAudio,
  vehicleAudioClassFor,
  type VehicleAudio,
} from "@simforge-oss/studio-ui/drive/audio";
import type { ScenarioAuthoringQuality } from "@/app/lib/scenario/contracts";
import { useDriveAmbientTraffic } from "@/app/lib/scenario/ambient/useDriveAmbientTraffic";
import {
  createAuthoredWorldSource,
  type AuthoredWorldSource,
} from "@/app/lib/live-world/authored-world-source";
import { createTruthViewerBridge, type TruthViewerBridge } from "@/app/lib/live-world/truth-viewer-bridge";
import { useWorldSource } from "@/app/lib/live-world/use-world-source";
import { driveFrame } from "./drive-session.stylex";
import { drivingLanes } from "./drive-lanes";
import { actorIsPresent, readEgoTelemetry } from "./frame-telemetry";
import { JevController } from "./jev-controller";
import type { DriveControlSource } from "@/app/lib/live-world/types";
import type { AuthoredDriveMode } from "@/app/lib/live-world/authored-world-session";

const WORLD_TICK_HZ = 20;
/** Orbit drag sensitivity, radians per pixel. */
const ORBIT_DRAG_RAD_PER_PX = 0.006;
const ORBIT_ZOOM_PER_NOTCH = 1.1;
/** How long the horn sounds for one press of the horn key or pad button. */
const HORN_PULSE_MS = 700;

/**
 * One driving session: a scenario, the actor a human took over, a camera and a
 * HUD.
 *
 * The game loop is the viewer's own frame hook, in this order: read the input
 * device, push the driver command to the physics runtime, move the camera to
 * where the car was just drawn, then write the HUD. That order matters —
 * sampling input after the camera would add a frame of lag to every control,
 * and reading the car's pose before the truth bridge has applied the frame
 * would make the camera chase a stale position.
 *
 * Nothing in that loop causes a React render. The HUD is written through refs,
 * and the component re-renders only when a human changes something.
 *
 * A session is driven in one of two modes. A `take` is a recording: the world
 * starts at t = 0 and the clip ends itself at the scenario's `clipSeconds`, at
 * which point the recorded poses are handed to `onSaveClip` as the driven
 * actor's motion; there is no review step, and a drive the human did not like
 * is driven again. A `free` drive records nothing and never ends — the world
 * runs endlessly, the clip boundary does not bind, and the only way out is the
 * pause menu.
 */
export function DriveSession({
  content,
  map,
  laneIndex,
  catalogId,
  vehicleLabel,
  quality,
  roleId,
  mode = "take",
  onSaveClip,
  onSaved,
  onExit,
}: {
  /** The variation being driven, already carrying the driven actor's sensors. */
  content: ScenarioTemplateV2;
  map: ScenarioMapEntry;
  laneIndex: LaneIndex;
  catalogId: CatalogId;
  vehicleLabel: string;
  quality: ScenarioAuthoringQuality;
  /** The actor the human drives, resolved before the session mounted. */
  roleId: string;
  /** `take` records a clip and saves it; `free` just drives. Defaults to `take`. */
  mode?: AuthoredDriveMode;
  /**
   * Persist the driven template. Rejecting leaves the take on screen,
   * retryable. Required for a `take`; a `free` drive never calls it.
   */
  onSaveClip?: (template: ScenarioTemplateV2) => Promise<void>;
  onSaved?: () => void;
  onExit: () => void;
}) {
  const isTake = mode === "take";
  const graphicsTarget = useMemo(() => ({ manifestUrl: map.browserManifestUrl, label: map.label }), [map.browserManifestUrl, map.label]);
  useRegisterRenderingBenchmarkTarget(graphicsTarget);
  const [startError, setStartError] = useState<string | null>(null);
  const [document, setDocument] = useState<EditorDocument | null>(null);
  const [source, setSource] = useState<AuthoredWorldSource | null>(null);
  const [viewer, setViewer] = useState<CityViewer | null>(null);
  const activeViewerRef = useRef<CityViewer | null>(null);
  const [bridge, setBridge] = useState<TruthViewerBridge | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [mapLoadError, setMapLoadError] = useState<unknown>(null);
  const [egoActorId, setEgoActorId] = useState<string | null>(null);
  const [takePhase, setTakePhase] = useState<
    { kind: "recording" } | { kind: "saving"; recording: ManualDriveRecording } | { kind: "failed" }
  >({ kind: "recording" });
  const [takeError, setTakeError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [units, setUnits] = useState<SpeedUnits>("kmh");
  const [debug, setDebug] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(0.8);
  const [trafficEnabled, setTrafficEnabled] = useState(false);
  const [cameraKind, setCameraKind] = useState<DriveCameraKind>("chase");
  const [controlSource, setControlSource] = useState<DriveControlSource>("human");
  const [jevStatus, setJevStatus] = useState("Human control");
  const [jevConnecting, setJevConnecting] = useState(false);
  const jevRef = useRef<JevController | null>(null);
  const jevConnectRef = useRef<AbortController | null>(null);
  const lanes = useMemo(() => drivingLanes(laneIndex), [laneIndex]);
  const [gamepadConnected, setGamepadConnected] = useState(false);
  /** How far into the clip the simulation is, sampled for the countdown only. */
  const [clipElapsedS, setClipElapsedS] = useState(0);
  const clipSeconds = content.choreography.clipSeconds;
  const hudRef = useRef<DriveHudHandle | null>(null);
  const inputRef = useRef<DriveInput | null>(null);
  const rigRef = useRef(new DriveCameraRig());
  const telemetryRef = useRef(emptyDriveTelemetry());
  const spawnedAtRef = useRef(0);
  const eyeRef = useRef(new Vector3());
  const targetRef = useRef(new Vector3());
  const audioRef = useRef<VehicleAudio | null>(null);
  const hornOffAtRef = useRef(0);
  /** Read inside the game loop, which must not be rebuilt when they change. */
  const pausedRef = useRef(false);
  const debugRef = useRef(false);
  const latestFrameRef = useRef<TruthFrame | null>(null);
  const onActionRef = useRef<(action: DriveAction) => void>(() => {});
  const world = useWorldSource(source);
  pausedRef.current = paused;
  debugRef.current = debug;

  // The driver needs to know how much clip is left, and the world clock is the
  // only honest source for that — wall time drifts from it whenever the tab
  // holds. Four samples a second is enough for a whole-second readout and keeps
  // this off the render path.
  useEffect(() => {
    if (!source || takePhase.kind !== "recording") return;
    setClipElapsedS(source.transport.time);
    const timer = setInterval(() => {
      setClipElapsedS(source.transport.time);
      if (jevRef.current) setJevStatus(jevRef.current.status);
    }, 250);
    return () => clearInterval(timer);
  }, [source, takePhase.kind]);

  // One world per session: the variation is compiled once and driven from t = 0.
  // A take that goes wrong restarts the same world through `beginTake`, so
  // nothing here has to be rebuilt to drive again.
  useEffect(() => {
    let disposed = false;
    let created: { document: EditorDocument; source: AuthoredWorldSource } | null = null;
    const open = async (): Promise<{ document: EditorDocument; source: AuthoredWorldSource }> => {
      const nextDocument = await EditorDocument.openBlank(map);
      nextDocument.importTemplate(content);
      return {
        document: nextDocument,
        // A free drive is endless. `endless` is what the worker's transport
        // and its driver-command guard both read; a `free` ego alone would
        // still have its pedals cut at the clip boundary.
        source: await createAuthoredWorldSource({
          document: nextDocument,
          map,
          tickHz: WORLD_TICK_HZ,
          endless: !isTake,
        }),
      };
    };
    void open().then((scenario) => {
      const nextSource = scenario.source;
      if (disposed) {
        nextSource.close();
        scenario.document.dispose();
        return;
      }
      created = { document: scenario.document, source: nextSource };
      setDocument(scenario.document);
      setSource(nextSource);
    })
      .catch((error: unknown) => {
        if (disposed) return;
        setStartError(errorMessage(error));
        toast.error("Drive could not start the world", { description: errorMessage(error) });
      });
    return () => {
      disposed = true;
      setSource(null);
      setDocument(null);
      setEgoActorId(null);
      created?.source.close();
      created?.document.dispose();
    };
  }, [content, map, isTake]);

  // The role is authored; the actor id it compiled to has to be resolved through
  // the source before it can be driven.
  useEffect(() => {
    if (!source || source.status !== "running") return;
    try {
      const actorId = source.selectEgo(roleId);
      if (!actorId) throw new Error("This scenario produced no drivable vehicle for the drive");
      source.setEgo(actorId, mode);
      setEgoActorId(actorId);
      spawnedAtRef.current = performance.now();
      if (isTake) {
        setTakePhase({ kind: "recording" });
        source.beginTake();
      }
    } catch (error) {
      setStartError(errorMessage(error));
    }
  }, [mode, isTake, roleId, source, world.status]);
  useEffect(() => {
    if (!source) return;
    latestFrameRef.current = null;
    bridge?.reset();
    // The worker announces every rebuild (transport reset, seek backwards,
    // take start) before the new generation's frames; the bridge only accepts
    // a tick that walks backwards after that authoritative reset.
    const unsubscribeResets = source.subscribeResets?.(() => {
      latestFrameRef.current = null;
      jevConnectRef.current?.abort();
      jevRef.current?.close();
      jevRef.current = null;
      source.setControlSource("human");
      setControlSource("human");
      setJevStatus("Human control");
      bridge?.reset();
    });
    // The loop reads frames from a ref: publishing them as React state at 20 Hz
    // would rebuild the loop's closure twenty times a second.
    const unsubscribeFrames = source.subscribeFrames((frame) => {
      latestFrameRef.current = frame;
      bridge?.apply(frame);
    });
    return () => {
      unsubscribeResets?.();
      unsubscribeFrames();
    };
  }, [bridge, source]);

  useEffect(() => {
    if (!bridge) return;
    bridge.setFollow(egoActorId, "dash");
  }, [bridge, egoActorId]);
  // The take's outcome arrives once through the source: a sealed recording is
  // saved into the scenario, and a failure leaves the drive retryable with its
  // reason on screen.
  useEffect(() => {
    if (!source) return;
    return source.subscribeTakes((event) => {
      if (event.kind === "complete") {
        setTakeError(null);
        setTakePhase({ kind: "saving", recording: event.recording });
      } else {
        setTakeError(event.message);
        setTakePhase({ kind: "failed" });
      }
    });
  }, [source]);

  // Saving is the end of the drive. `replaceActorMotion` is the editor's own
  // commit path, so the clip displaces the actor's authored motion exactly as an
  // authored take would; a rejected save keeps the drive on screen rather than
  // losing the take the human just drove.
  useEffect(() => {
    if (takePhase.kind !== "saving" || !document || !onSaveClip) return;
    let abandoned = false;
    const { recording } = takePhase;
    void (async () => {
      try {
        document.replaceActorMotion(recordedManualDrive(roleId, recording));
        await onSaveClip(document.data);
        if (!abandoned) onSaved?.();
      } catch (error) {
        if (abandoned) return;
        setTakeError(errorMessage(error));
        setTakePhase({ kind: "failed" });
      }
    })();
    return () => {
      abandoned = true;
    };
  }, [document, onSaveClip, onSaved, roleId, takePhase]);
  useEffect(() => () => bridge?.dispose(), [bridge]);

  /** Drive the clip again: the same world, restarted at t = 0. */
  const retryTake = useCallback(() => {
    if (!source) return;
    setTakeError(null);
    setTakePhase({ kind: "recording" });
    source.beginTake();
  }, [source]);

  const toggleJev = useCallback(async () => {
    if (!source || !egoActorId) return;
    jevConnectRef.current?.abort();
    if (jevRef.current) {
      jevRef.current.close();
      jevRef.current = null;
      source.setControlSource("human");
      setControlSource("human");
      setJevStatus("Human control");
      return;
    }
    const abort = new AbortController();
    jevConnectRef.current = abort;
    setJevConnecting(true);
    try {
      const controller = await JevController.create(laneIndex, egoActorId, source.scenarioInput, abort.signal);
      if (abort.signal.aborted) {
        controller.close();
        return;
      }
      const frame = latestFrameRef.current;
      const action = frame ? controller.update(frame) : null;
      if (!action) {
        controller.close();
        throw new Error("Wait for the first native vehicle frame before Jev takeover.");
      }
      jevRef.current = controller;
      source.setControlSource("jev");
      source.setPlannerAction(action);
      setControlSource("jev");
      setJevStatus(controller.status);
    } catch (error) {
      if (!abort.signal.aborted) toast.error("Jev takeover unavailable", { description: errorMessage(error) });
    } finally {
      if (jevConnectRef.current === abort) setJevConnecting(false);
    }
  }, [egoActorId, laneIndex, source]);

  useEffect(() => () => {
    jevConnectRef.current?.abort();
    jevRef.current?.close();
    jevRef.current = null;
    source?.setControlSource("human");
  }, [source]);

  const onViewerReady = useCallback((ready: CityViewer) => {
    activeViewerRef.current = ready;
    setViewer(ready);
    setMapLoadError(null);
    setBridge(createTruthViewerBridge(ready, { layer: "drive-live", groundLift: true }));
  }, []);
  const onViewerDisposed = useCallback((disposed: CityViewer) => {
    if (activeViewerRef.current !== disposed) return;
    activeViewerRef.current = null;
    setViewer(null);
    setMapLoaded(false);
    setBridge(null);
  }, []);

  const ambientTraffic = useDriveAmbientTraffic({
    document,
    map,
    viewer,
    mapLoaded,
    latestFrame: world.latestFrame,
    mode: "playing",
    time: source?.transport.time ?? 0,
    onFallback: (reason) => toast.error("Traffic unavailable", { description: reason }),
  });

  const toggleTraffic = useCallback(() => {
    if (!document) return;
    if (!trafficEnabled && !ambientTraffic.sumoAvailable) {
      toast.error("Traffic unavailable", {
        description: ambientTraffic.sumoUnavailableReason ?? `Traffic cannot run on ${map.label}.`,
      });
      return;
    }
    const next = !trafficEnabled;
    setTrafficEnabled(next);
    document.setAmbientTrafficExtension(
      AMBIENT_TRAFFIC_PROVIDER_EXTENSION_KEY,
      next ? "sumo" : undefined,
    );
  }, [ambientTraffic.sumoAvailable, ambientTraffic.sumoUnavailableReason, document, map.label, trafficEnabled]);

  const onAction = (action: DriveAction): void => {
    if (action === "pause") {
      setPaused((current) => !current);
      return;
    }
    if (action === "reset") {
      retryTake();
      return;
    }
    if (action === "cycleCamera") {
      setCameraKind(rigRef.current.cycle());
      return;
    }
    if (action === "toggleUnits") {
      setUnits((current) => (current === "kmh" ? "mph" : "kmh"));
      return;
    }
    if (action === "toggleMute") {
      setMuted((current) => !current);
      return;
    }
    if (action === "toggleDebug") {
      setDebug((current) => !current);
      return;
    }
    if (action === "toggleTraffic") {
      toggleTraffic();
      return;
    }
    if (action === "horn") {
      // A press, not a hold: every device reports the horn as an edge, so the
      // graph is told to stop again on the frame the pulse runs out. The horn
      // is sound only — nothing in the world hears it.
      audioRef.current?.setHorn(true);
      hornOffAtRef.current = performance.now() + HORN_PULSE_MS;
    }
  };

  // One input device for the whole session, reached through a ref. Rebuilding it
  // when a handler changes — `toggleTraffic` closes over the document — would
  // drop every key the player is holding, so the car would sit still mid-clip
  // until the throttle was pressed again.
  onActionRef.current = onAction;
  useEffect(() => {
    const input = createDriveInput({
      onAction: (action) => onActionRef.current(action),
      onGamepadChange: setGamepadConnected,
    });
    inputRef.current = input;
    return () => {
      inputRef.current = null;
      input.dispose();
    };
  }, []);

  // One audio graph per car. The context is created with the session and
  // closed with it: a context per respawn would leak hardware voices, and the
  // graph itself unlocks on the player's first gesture, which by this point
  // has already happened in the pickers.
  useEffect(() => {
    if (typeof window === "undefined" || !("AudioContext" in window)) return;
    const ctx = new AudioContext();
    const audio = createVehicleAudio(ctx, vehicleAudioClassFor(catalogId), {
      volume,
      muted,
      silentEngine: catalogId === "vehicle.bicycle",
    });
    audioRef.current = audio;
    audio.ready.catch((error: unknown) => {
      // A missing sample library must not take the game down with it; the car
      // simply drives in silence, and the player is told once.
      toast.warning("Drive is running without sound", { description: errorMessage(error) });
    });
    return () => {
      audioRef.current = null;
      audio.dispose();
      void ctx.close();
    };
    // Volume and mute are the initial values only; the effects below carry
    // changes to the live graph without rebuilding it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogId]);

  useEffect(() => audioRef.current?.setMasterVolume(volume), [volume]);
  useEffect(() => audioRef.current?.setCamera(cameraKind), [cameraKind]);
  // A paused game is a silent one, and the engine must not hang on whatever
  // RPM the pause caught it at.
  useEffect(() => audioRef.current?.setMuted(muted || paused), [muted, paused]);

  // Pausing stops the world as well as the input: a paused game whose physics
  // kept running would let a car roll off a bridge behind the menu. The held
  // command is released first so the car is not still on the throttle when the
  // world resumes.
  //
  // `world.status` stays in the dependencies so a world that has only just
  // started running is played the moment it reports it.
  useEffect(() => {
    inputRef.current?.setEnabled(!paused);
    if (!source || !egoActorId || source.status !== "running") return;
    if (paused) {
      source.setDriverCommand({ steer: 0, throttle: 0, brake: 1, handbrake: false });
      source.transport.stop();
    } else {
      source.transport.play();
    }
  }, [egoActorId, paused, source, world.status]);

  // A clip is driven, not watched: a tab that loses focus mid-take would record
  // a car nobody was steering, so the world holds until focus comes back.
  useEffect(() => {
    if (!source || takePhase.kind !== "recording") return;
    const pause = () => {
      if (source.transport.playing) source.transport.stop();
    };
    const resume = () => {
      if (globalThis.document.visibilityState === "visible") source.transport.play();
    };
    window.addEventListener("blur", pause);
    window.addEventListener("pagehide", pause);
    window.addEventListener("focus", resume);
    return () => {
      window.removeEventListener("blur", pause);
      window.removeEventListener("pagehide", pause);
      window.removeEventListener("focus", resume);
    };
  }, [source, takePhase.kind]);

  /** Orbit view drag and zoom. The other views are fixed to the car. */
  useEffect(() => {
    const canvas = viewer?.renderer.domElement;
    if (!canvas) return;
    let dragging = false;
    const onPointerDown = (event: PointerEvent) => {
      if (rigRef.current.cameraKind !== "orbit") return;
      dragging = true;
      canvas.setPointerCapture(event.pointerId);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!dragging) return;
      const orbit = rigRef.current.orbit;
      orbit.yawRad -= event.movementX * ORBIT_DRAG_RAD_PER_PX;
      orbit.pitchRad = Math.max(
        ORBIT_MIN_PITCH_RAD,
        Math.min(ORBIT_MAX_PITCH_RAD, orbit.pitchRad + event.movementY * ORBIT_DRAG_RAD_PER_PX),
      );
    };
    const onPointerUp = (event: PointerEvent) => {
      dragging = false;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    };
    const onWheel = (event: WheelEvent) => {
      if (rigRef.current.cameraKind !== "orbit") return;
      event.preventDefault();
      const orbit = rigRef.current.orbit;
      const factor = event.deltaY > 0 ? ORBIT_ZOOM_PER_NOTCH : 1 / ORBIT_ZOOM_PER_NOTCH;
      orbit.distanceM = Math.max(
        ORBIT_MIN_DISTANCE_M,
        Math.min(ORBIT_MAX_DISTANCE_M, orbit.distanceM * factor),
      );
    };
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("wheel", onWheel);
    };
  }, [viewer]);

  /** The game loop. */
  useEffect(() => {
    if (!viewer || !bridge || !source || !egoActorId) return;
    // The viewer's own frame hook, chained after the truth bridge's: the bridge
    // installs itself the same way, so calling the previous hook first means the
    // car has already been drawn at this frame's interpolated pose.
    const previous = viewer.onFrame;
    const rig = rigRef.current;
    const telemetry = telemetryRef.current;
    const hook = (dtS: number): void => {
      previous?.(dtS);
      const input = inputRef.current;
      const frame = latestFrameRef.current;
      if (jevRef.current && frame && !pausedRef.current) {
        const action = jevRef.current.update(frame);
        if (action) source.setPlannerAction(action);
      } else if (input && !pausedRef.current && !jevRef.current) {
        // `setDriverCommand`, not `control`: the driver command is held by the
        // runtime and applied at every physics substep, so pushing it once per
        // rendered frame is the whole of driving, and it is the only one of the
        // two that carries a handbrake — `ControlInput` has no such field, so
        // routing the drive through `control` silently dropped the Space key
        // the pause menu documents. The gearbox picks reverse off the brake
        // pedal at a standstill by itself, exactly as an automatic does.
        //
        // The input layer signs steering as a driver reads a wheel (-1 is full
        // left); the physics signs it as a yaw (+ is counter-clockwise, i.e.
        // left). This is the one place the two conventions meet.
        const command = input.sample(dtS);
        source.setDriverCommand({
          steer: -command.steer,
          throttle: command.throttle,
          brake: command.brake,
          handbrake: command.handbrake,
        });
      }
      const actor = bridge.rendered(egoActorId);
      if (!actor) return;
      if (frame) readEgoTelemetry(frame, egoActorId, telemetry);
      const pose = rig.update(
        { x: actor.x, y: actor.y, z: actor.z, headingRad: actor.headingRad, speedMps: telemetry.speedMps },
        actor.dims,
        dtS,
      );
      eyeRef.current.set(pose.eyeX, pose.eyeY, pose.eyeZ);
      targetRef.current.set(pose.targetX, pose.targetY, pose.targetZ);
      if (viewer.camera.fov !== pose.fov) {
        viewer.camera.fov = pose.fov;
        viewer.camera.updateProjectionMatrix();
      }
      viewer.controls.setView(eyeRef.current, targetRef.current);
      const audio = audioRef.current;
      if (audio) {
        // The listener sits at the camera, not in the car: from the orbit view
        // the engine has to sound like it is over there, and the ear that hears
        // the tyres is the one the player is looking through.
        const forwardX = pose.targetX - pose.eyeX;
        const forwardY = pose.targetY - pose.eyeY;
        const forwardZ = pose.targetZ - pose.eyeZ;
        audio.setListener({
          x: pose.eyeX,
          y: pose.eyeY,
          z: pose.eyeZ,
          forwardX,
          forwardY,
          forwardZ,
        });
        audio.setPosition(actor.x, actor.y, actor.z);
        audio.update(telemetry, dtS);
        if (hornOffAtRef.current !== 0 && performance.now() >= hornOffAtRef.current) {
          hornOffAtRef.current = 0;
          audio.setHorn(false);
        }
      }
      hudRef.current?.update(telemetry, {
        elapsedS: (performance.now() - spawnedAtRef.current) / 1000,
        cameraKind: rig.cameraKind,
        x: actor.x,
        z: actor.z,
        headingRad: actor.headingRad,
        // `getStats` builds a report object; only the debug readout needs it.
        frameMs: debugRef.current ? viewer.getStats().frameMsAvg : 0,
      });
    };
    viewer.onFrame = hook;
    // The camera is ours while a session is driving; the orbit/fly rig would
    // otherwise fight it for the same camera every frame.
    viewer.controls.setEnabled(false);
    return () => {
      if (viewer.onFrame === hook) viewer.onFrame = previous;
      viewer.controls.setEnabled(true);
    };
  }, [bridge, egoActorId, source, viewer]);

  // A despawned ego (the world refused the actor, or the clip parked) must not
  // leave the driver in a frozen scene with no explanation.
  useEffect(() => {
    if (!egoActorId || !world.latestFrame) return;
    if (actorIsPresent(world.latestFrame, egoActorId)) return;
    setStartError("The driven vehicle left the world. Driving the clip again is the way back.");
  }, [egoActorId, world.latestFrame]);

  const status = startError
    ?? (world.status === "error" ? world.error : null)
    ?? (takePhase.kind === "failed" ? `The drive was not recorded: ${takeError ?? "unknown reason"}` : null)
    ?? (takePhase.kind === "saving" ? "Saving the drive into this scenario…" : null)
    ?? (!mapLoaded ? `Loading ${map.label}…` : !egoActorId ? "Starting the world…" : null);

  return (
    <div {...stylex.props(driveFrame.session)}>
      <CityView
        ariaLabel={`Driving ${vehicleLabel} on ${map.label}`}
        {...stylex.props(driveFrame.canvas)}
        key={quality}
        manifestUrl={map.browserManifestUrl}
        onError={(reason) => {
          setMapLoaded(false);
          setMapLoadError(reason);
          setStartError(errorMessage(reason));
        }}
        onMapLoaded={() => setMapLoaded(true)}
        onReady={onViewerReady}
        onDisposed={onViewerDisposed}
        initialOptions={sceneViewerOptions(quality)}
        role="application"
        tabIndex={0}
      />
      <EditorSceneEnvironmentBridge
        active={mapLoaded}
        actorRenderer={bridge?.actors ?? null}
        document={document}
        quality={quality}
        viewer={viewer}
      />
      <DriveHud
        debug={debug}
        lanes={lanes}
        onPause={() => setPaused(true)}
        onToggleTraffic={toggleTraffic}
        onToggleUnits={() => setUnits((current) => (current === "kmh" ? "mph" : "kmh"))}
        ref={hudRef}
        trafficEnabled={trafficEnabled}
        units={units}
        vehicleLabel={vehicleLabel}
      />
      <div {...stylex.props(driveChrome.panelStatus, driveFrame.controlSource)}>
        <Button type="button" variant="outline" onClick={() => void toggleJev()}
          disabled={jevConnecting || !egoActorId || paused || takePhase.kind !== "recording"}
          aria-pressed={controlSource === "jev"} data-testid="drive-control-source">
          {jevConnecting ? "Connecting Jev…" : controlSource === "jev" ? "Take human control" : "Jev takeover"}
        </Button>
        <span role="status" data-testid="drive-jev-status">{jevStatus}</span>
      </div>
      <div
        {...stylex.props(driveChrome.panelStatus, driveFrame.clip)}
        data-testid={isTake ? "drive-clip-countdown" : "drive-free-mode"}
        role="status"
      >
        {!isTake
          ? "Free drive · no timer"
          : takePhase.kind === "recording"
            ? `Recording · ${Math.max(0, Math.ceil(clipSeconds - clipElapsedS))}s left`
            : `Clip · ${clipSeconds.toFixed(0)}s`}
      </div>
      {status ? (
        <div
          {...stylex.props(driveChrome.panelStatus, driveFrame.status)}
          data-testid="drive-status"
          role={startError || takeError ? "alert" : "status"}
        >
          {status}
          {takePhase.kind === "failed" ? (
            <Button type="button" variant="outline" onClick={retryTake} data-testid="drive-take-retry">
              Drive it again
            </Button>
          ) : null}
        </div>
      ) : null}
      {!mapLoaded || mapLoadError ? <MapLoadDebugPanel docked={false} source={{
        getViewer: () => activeViewerRef.current,
        mapId: map.sourceMapId,
        mapVersionId: map.versionId,
        manifestUrl: map.browserManifestUrl,
        requestedTier: quality,
        phase: mapLoadError ? "error" : "loading",
        readinessAnnounced: mapLoaded,
        error: mapLoadError,
      }} /> : null}
      {paused ? (
        <PauseMenu
          cameraKind={cameraKind}
          debug={debug}
          gamepadConnected={gamepadConnected}
          handbrake={source?.heldDriverCommand === true}
          muted={muted}
          onCameraKind={(kind) => {
            rigRef.current.setKind(kind);
            setCameraKind(kind);
          }}
          onDebugChange={setDebug}
          onExit={onExit}
          onMutedChange={setMuted}
          onResume={() => setPaused(false)}
          onVolumeChange={setVolume}
          volume={volume}
        />
      ) : null}
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
