/**
 * The dashcam view: a camera bolted to the car where its forward camera is.
 *
 * When the driven actor carries a forward dash camera sensor — a driver-in-the-
 * loop variation always does, it is given the `basic-dash-camera` rig — the view
 * sits exactly where that sensor sits and sees through its lens, so what the
 * driver watches is what the clip's renders will show from that car. Without a
 * sensor it falls back to the scenario vocabulary's own windscreen mount,
 * scaled to the car's box, with a typical dashcam lens.
 */

import {
  firstEnabledDashCamera,
  resolveSensorMountPreset,
  type ActorSensor,
} from "@simforge-oss/scenario";

/**
 * A rigid camera mount in the sensor frame: actor-local metres from the
 * ground-contact origin, +X forward, +Y up, +Z left. Yaw turns about +Y
 * (positive to the left), then pitch about +Z (positive raises the view).
 * Roll is not carried: a dashcam that rolled its horizon would read as a bug.
 */
export interface DashcamMount {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yawRad: number;
  readonly pitchRad: number;
  readonly horizontalFovDeg: number;
  /** Whether the mount is the actor's own sensor or the windscreen fallback. */
  readonly source: "sensor" | "windscreen";
}

/** Consumer dashcams sit between 100° and 140°; the wide end fish-eyes a 16:9 viewport. */
export const DASHCAM_FALLBACK_FOV_DEG = 100;
/** Real dashcams are aimed a few degrees down so the road fills the frame, not the sky. */
export const DASHCAM_FALLBACK_PITCH_RAD = (-4 * Math.PI) / 180;

/** The mount for the driven actor, from its own forward camera where it has one. */
export function dashcamMountFor(actor: {
  readonly class: string;
  readonly dims?: { readonly length: number; readonly width: number; readonly height: number };
  readonly sensors: readonly ActorSensor[];
}): DashcamMount {
  const sensor = firstEnabledDashCamera(actor);
  if (sensor && Math.abs(sensor.mount.rotation.yawRad) < Math.PI / 2) {
    return {
      x: sensor.mount.position.x,
      y: sensor.mount.position.y,
      z: sensor.mount.position.z,
      yawRad: sensor.mount.rotation.yawRad,
      pitchRad: sensor.mount.rotation.pitchRad,
      horizontalFovDeg: sensor.camera.horizontalFovDeg,
      source: "sensor",
    };
  }
  const mount = resolveSensorMountPreset("windscreen", {
    class: actor.class,
    ...(actor.dims ? { dims: actor.dims } : {}),
  });
  return {
    x: mount.position.x,
    y: mount.position.y,
    z: mount.position.z,
    yawRad: 0,
    pitchRad: DASHCAM_FALLBACK_PITCH_RAD,
    horizontalFovDeg: DASHCAM_FALLBACK_FOV_DEG,
    source: "windscreen",
  };
}

/** A fallback mount for a car whose actor was not available, from its box alone. */
export function dashcamMountForDims(dims: { l: number; w: number; h: number }): DashcamMount {
  return dashcamMountFor({ class: "car", dims: { length: dims.l, width: dims.w, height: dims.h }, sensors: [] });
}

/** Vertical field of view for a horizontal one on a viewport of the given aspect, degrees. */
export function verticalFovDeg(horizontalFovDeg: number, aspect: number): number {
  const half = (horizontalFovDeg * Math.PI) / 360;
  return (2 * Math.atan(Math.tan(half) / Math.max(0.1, aspect)) * 180) / Math.PI;
}
