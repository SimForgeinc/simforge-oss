"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Vector3 } from "three";
import { toast } from "sonner";
import * as stylex from "@stylexjs/stylex";
import type { CatalogId } from "@simforge-oss/asset-catalog";
import type { EditorDocument, LaneIndex, ScenarioMapEntry } from "@simforge-oss/editor";
import type { TruthFrame } from "@simforge-oss/training-env/browser";
import type { CityViewer, CityViewerOptions } from "@simforge-oss/viewer";
import { CityView } from "@simforge-oss/viewer/react";
import { AMBIENT_TRAFFIC_PROVIDER_EXTENSION_KEY } from "@simforge-oss/playback/traffic";
import { AUTHORING_QUALITY } from "@simforge-oss/studio-ui/scenario/editor/authoring-quality";
import { EditorSceneEnvironmentBridge } from "@simforge-oss/studio-ui/scenario/editor/EditorSceneEnvironmentBridge";
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
import { route } from "./drive-route.stylex";
import { createDriveScenario, drivingLanes, pickDriveSpawn, type DriveSpawn } from "./drive-scenario";
import { actorIsPresent, readEgoTelemetry } from "./frame-telemetry";

/** The world advances at this rate; the renderer interpolates between its frames. */
const WORLD_TICK_HZ = 20;
/** Orbit drag sensitivity, radians per pixel. */
const ORBIT_DRAG_RAD_PER_PX = 0.006;
const ORBIT_ZOOM_PER_NOTCH = 1.1;
/** How long the horn sounds for one press of the horn key or pad button. */
const HORN_PULSE_MS = 700;

/**
 * One driving session: a world, a car, a camera and a HUD.
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
 */
export function DriveSession({
  map,
  laneIndex,
  catalogId,
  color,
  vehicleLabel,
  quality,
  onChangeCar,
  onExit,
}: {
  map: ScenarioMapEntry;
  laneIndex: LaneIndex;
  catalogId: CatalogId;
  color: string;
  vehicleLabel: string;
  quality: ScenarioAuthoringQuality;
  onChangeCar: () => void;
  onExit: () => void;
}) {
  const lanes = useMemo(() => drivingLanes(laneIndex), [laneIndex]);
  const [spawn, setSpawn] = useState<DriveSpawn | null>(null);
  const [spawnError, setSpawnError] = useState<string | null>(null);
  const [document, setDocument] = useState<EditorDocument | null>(null);
  const [roleId, setRoleId] = useState<string | null>(null);
  const [source, setSource] = useState<AuthoredWorldSource | null>(null);
  const [viewer, setViewer] = useState<CityViewer | null>(null);
  const [bridge, setBridge] = useState<TruthViewerBridge | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [egoActorId, setEgoActorId] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [units, setUnits] = useState<SpeedUnits>("kmh");
  const [debug, setDebug] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(0.8);
  const [trafficEnabled, setTrafficEnabled] = useState(false);
  const [cameraKind, setCameraKind] = useState<DriveCameraKind>("chase");
  const [gamepadConnected, setGamepadConnected] = useState(false);

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

  const respawn = useCallback(() => {
    const next = pickDriveSpawn(laneIndex, lanes);
    if (!next) {
      setSpawnError(`${map.label} has no connected drivable lane to start on.`);
      return;
    }
    setSpawnError(null);
    setSpawn(next);
  }, [laneIndex, lanes, map.label]);

  useEffect(() => respawn(), [respawn]);

  // A respawn is a new one-car scenario and therefore a new world: the authored
  // world is compiled from the document, so moving the player is not an edit to
  // a running session but a fresh one. Everything else (viewer, map, camera
  // rig) is kept, which is what makes a respawn feel instant.
  useEffect(() => {
    if (!spawn) return;
    let disposed = false;
    let created: { document: EditorDocument; source: AuthoredWorldSource } | null = null;
    void createDriveScenario({ map, catalogId, color, spawn })
      .then(async (scenario) => {
        const nextSource = await createAuthoredWorldSource({
          document: scenario.document,
          map,
          tickHz: WORLD_TICK_HZ,
          endless: true,
        });
        if (disposed) {
          nextSource.close();
          scenario.document.dispose();
          return;
        }
        created = { document: scenario.document, source: nextSource };
        setDocument(scenario.document);
        setRoleId(scenario.roleId);
        setSource(nextSource);
      })
      .catch((error: unknown) => {
        if (disposed) return;
        setSpawnError(errorMessage(error));
        toast.error("Drive could not start the world", { description: errorMessage(error) });
      });
    return () => {
      disposed = true;
      setSource(null);
      setDocument(null);
      setRoleId(null);
      setEgoActorId(null);
      created?.source.close();
      created?.document.dispose();
    };
  }, [catalogId, color, map, spawn]);

  // Taking the car: the compiled world names actors itself, so the document's
  // role id has to be resolved through the source before it can be driven.
  useEffect(() => {
    // `world.status` drives the retry; the source itself says whether the
    // session this render is holding is the one that is actually running.
    if (!source || !roleId || source.status !== "running") return;
    try {
      const actorId = source.selectEgo(roleId);
      if (!actorId) throw new Error("The session scenario produced no drivable vehicle");
      source.setEgo(actorId);
      setEgoActorId(actorId);
      rigRef.current.reset();
      spawnedAtRef.current = performance.now();
      source.transport.play();
      if (!source.heldDriverCommand) {
        toast.warning("Runtime without a held driver command", {
          description:
            "This build applies the pedals once per world tick instead of every physics substep, and has no separate handbrake: the handbrake key brakes hard.",
          duration: 10000,
        });
      }
    } catch (error) {
      setSpawnError(errorMessage(error));
    }
  }, [roleId, source, world.status]);

  useEffect(() => {
    if (!source?.subscribeWarnings) return;
    return source.subscribeWarnings((message) => {
      toast.warning("Drive world notice", { description: message, duration: 8000 });
    });
  }, [source]);

  useEffect(() => {
    if (!source) return;
    latestFrameRef.current = null;
    // A respawn hands the same bridge a different world, whose ticks count
    // from zero and whose car is a different actor: without this the bridge
    // would keep drawing the session that just closed.
    bridge?.reset();
    // The loop reads frames from a ref: publishing them as React state at 20 Hz
    // would rebuild the loop's closure twenty times a second.
    return source.subscribeFrames((frame) => {
      latestFrameRef.current = frame;
      bridge?.apply(frame);
    });
  }, [bridge, source]);

  useEffect(() => () => bridge?.dispose(), [bridge]);

  const onViewerReady = useCallback((ready: CityViewer) => {
    setViewer(ready);
    setBridge(createTruthViewerBridge(ready, { layer: "drive-live", groundLift: true }));
  }, []);

  useEffect(() => {
    if (!viewer) return;
    const preset = AUTHORING_QUALITY[quality];
    viewer.setLiveQuality(preset.live);
    viewer.setRenderingSuspended(false);
    viewer.setAuthoringFidelity({
      ultraLow: preset.ultraLow,
      roadsOnly: preset.roadsOnly,
      cinematicLighting: preset.cinematicLighting,
    });
    viewer.setLayerVisible("vegetation", preset.vegetation);
  }, [quality, viewer]);

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
      respawn();
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

  // One input device for the whole session, reached through a ref. Rebuilding
  // it when a handler changes — a respawn replaces the document, which
  // `toggleTraffic` closes over — would drop every key the player is holding,
  // so the car would sit still after a reset until the throttle was pressed
  // again.
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
  // Respawning from the pause menu unpauses and replaces the world in the same
  // commit, so this effect still sees the session the respawn just closed, and
  // React's copy of its status is a render behind. Asking the source itself is
  // the only guard that holds: a closed source throws on a transport command,
  // and that throw would take the whole game down. `world.status` stays in the
  // dependencies so the new session is played the moment it reports running.
  useEffect(() => {
    inputRef.current?.setEnabled(!paused);
    if (!source || !egoActorId || source.status !== "running") return;
    if (paused) {
      source.setDriverCommand(null);
      source.transport.stop();
    } else {
      source.transport.play();
    }
  }, [egoActorId, paused, source, world.status]);

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
      if (input && !pausedRef.current) {
        // The command is held by the runtime and applied at every physics
        // substep, so pushing it once per rendered frame is the whole of
        // driving: the gearbox picks reverse off the brake pedal at a
        // standstill by itself, exactly as an automatic does.
        source.setDriverCommand(input.sample(dtS));
      }
      const actor = bridge.rendered(egoActorId);
      if (!actor) return;
      const frame = latestFrameRef.current;
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
  // leave the player in a frozen scene with no explanation.
  useEffect(() => {
    if (!egoActorId || !world.latestFrame) return;
    if (actorIsPresent(world.latestFrame, egoActorId)) return;
    setSpawnError("The player vehicle left the world. Respawning is the way back.");
  }, [egoActorId, world.latestFrame]);

  const status = spawnError
    ?? (world.status === "error" ? world.error : null)
    ?? (!mapLoaded ? `Loading ${map.label}…` : !egoActorId ? "Starting the world…" : null);

  return (
    <div {...stylex.props(route.session)}>
      <CityView
        ariaLabel={`Driving ${vehicleLabel} on ${map.label}`}
        {...stylex.props(route.canvas)}
        key={quality}
        manifestUrl={map.browserManifestUrl}
        onError={(reason) => {
          setMapLoaded(false);
          setSpawnError(errorMessage(reason));
        }}
        onMapLoaded={() => setMapLoaded(true)}
        onReady={onViewerReady}
        options={viewerOptions(quality)}
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
      {status ? (
        <div
          {...stylex.props(driveChrome.panelStatus, route.status)}
          data-testid="drive-status"
          role={spawnError ? "alert" : "status"}
        >
          {status}
        </div>
      ) : null}
      {paused ? (
        <PauseMenu
          cameraKind={cameraKind}
          debug={debug}
          gamepadConnected={gamepadConnected}
          muted={muted}
          onCameraKind={(kind) => {
            rigRef.current.setKind(kind);
            setCameraKind(kind);
          }}
          onChangeCar={onChangeCar}
          onDebugChange={setDebug}
          onExit={onExit}
          onMutedChange={setMuted}
          onRespawn={() => {
            respawn();
            setPaused(false);
          }}
          onResume={() => setPaused(false)}
          onVolumeChange={setVolume}
          volume={volume}
        />
      ) : null}
    </div>
  );
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
