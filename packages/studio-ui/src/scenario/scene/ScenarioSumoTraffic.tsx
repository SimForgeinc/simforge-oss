"use client";

import { useEffect, useMemo, useRef } from "react";
import type { ActorRenderer } from "@simforge-oss/viewer";
import { indexedWorldHeightSampler } from "@simforge-oss/viewer";
import {
  allSumoSignalsGreenFromExtensions,
  ambientSignalCycleSettingsFromExtensions,
  ambientTrafficProfileFromExtensions,
  ambientTrafficProviderFromExtensions,
  BrowserMaterializedTrafficCapture,
  sumoOwnsPhysicalSignalStates,
} from "@simforge-oss/playback/traffic";
import type { MaterializedTrafficArtifactEnvelope } from "@simforge-oss/engine";
import type { PlaybackBundle } from "@simforge-oss/playback";
import { applyRestingHeading, createRestingHeading } from "@simforge-oss/playback";
import { useSumoTraffic } from "../../lib/scenario/ambient/useSumoTraffic";
import { parkedCarsFromExtensions } from "../../lib/scenario/parking/extension";
import { parkedCarOccupancySources, useParkedCars } from "../../lib/scenario/parking/useParkedCars";
import type { ScenarioDocumentDto } from "../../lib/scenario/contracts";
import { playbackMapEntry, type MapEntry } from "../../lib/scenario/maps";
import { usePlaybackControllerState } from "../../lib/scenario/playback/usePlayback";
import { mapSupportsScenarioPreview } from "./previewPolicy";
import type { ScenarioSession } from "./useScenarioSession";

/**
 * The editor's browser SUMO host.
 *
 * Runs ambient SUMO traffic for the open scenario while it is edited, paused or
 * played, publishes its status to the session (the traffic panels read it),
 * lets SUMO drive the physical signal heads, and records the materialized
 * traffic a revision needs as evidence when the session asks for it.
 *
 * It used to live inside the idle list scene; removing that scene
 * (studio-ui: lazy 3D world) removed the only SUMO host, which left the
 * editor at "SUMO disabled" and every SUMO revision-evidence request pending
 * forever. It renders nothing.
 */
export function ScenarioSumoTraffic({ session }: { session: ScenarioSession }) {
  const { map, document, bundle } = session;
  const viewer = session.capture?.viewer ?? null;
  const loadedMapVersionId = session.capture?.loadedMapVersionId ?? null;
  const playbackMap = useMemo(
    () => (map && mapSupportsScenarioPreview(map) ? playbackMapEntry(map) : null),
    [map],
  );
  const sampleHeight = useMemo(
    () => (viewer && loadedMapVersionId === playbackMap?.mapVersionId ? indexedWorldHeightSampler(viewer) : null),
    [loadedMapVersionId, playbackMap?.mapVersionId, viewer],
  );
  if (!playbackMap || !document || !bundle) return null;
  return (
    <SumoPreviewTraffic
      map={playbackMap}
      document={document}
      bundle={bundle}
      actorRenderer={session.capture?.actorRenderer ?? null}
      sampleHeight={sampleHeight}
      playback={session.playback}
      evidenceRequest={session.evidenceRequest}
      onEvidenceComplete={session.completeRevisionEvidence}
      onEvidenceFailure={session.failRevisionEvidence}
    />
  );
}

export function SumoPreviewTraffic({
  map,
  document,
  bundle,
  actorRenderer,
  sampleHeight,
  playback,
  evidenceRequest,
  onEvidenceComplete,
  onEvidenceFailure,
  onFallback,
}: {
  map: MapEntry;
  document: ScenarioDocumentDto;
  bundle: PlaybackBundle;
  actorRenderer: ActorRenderer | null;
  sampleHeight: ((x: number, z: number) => number | null) | null;
  playback: ScenarioSession["playback"];
  evidenceRequest: ScenarioSession["evidenceRequest"];
  onEvidenceComplete: (requestKey: string, artifact: MaterializedTrafficArtifactEnvelope) => void;
  onEvidenceFailure: (requestKey: string, reason: unknown) => void;
  onFallback?: (reason: string) => void;
}) {
  const playbackState = usePlaybackControllerState(playback.controller);
  const extensions = document.content.extensions;
  const profile = useMemo(() => ambientTrafficProfileFromExtensions(extensions), [extensions]);
  const provider = ambientTrafficProviderFromExtensions(extensions);
  const hasAuthoredMapSignals = (document.content.mapSignalPlans?.length ?? 0) > 0;
  const acceleratedSignalCycles = ambientSignalCycleSettingsFromExtensions(extensions).acceleratedSignalCycles;
  const allSignalsGreen = allSumoSignalsGreenFromExtensions(extensions);
  const materializedTrafficCapture = useMemo(() => evidenceRequest && provider === "sumo"
    ? new BrowserMaterializedTrafficCapture({
        sourceInputDigest: bundle.instance.manifest.inputHash,
        mapAssetId: map.sourceMapId,
        mapVersionId: map.mapVersionId,
        provider: { id: "sumo", version: "1.27.1", seed: String(profile.seed) },
        fixedStepSeconds: bundle.trace.header.dt,
        durationSeconds: bundle.endTime - bundle.startTime,
      })
    : undefined, [bundle, evidenceRequest, map.mapVersionId, map.sourceMapId, profile.seed, provider]);
  const metadata = useMemo(() => new Map(bundle.actors.map((actor) => [actor.id, actor])), [bundle]);
  const restingHeading = useMemo(() => createRestingHeading(bundle), [bundle]);
  const externalActors = (playback.controller?.currentActors ?? []).map((sampled) => {
    // Same repair as the editor's playback renderer: a dwell in a timed route
    // is recorded facing due east. See `restingHeading` in `@simforge-oss/playback`.
    const actor = applyRestingHeading(
      { ...sampled, animationTimeS: playback.controller?.state.time ?? 0 },
      restingHeading,
    );
    return {
      id: actor.id,
      kind: metadata.get(actor.id)?.kind ?? "vehicle",
      x: actor.x,
      z: actor.z,
      headingRad: actor.headingRad,
      speedMps: actor.speedMps,
      lengthM: actor.dims.l,
      widthM: actor.dims.w,
      static: actor.static,
      present: actor.present,
      render: {
        ...actor,
        y: sampleHeight?.(actor.x, actor.z) ?? 0,
      },
    };
  });
  // Memoised: the reader allocates a fresh `baked` array per call, and that
  // identity drives the occupancy memo below. Parked cars never move, so the
  // occupancy list should be built once, not once per frame.
  const parkedCarsSettings = useMemo(() => parkedCarsFromExtensions(extensions), [extensions]);
  /**
   * Parked cars are reported to SUMO as stationary occupancy so ambient traffic
   * does not drive through one. `buildSumoAuthoredOccupancies` keeps only shapes
   * whose footprint touches a driveable lane, so curb stalls block traffic while
   * off-street lot cars are correctly ignored.
   *
   * Exclusions come from the actors resolved here rather than from the editor's
   * own list. The two agree at t=0; where they briefly differ, the only effect is
   * that one stall's occupancy is reported (or not) beside an authored car that
   * SUMO already sees, so nothing observable changes.
   *
   * A parked car needs no resting-heading repair: its heading comes from the
   * stall, not from a recorded dwell.
   */
  const parkedExclusions = useMemo(
    () =>
      (playback.controller?.currentActors ?? []).map((actor) => ({
        x: actor.x,
        z: actor.z,
        radiusM: Math.max(1.5, Math.hypot(actor.dims.l, actor.dims.w) / 2),
      })),
    [playback.controller],
  );
  const parkedCars = useParkedCars({
    mapAssetId: map.sourceMapId,
    settings: parkedCarsSettings,
    exclusions: parkedExclusions,
  });
  const occupancyActors = useMemo(
    () => parkedCarOccupancySources(parkedCars.cars),
    [parkedCars.cars],
  );
  const focusActor = playback.controller?.currentActors.find((candidate) => candidate.present);
  const focus = focusActor ? { x: focusActor.x, z: focusActor.z } : null;
  const demandFocuses = useMemo(
    () =>
      (playback.controller?.currentActors ?? [])
        .filter((actor) => actor.present)
        .map((actor) => ({ x: actor.x, z: actor.z })),
    [playback.controller],
  );
  const status = useSumoTraffic({
    // The browser bridge cannot inject an authored MapSignalPlan into SUMO's
    // tlLogic yet. Letting both run would show one colour while SUMO vehicles
    // obey another, so an authored controller plan takes exclusive ownership.
    enabled: provider === "sumo" && map.sumoNetworkSha256 !== null && !hasAuthoredMapSignals,
    map,
    profile,
    renderer: actorRenderer,
    sampleHeight,
    mode: playbackState?.playing
      ? "playing"
      : playback.inspecting
        ? "paused"
        : "authoring",
    time: playbackState?.time ?? 0,
    externalActors: [...externalActors, ...occupancyActors],
    collisionActorOverrides: playback.collisionActorOverrides,
    focus,
    demandFocuses,
    onFallback: (reason) => {
      if (evidenceRequest) onEvidenceFailure(evidenceRequest.key, reason);
      onFallback?.(reason);
    },
    acceleratedSignalCycles,
    allSignalsGreen,
    materializedTrafficCapture,
    onMaterializedTrafficComplete: evidenceRequest
      ? (artifact) => onEvidenceComplete(evidenceRequest.key, artifact)
      : undefined,
  });
  const resumeWhenSumoIsReady = useRef(false);
  useEffect(() => {
    if (playbackState?.playing && status.phase === "loading") {
      resumeWhenSumoIsReady.current = true;
      playback.controller?.pause();
      return;
    }
    if (
      resumeWhenSumoIsReady.current &&
      !playbackState?.playing &&
      (status.phase === "ready" || status.phase === "running")
    ) {
      resumeWhenSumoIsReady.current = false;
      playback.controller?.play();
    }
    if (status.phase === "fallback") resumeWhenSumoIsReady.current = false;
  }, [playback.controller, playbackState?.playing, status.phase]);
  const { setSumoStatus } = playback;
  const sumoOwnsSignalStates = sumoOwnsPhysicalSignalStates(
    provider,
    status.phase === "fallback",
    hasAuthoredMapSignals,
    false,
  );
  useEffect(() => {
    if (!sumoOwnsSignalStates || !status.signalStates) return;
    playback.overlays?.setSignalStates(status.signalStates);
  }, [playback.overlays, status.signalStates, sumoOwnsSignalStates]);
  useEffect(() => {
    if (!sumoOwnsSignalStates) return;
    return () => {
      playback.overlays?.clearSignalStates();
      playback.controller?.refreshSignalPresentation();
    };
  }, [playback.controller, playback.overlays, sumoOwnsSignalStates]);
  useEffect(() => {
    setSumoStatus(status);
  }, [setSumoStatus, status]);
  useEffect(() => () => setSumoStatus({ phase: "disabled", actorCount: 0 }), [setSumoStatus]);
  const startedEvidenceKey = useRef<string | null>(null);
  useEffect(() => {
    if (!evidenceRequest || provider !== "sumo") {
      startedEvidenceKey.current = null;
      return;
    }
    if (!map.sumoNetworkSha256) {
      onEvidenceFailure(evidenceRequest.key, new Error("This map has no immutable SUMO network for revision evidence."));
      return;
    }
    if (!playback.controller || (status.phase !== "ready" && status.phase !== "running")) return;
    if (startedEvidenceKey.current === evidenceRequest.key) return;
    startedEvidenceKey.current = evidenceRequest.key;
    playback.controller.pause();
    playback.controller.seek(bundle.startTime);
    playback.setInspecting(true);
    playback.controller.play();
  }, [bundle.startTime, evidenceRequest, map.sumoNetworkSha256, onEvidenceFailure, playback, provider, status.phase]);
  return null;
}
