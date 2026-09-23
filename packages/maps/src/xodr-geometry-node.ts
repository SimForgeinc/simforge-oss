import { createHash } from 'node:crypto';

import { xodrGeometryProjection } from './xodr-geometry.js';

/**
 * sha256 of {@link xodrGeometryProjection}: the road-geometry identity of an
 * OpenDRIVE file, blind to elevation, superelevation/shape and laneHeight.
 * Published on map versions as `descriptor.xodrGeometrySha256`.
 */
export function xodrGeometrySha256(text: string): string {
  return createHash('sha256').update(xodrGeometryProjection(text)).digest('hex');
}
