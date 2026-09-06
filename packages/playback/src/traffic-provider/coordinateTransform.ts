import {
  sumoNetworkHeadingToScene,
  sumoNetworkToScene,
  sumoSceneHeadingToNetwork,
  sumoSceneToNetwork,
} from '@simforge-oss/engine';
import type { NetworkWorldTransform } from './protocol';

/** Exact scene -> SUMO conversion used for authored occupancy proxies. */
export function externalActorToNetwork(
  actor: { readonly x: number; readonly z: number; readonly headingDegrees: number },
  transform: NetworkWorldTransform,
): { readonly x: number; readonly y: number; readonly headingDegrees: number } {
  const point = sumoSceneToNetwork(actor, transform);
  return { ...point, headingDegrees: sumoSceneHeadingToNetwork(actor.headingDegrees, transform) };
}

export function transformPackedStatesToWorld(
  buffer: ArrayBuffer,
  count: number,
  transform: NetworkWorldTransform,
): void {
  const floats = new Float32Array(buffer);
  if (count < 0 || floats.length < count * 8) {
    throw new RangeError(`packed traffic state has ${floats.length} floats for ${count} actors`);
  }
  for (let actor = 0; actor < count; actor += 1) {
    const offset = actor * 8;
    const scene = sumoNetworkToScene({ x: floats[offset + 1]!, y: floats[offset + 2]! }, transform);
    // Packed SUMO state layout carries scene x at +1 and scene z at +2.
    floats[offset + 1] = scene.x;
    floats[offset + 2] = scene.z;
    const heading = floats[offset + 3]!;
    floats[offset + 3] = sumoNetworkHeadingToScene(heading, transform);
  }
}
