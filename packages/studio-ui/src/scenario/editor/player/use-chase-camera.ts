"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Raycaster, Vector2, Vector3 } from "three";
import type { ActorRenderer, CityViewer } from "@simforge-oss/viewer";
import type { SampledActor } from "@simforge-oss/playback";

import { ChaseCameraRig, type ChaseSubject } from "./chase-camera";

/** A press that travels further than this is a camera drag, not a pick. */
const CLICK_SLOP_PX = 5;
/**
 * A click this close to an actor on screen picks it even without a hit on its
 * mesh: a pedestrian fifty metres away is a few pixels wide.
 */
const PICK_RADIUS_PX = 28;
/** The label floats this far above the actor's roof. */
const LABEL_CLEARANCE_M = 0.15;
/** Wheel notches scale the chase distance exponentially, like the orbit dolly. */
const WHEEL_ZOOM_RATE = 0.0015;

/**
 * Read handle on the live chase for automated checks, published the way the
 * viewer publishes `__simforgeViewerProbe`: the pose being chased and the yaw
 * the camera trails, so a gate can measure "behind the actor" from the same
 * numbers the camera used. Nothing reads it back.
 */
export interface ChaseProbe {
  readonly actorId: string;
  subject: ChaseSubject | null;
  yawRad: number;
}

declare global {
  interface Window {
    __simforgeChaseProbe?: ChaseProbe;
  }
}

/** The slice of the playback controller the chase camera reads. */
export type ChasePlaybackSource = {
  readonly currentActors: readonly SampledActor[];
};

export type ChaseCameraInput = {
  viewer: CityViewer | null;
  /** The shared actor renderer: picking, and the pose of anything it draws without a sample. */
  renderer: ActorRenderer | null | undefined;
  /** The playback sampler: the pose the chase camera trails. */
  playback: ChasePlaybackSource | null | undefined;
  /** True while the simulation player owns the viewport. */
  enabled: boolean;
  sampleHeight: (x: number, z: number) => number | null;
};

export type ChaseCamera = {
  /** The actor the camera is chasing, or null for the free camera. */
  readonly chasedActorId: string | null;
  /** Chase `actorId`; a no-op when it is already chased or has no pose to chase. */
  readonly chase: (actorId: string) => boolean;
  /** Hand the camera back; true when there was a chase to end. */
  readonly release: () => boolean;
  /** The floating name label; positioned over the chased actor every frame. */
  readonly labelRef: React.RefObject<HTMLDivElement | null>;
};

/**
 * Resolve the pose to chase for `actorId`: the playback sampler first (the
 * trace sample the renderer drew this frame), then whatever the shared
 * renderer draws for it (display-only SUMO preview traffic has no sample).
 */
export function chaseSubjectFor(
  actorId: string,
  playback: ChasePlaybackSource | null | undefined,
  renderer: Pick<ActorRenderer, "actorView"> | null | undefined,
  sampleHeight: (x: number, z: number) => number | null,
): ChaseSubject | null {
  const sampled = playback?.currentActors.find((actor) => actor.id === actorId && actor.present);
  if (sampled) {
    return {
      x: sampled.x,
      y: sampleHeight(sampled.x, sampled.z) ?? 0,
      z: sampled.z,
      headingRad: sampled.headingRad,
      speedMps: sampled.speedMps,
      motionDirection: sampled.motionDirection,
      dims: sampled.dims,
    };
  }
  const view = renderer?.actorView(actorId);
  if (!view) return null;
  return {
    x: view.x,
    y: view.y,
    z: view.z,
    headingRad: view.headingRad,
    speedMps: view.speedMps ?? Number.NaN,
    motionDirection: view.reversing ? -1 : 1,
    dims: view.dims,
  };
}

/**
 * The simulation player's chase camera: click an actor to ride behind it,
 * click empty ground (or call `release`) for the free camera again.
 *
 * The camera is written from the viewer's `onFrame` hook, which runs after the
 * controls and before the draw: the pose it reads is the one the renderer is
 * about to draw, so camera and actor move in the same frame and nothing shakes.
 * Orbit input is suspended while chasing (it would fight the rig); the wheel
 * still zooms the chase in and out.
 */
export function useChaseCamera({
  viewer,
  renderer,
  playback,
  enabled,
  sampleHeight,
}: ChaseCameraInput): ChaseCamera {
  const [chasedActorId, setChasedActorId] = useState<string | null>(null);
  const chasedRef = useRef<string | null>(null);
  const labelRef = useRef<HTMLDivElement | null>(null);
  const rigRef = useRef<ChaseCameraRig | null>(null);
  // Read by the per-frame hook, so a new trace (the verified swap) or a new
  // sampler never restarts the chase or re-eases the camera.
  const sources = useRef({ playback, renderer, sampleHeight });
  sources.current = { playback, renderer, sampleHeight };

  const resolve = useCallback((actorId: string): ChaseSubject | null => {
    const current = sources.current;
    return chaseSubjectFor(actorId, current.playback, current.renderer, current.sampleHeight);
  }, []);

  const chase = useCallback((actorId: string): boolean => {
    if (chasedRef.current === actorId) return true;
    if (!resolve(actorId)) return false;
    chasedRef.current = actorId;
    setChasedActorId(actorId);
    return true;
  }, [resolve]);

  const release = useCallback((): boolean => {
    if (chasedRef.current === null) return false;
    chasedRef.current = null;
    setChasedActorId(null);
    return true;
  }, []);

  // Leaving the player always hands the camera back.
  useEffect(() => {
    if (!enabled) release();
  }, [enabled, release]);

  // Drive the camera while chasing.
  useEffect(() => {
    if (!enabled || !viewer || !chasedActorId) return;
    const rig = rigRef.current ?? new ChaseCameraRig();
    rigRef.current = rig;
    const start = viewer.controls.getView();
    rig.begin({
      eyeX: start.position[0],
      eyeY: start.position[1],
      eyeZ: start.position[2],
      targetX: start.target[0],
      targetY: start.target[1],
      targetZ: start.target[2],
    });
    viewer.controls.setEnabled(false);
    const eye = new Vector3();
    const target = new Vector3();
    const anchor = new Vector3();
    const canvas = viewer.renderer.domElement;
    const previous = viewer.onFrame;
    const probe: ChaseProbe = { actorId: chasedActorId, subject: null, yawRad: rig.yawRad };
    if (typeof window !== "undefined") window.__simforgeChaseProbe = probe;
    const hook = (dtS: number): void => {
      previous?.(dtS);
      const subject = resolve(chasedActorId);
      probe.subject = subject;
      const label = labelRef.current;
      if (!subject) {
        // Despawned, or not spawned yet at this playhead: hold the camera
        // where it is and pick the actor up again when it returns.
        label?.style.setProperty("--chase-label-opacity", "0");
        return;
      }
      const pose = rig.update(subject, dtS, sources.current.sampleHeight);
      probe.yawRad = rig.yawRad;
      viewer.controls.setView(
        eye.set(pose.eyeX, pose.eyeY, pose.eyeZ),
        target.set(pose.targetX, pose.targetY, pose.targetZ),
      );
      if (!label) return;
      viewer.camera.updateMatrixWorld();
      anchor.set(subject.x, subject.y + subject.dims.h + LABEL_CLEARANCE_M, subject.z).project(viewer.camera);
      const bounds = canvas.getBoundingClientRect();
      const onScreen = anchor.z > -1 && anchor.z < 1;
      label.style.setProperty("--chase-label-x", `${Math.round(bounds.left + (anchor.x + 1) * bounds.width / 2)}px`);
      label.style.setProperty("--chase-label-y", `${Math.round(bounds.top + (1 - anchor.y) * bounds.height / 2)}px`);
      label.style.setProperty("--chase-label-opacity", onScreen ? "1" : "0");
    };
    viewer.onFrame = hook;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      rig.setZoom(rig.zoom * Math.exp(event.deltaY * WHEEL_ZOOM_RATE));
    };
    canvas.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => {
      if (viewer.onFrame === hook) viewer.onFrame = previous;
      if (typeof window !== "undefined" && window.__simforgeChaseProbe === probe) delete window.__simforgeChaseProbe;
      canvas.removeEventListener("wheel", onWheel, { capture: true });
      viewer.controls.setEnabled(true);
      labelRef.current?.style.setProperty("--chase-label-opacity", "0");
    };
  }, [chasedActorId, enabled, resolve, viewer]);

  // Click to chase, click empty ground to let go.
  useEffect(() => {
    if (!enabled || !viewer) return;
    const canvas = viewer.renderer.domElement;
    const raycaster = new Raycaster();
    const pointer = new Vector2();
    const projected = new Vector3();
    let press: { pointerId: number; x: number; y: number } | null = null;
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      press = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    };
    const onPointerUp = (event: PointerEvent) => {
      const start = press;
      press = null;
      if (!start || start.pointerId !== event.pointerId || event.button !== 0) return;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > CLICK_SLOP_PX) return;
      const bounds = canvas.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return;
      const picked = pickActorAt(event.clientX, event.clientY, bounds);
      if (picked && chase(picked)) return;
      release();
    };
    const pickActorAt = (clientX: number, clientY: number, bounds: DOMRect): string | null => {
      const current = sources.current;
      pointer.set(
        ((clientX - bounds.left) / bounds.width) * 2 - 1,
        -((clientY - bounds.top) / bounds.height) * 2 + 1,
      );
      if (current.renderer) {
        raycaster.setFromCamera(pointer, viewer.camera);
        for (const hit of raycaster.intersectObjects(current.renderer.pickables(), true)) {
          const id = current.renderer.actorIdForHit(hit);
          if (id && resolve(id)) return id;
        }
      }
      // Nothing under the cursor: take the nearest sampled actor within a
      // finger's width on screen, so small and distant actors stay clickable.
      viewer.camera.updateMatrixWorld();
      let best: string | null = null;
      let bestDistance = PICK_RADIUS_PX;
      for (const actor of current.playback?.currentActors ?? []) {
        if (!actor.present) continue;
        const ground = current.sampleHeight(actor.x, actor.z) ?? 0;
        projected.set(actor.x, ground + actor.dims.h * 0.5, actor.z).project(viewer.camera);
        if (projected.z <= -1 || projected.z >= 1) continue;
        const screenX = bounds.left + (projected.x + 1) * bounds.width / 2;
        const screenY = bounds.top + (1 - projected.y) * bounds.height / 2;
        const distance = Math.hypot(screenX - clientX, screenY - clientY);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = actor.id;
        }
      }
      return best;
    };
    canvas.addEventListener("pointerdown", onPointerDown, { capture: true });
    canvas.addEventListener("pointerup", onPointerUp, { capture: true });
    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown, { capture: true });
      canvas.removeEventListener("pointerup", onPointerUp, { capture: true });
    };
  }, [chase, enabled, release, resolve, viewer]);

  return { chasedActorId, chase, release, labelRef };
}
