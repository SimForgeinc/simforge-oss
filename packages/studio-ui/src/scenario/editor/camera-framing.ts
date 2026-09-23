import { Vector3 } from "three";
import type { SampledActor } from "@simforge-oss/playback";

/**
 * Camera framing the editor surface owns, as opposed to the deliberate
 * document-pose framing in `EditorController.frameActor`.
 *
 * The distinction matters during playback. `EditorController` resolves an actor
 * through `doc.actor(id)`, which is the authored *spawn* placement, so framing a
 * moving actor from the timeline flew the camera to where the car started
 * rather than where it is on screen. While playback owns the scene the poses
 * come from the trace, and the only pose that matches what the author is
 * looking at is the sample at the playhead.
 */

/** The slice of `CityViewer` a camera flight needs. */
export type FramingViewer = {
  readonly controls: {
    getView(): {
      readonly position: readonly [number, number, number];
      readonly target: readonly [number, number, number];
    };
    setView(position: Vector3, target: Vector3): void;
  };
};

/** A pose that can be framed: playhead sample or authored placement. */
export type FrameableActor = {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly dims: { readonly l: number; readonly h: number };
};

/** Matches `EditorController.frameActor` so both paths settle at one distance. */
const FLIGHT_MS = 320;

export function actorFrameDistance(dims: FrameableActor["dims"]): number {
  return Math.max(14, Math.min(42, Math.max(dims.l, dims.h) * 4.5));
}

/**
 * Which pose the timeline should fly to for `actorId`.
 *
 * `inspecting` is the flag that says playback — not the editor — is presenting
 * the scene. A sample is used only when the actor is `present` at the playhead;
 * an actor that has not spawned yet, or has already been removed, has no
 * on-screen position, so its authored placement is the honest target.
 */
export function resolveActorFrameTarget({
  actorId,
  inspecting,
  sampledActors,
  authored,
  sampleHeight,
}: {
  actorId: string;
  inspecting: boolean;
  sampledActors: readonly SampledActor[] | null | undefined;
  authored: FrameableActor | null | undefined;
  sampleHeight: (x: number, z: number) => number | null;
}): FrameableActor | null {
  if (inspecting && sampledActors) {
    const sampled = sampledActors.find(
      (candidate) => candidate.id === actorId && candidate.present,
    );
    if (sampled) {
      return {
        x: sampled.x,
        y: sampleHeight(sampled.x, sampled.z) ?? authored?.y ?? 0,
        z: sampled.z,
        dims: sampled.dims,
      };
    }
  }
  return authored ?? null;
}

/**
 * Ease the camera to `target` while keeping the current view direction, and
 * return the cancel handle so one surface never runs two flights at once.
 */
export function flyCameraTo(
  viewer: FramingViewer,
  target: Vector3,
  distance: number,
): () => void {
  const from = viewer.controls.getView();
  const startPosition = new Vector3(...from.position);
  const startTarget = new Vector3(...from.target);
  const direction = startPosition.clone().sub(startTarget);
  if (direction.lengthSq() < 0.001) direction.set(1, 0.8, 1);
  const destination = target
    .clone()
    .add(direction.normalize().multiplyScalar(distance));
  const position = new Vector3();
  const lookAt = new Vector3();
  const startedAt = performance.now();
  let handle = 0;
  const tick = (now: number): void => {
    const linear = Math.min(1, (now - startedAt) / FLIGHT_MS);
    const eased = 1 - Math.pow(1 - linear, 3);
    viewer.controls.setView(
      position.copy(startPosition).lerp(destination, eased),
      lookAt.copy(startTarget).lerp(target, eased),
    );
    handle = linear < 1 ? requestAnimationFrame(tick) : 0;
  };
  handle = requestAnimationFrame(tick);
  return () => {
    if (handle) cancelAnimationFrame(handle);
    handle = 0;
  };
}
