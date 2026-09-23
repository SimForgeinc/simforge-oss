import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { CoordinateFrame } from '@simforge-oss/maps/coordinate-frame';
import { DrivableAreaSchema, type DrivableArea } from './replay-context/drivable.js';
import type { RoadBoundaryOutline } from '@simforge-oss/maps/topology';

/** Prefer a digest-bound source road outline; old lane-only bundles retain their named instrument. */
export async function loadBenchDrivableArea(mapDirectory: string): Promise<DrivableArea | null> {
  let outlineBytes: Buffer | null = null;
  try { outlineBytes = await readFile(path.join(mapDirectory, 'road-boundary.json.gz')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (outlineBytes) {
    const xodr = await readFile(path.join(mapDirectory, 'map.xodr'));
    const outline = JSON.parse(gunzipSync(outlineBytes).toString()) as RoadBoundaryOutline;
    const xodrSha256 = createHash('sha256').update(xodr).digest('hex');
    const roadBoundarySha256 = createHash('sha256').update(outlineBytes).digest('hex');
    let installation: { members?: Record<string, { sha256: string; bytes: number }> } | null = null;
    try { installation = JSON.parse(await readFile(path.join(mapDirectory, '.map-release.json'), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const member = installation?.members?.['road-boundary.json.gz'];
    if (installation && (member?.sha256 !== roadBoundarySha256 || member.bytes !== outlineBytes.length)) throw new Error('bench road-boundary installation digest mismatch');
    if (outline.schema !== 'simforge.road-boundary/v1' || outline.recipe !== 'opendrive-road-outline/v1' || outline.source?.xodrSha256 !== xodrSha256) throw new Error('bench road-boundary source identity mismatch');
    return DrivableAreaSchema.parse({
      source: 'opendrive-road-boundary', geometry: 'oriented-boundaries', frame: outline.frame,
      confidence: 'authoritative', timeSupportUs: null, boundaries: outline.boundaries, polygons: outline.polygons, coverage: outline.coverage,
      provenance: { mapDirectory, roadBoundarySha256, ...outline.source, recipe: outline.recipe, interpretation: 'source OpenDRIVE paved cross-section outline, not surveyed ground-truth or a lane-union substitute; exposed section caps remain unavailable' },
    });
  }
  let bytes: Buffer, xodr: Buffer;
  try { [bytes, xodr] = await Promise.all([readFile(path.join(mapDirectory, 'lane-polygons.geojson.gz')), readFile(path.join(mapDirectory, 'map.xodr'))]); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  const frame = CoordinateFrame.fromMapAssets(xodr.toString());
  const source = JSON.parse(gunzipSync(bytes).toString()) as { features: { properties: { LaneType?: string; lane_type?: string; road_id?: string; lane_id?: number }; geometry: { type: string; coordinates: number[][][] } }[] };
  const drivableTypes: Record<string, true> = { driving: true, bidirectional: true, entry: true, exit: true, onRamp: true, offRamp: true, connectingRamp: true };
  const polygons: DrivableArea['polygons'] = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [index, feature] of source.features.entries()) {
    if (!drivableTypes[feature.properties.LaneType ?? feature.properties.lane_type ?? '']) continue;
    if (feature.geometry.type !== 'Polygon') throw new Error('bench drivable geometry requires explicit Polygon surfaces');
    for (const [ringIndex, coordinates] of feature.geometry.coordinates.entries()) {
      const ring = coordinates.map(([lon, lat]) => {
        const [x, y] = frame.wgs84ToLocal(lon!, lat!);
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('non-finite map polygon projection');
        minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
        return [x, y] as [number, number];
      });
      if (ring.length < 3) throw new Error('degenerate drivable polygon');
      polygons.push({ id: `lane-${index}-${ringIndex}`, kind: ringIndex === 0 ? 'drivable' : 'hole', ring });
    }
  }
  if (!polygons.length) return null;
  return {
    source: 'native-lane-polygons', geometry: 'polygons', frame: 'xodr-local', confidence: 'low', timeSupportUs: null, boundaries: [], polygons,
    coverage: { boundsMinXY: [minX, minY], boundsMaxXY: [maxX, maxY] },
    provenance: { mapDirectory, lanePolygonsSha256: createHash('sha256').update(bytes).digest('hex'), xodrSha256: createHash('sha256').update(xodr).digest('hex'), interpretation: 'union of authored driving lane surfaces; not road-boundary authority; ground-truth admission required before promotion' },
  };
}
