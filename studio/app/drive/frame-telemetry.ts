"use client";

import type { TruthFrame } from "@simforge-oss/training-env/browser";
import type { DriveTelemetry } from "@simforge-oss/studio-ui/drive";

/**
 * The per-actor telemetry record the world session publishes on each truth
 * actor. Read through a cast only until `TruthActor.telemetry` ships in
 * `@simforge-oss/training-env`; the field names and units are identical, so the
 * cast is the one place that has to change.
 */
type TelemetryCarrier = { readonly telemetry?: Readonly<DriveTelemetry> };

/**
 * Copy one actor's telemetry out of a truth frame into the session's telemetry
 * object, and report whether the frame carried any.
 *
 * Copying rather than referencing keeps exactly one telemetry object alive per
 * session: the HUD and the audio graph both read it every frame, and handing
 * them a fresh object per truth frame would allocate 20 of them a second for no
 * reason. A frame without telemetry for the ego (the actor despawned, or the
 * physics has not produced a body yet) leaves the previous values in place —
 * the last known state of a car is a better readout than zeros.
 */
export function readEgoTelemetry(
  frame: TruthFrame,
  actorId: string,
  into: DriveTelemetry,
): boolean {
  const actor = frame.actors.find((candidate) => candidate.id === actorId);
  const telemetry = (actor as TelemetryCarrier | undefined)?.telemetry;
  if (!telemetry) return false;
  into.speedMps = telemetry.speedMps;
  into.rpm = telemetry.rpm;
  into.gear = telemetry.gear;
  into.throttle = telemetry.throttle;
  into.brake = telemetry.brake;
  into.steer = telemetry.steer;
  into.steerRad = telemetry.steerRad;
  into.wheelSpeeds = telemetry.wheelSpeeds;
  into.tyreUtilization.front = telemetry.tyreUtilization.front;
  into.tyreUtilization.rear = telemetry.tyreUtilization.rear;
  into.longitudinalG = telemetry.longitudinalG;
  into.lateralG = telemetry.lateralG;
  into.offRoad = telemetry.offRoad;
  into.collisionImpulseNs = telemetry.collisionImpulseNs;
  return true;
}

/** Whether the ego is still present in the frame's scene, i.e. has not despawned. */
export function actorIsPresent(frame: TruthFrame, actorId: string): boolean {
  return frame.scene.actors.some((actor) => actor.id === actorId && actor.kind !== "despawn");
}
