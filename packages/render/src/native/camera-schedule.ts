import { PRONTO_CHASE_CAMERA_SENSOR_ID, type RenderSensorSourceHost, type RenderSourceV3 } from '@simforge-oss/scenario';

import type { NativeSceneState } from './lowering.js';

/**
 * Rigid attachment the service resolves itself every tick, against the
 * host as it actually stands on the map: trajectories author y = 0 and
 * the service snaps the actor to the sampled ground, so an explicit
 * `eye` at the authored y would put the camera under the road wherever
 * the map is not at sea level. With `attach` present the service ignores
 * `eye`/`target`.
 */
export interface NativeSensorAttach {
  readonly actorId: string;
  /** Actor-local mount, metres: x forward, y right, z up. */
  readonly offsetM: readonly [number, number, number];
  /** Degrees, CARLA sense (clockwise from above); the service subtracts it. */
  readonly yawDeg: number;
  readonly pitchDeg: number;
  readonly rollDeg: number;
  /**
   * Keep the host's own geometry in this view. A rigid rig mount sits inside
   * the body shell and must not see it; the trailing chase camera exists to.
   */
  readonly hostVisible: boolean;
}

export interface NativeScheduledCamera {
  readonly sensorId: string;
  readonly width: number;
  readonly height: number;
  readonly fovDeg: number;
  /** Mount pose at the host's *authored* transform (y as the trajectory says). */
  readonly eye: readonly [number, number, number];
  readonly target: readonly [number, number, number];
  readonly attach: NativeSensorAttach;
}

/** A spinning lidar the service casts itself each tick (`render_bundle.lidars`). */
export interface NativeLidarRig {
  readonly sensorId: string;
  readonly attach: NativeSensorAttach;
  readonly channels: number;
  readonly rotationFrequencyHz: number;
  readonly pointsPerSecond: number;
  readonly horizontalFovDeg: number;
  readonly verticalFovDeg: number;
  readonly rangeM: number;
}

/** A fixed-fan radar the service casts itself each tick (`render_bundle.radars`). */
export interface NativeRadarRig {
  readonly sensorId: string;
  readonly attach: NativeSensorAttach;
  readonly pointsPerSecond: number;
  readonly horizontalFovDeg: number;
  readonly verticalFovDeg: number;
  readonly rangeM: number;
}

const TARGET_DISTANCE_M = 50;

function verticalFov(horizontalDegrees: number, width: number, height: number): number {
  const horizontal = horizontalDegrees * Math.PI / 180;
  return 2 * Math.atan(Math.tan(horizontal / 2) * height / width) * 180 / Math.PI;
}

function yawFromQuaternion(rotation: readonly [number, number, number, number]): number {
  const [x, y, z, w] = rotation;
  return Math.atan2(2 * (w * y + z * x), 1 - 2 * (y * y + z * z));
}

function hostActorId(source: RenderSourceV3, hosts: ReadonlyMap<string, string>): string {
  const actorId = hosts.get(source.outputName);
  if (!actorId) throw new Error(`native render source ${source.outputName} has no sensor host mapping`);
  if (actorId !== source.actorId) {
    throw new Error(`native sensor host for ${source.outputName} does not match actor ${source.actorId}`);
  }
  return actorId;
}

/**
 * The authored mount as the service's attachment. Authored mount yaw is CCW;
 * the service's attach yaw is CARLA's clockwise sense, so the sign flips here
 * and nowhere else. `pitchOffsetDeg` re-centres a sensor whose vertical band
 * is asymmetric (a lidar's `[lower, upper]`) onto the service's symmetric one.
 */
function attachment(source: RenderSourceV3, actorId: string, pitchOffsetDeg = 0): NativeSensorAttach {
  const mount = source.transform.position;
  return {
    actorId,
    offsetM: [mount.x, -mount.z, mount.y],
    yawDeg: -source.transform.rotation.yawRad * 180 / Math.PI,
    pitchDeg: source.transform.rotation.pitchRad * 180 / Math.PI + pitchOffsetDeg,
    rollDeg: -source.transform.rotation.rollRad * 180 / Math.PI,
    hostVisible: source.sensorId === PRONTO_CHASE_CAMERA_SENSOR_ID,
  };
}

/** Resolve every authored rigid camera mount against every simulated host pose. */
export function createNativeCameraSchedule(
  sources: readonly RenderSourceV3[],
  sensorHosts: readonly RenderSensorSourceHost[],
  states: readonly NativeSceneState[],
): readonly (readonly NativeScheduledCamera[])[] {
  const hosts = new Map(sensorHosts.map((host) => [host.sourceId, host.actorId]));
  const cameras = sources.filter((source) => source.modality === 'rgb');
  return states.map((state) => cameras.map((source): NativeScheduledCamera => {
    if (source.modality !== 'rgb') throw new Error(`unsupported native camera modality ${source.modality}`);
    const actorId = hostActorId(source, hosts);
    const actor = state.actors.find((candidate) => candidate.id === actorId && candidate.kind !== 'despawn');
    if (!actor) throw new Error(`native sensor host ${actorId} is absent at tick ${state.tick}`);

    const hostYaw = yawFromQuaternion(actor.transform.rotation);
    const mount = source.transform.position;
    const forward = mount.x;
    const right = -mount.z;
    const up = mount.y;
    const sinYaw = Math.sin(hostYaw);
    const cosYaw = Math.cos(hostYaw);
    const eye: [number, number, number] = [
      actor.transform.position[0] + cosYaw * forward + sinYaw * right,
      actor.transform.position[1] + up,
      actor.transform.position[2] - sinYaw * forward + cosYaw * right,
    ];

    // Native scene yaw is CCW about +Y. Render-source mount yaw follows the
    // authored sensor frame, so it composes directly with the host heading.
    const yaw = hostYaw + source.transform.rotation.yawRad;
    const pitch = source.transform.rotation.pitchRad;
    const cosPitch = Math.cos(pitch);
    const direction: [number, number, number] = [
      cosPitch * Math.cos(yaw),
      Math.sin(pitch),
      -cosPitch * Math.sin(yaw),
    ];
    return {
      sensorId: source.outputName,
      width: source.attributes.width,
      height: source.attributes.height,
      fovDeg: verticalFov(source.attributes.horizontalFovDeg, source.attributes.width, source.attributes.height),
      eye,
      target: [
        eye[0] + TARGET_DISTANCE_M * direction[0],
        eye[1] + TARGET_DISTANCE_M * direction[1],
        eye[2] + TARGET_DISTANCE_M * direction[2],
      ],
      attach: attachment(source, actorId),
    };
  }));
}

/**
 * The lidar and radar declarations the service retains for the run. They
 * are attached, so the service resolves their pose against the grounded
 * host every tick exactly as it does the cameras: one clock, one pose.
 */
export function createNativeSensorRigs(
  sources: readonly RenderSourceV3[],
  sensorHosts: readonly RenderSensorSourceHost[],
): { readonly lidars: readonly NativeLidarRig[]; readonly radars: readonly NativeRadarRig[] } {
  const hosts = new Map(sensorHosts.map((host) => [host.sourceId, host.actorId]));
  const lidars: NativeLidarRig[] = [];
  const radars: NativeRadarRig[] = [];
  for (const source of sources) {
    if (source.modality === 'lidar') {
      const { upperFovDeg, lowerFovDeg } = source.attributes;
      lidars.push({
        sensorId: source.outputName,
        attach: attachment(source, hostActorId(source, hosts), (upperFovDeg + lowerFovDeg) / 2),
        channels: source.attributes.channels,
        rotationFrequencyHz: source.attributes.rotationFrequencyHz,
        pointsPerSecond: source.attributes.pointsPerSecond,
        horizontalFovDeg: source.attributes.horizontalFovDeg,
        verticalFovDeg: upperFovDeg - lowerFovDeg,
        rangeM: source.attributes.rangeM,
      });
    } else if (source.modality === 'radar') {
      radars.push({
        sensorId: source.outputName,
        attach: attachment(source, hostActorId(source, hosts)),
        pointsPerSecond: source.attributes.pointsPerSecond,
        horizontalFovDeg: source.attributes.horizontalFovDeg,
        verticalFovDeg: source.attributes.verticalFovDeg,
        rangeM: source.attributes.rangeM,
      });
    }
  }
  return { lidars, radars };
}
