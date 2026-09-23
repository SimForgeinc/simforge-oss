/**
 * Densification: individual parking bays from the RoadRunner GeoJSON.
 *
 * `Type=ParkingSpace` polygons carry an `EntryPosition` — the point a vehicle
 * enters the bay from — which is exactly the pose a parked-car prop or a
 * pulling-out actor needs. There are 639 on Yale, 1,387 on El Camino Road, and
 * nothing downstream of the search index ever exposed them.
 *
 * Identity is the RoadRunner GUID, which is content-derived upstream and
 * therefore survives re-exports that reorder the feature list.
 */

import { asLocationId } from '../../types/ids.js';
import type { Affordance, FactValue, LocationType } from '../../types/location.js';
import { anchorFacts, liftAnchor } from '../anchor-lift.js';
import { type BuildContext, roadNameFor } from '../context.js';
import type { LocationDraft } from '../draft.js';
import { makeLocationIdString } from '../hash.js';
import {
  angleBetween,
  bearingDegBetween,
  centroid,
  dist,
  headingOf,
  type Point2,
} from '../../geometry/vec.js';
import { slugify } from '../slug.js';
import type { GeoFeature, MapGeojsonProperties } from '../../types/sources.js';

const TYPE: LocationType = 'parking_space';

/** A bay further than this from any lane is not usefully placeable. */
const MAX_LANE_DISTANCE_M = 40;

/** One draft per parking bay. */
export function densifyParkingSpaces(ctx: BuildContext): LocationDraft[] {
  const mapId = ctx.sources.mapId as string;
  const out: LocationDraft[] = [];
  const features = (ctx.sources.mapGeojson?.features ?? []).filter(
    (f) => f.properties.Type?.toLowerCase() === 'parkingspace',
  );

  for (const f of features) {
    const guid = f.properties.Id;
    if (!guid) continue;
    const unique = parkingFootprint(ctx, f);
    if (!unique) continue;

    const bayCentre = centroid(unique);

    const entry = f.properties.EntryPosition;
    const entryLocal = entry ? ctx.toLocal(entry[0], entry[1]) : bayCentre;

    const lift = liftAnchor(ctx, entryLocal, {
      maxDistanceM: MAX_LANE_DISTANCE_M,
      laneTypes: ['driving', 'parking'],
    });

    const { longM, shortM, longAxisHeading } = bayDimensions(unique);
    const laneHeading = lift.anchor.road?.headingRad;
    const isParallel =
      laneHeading === undefined
        ? false
        : Math.min(
            angleBetween(longAxisHeading, laneHeading),
            angleBetween(longAxisHeading + Math.PI, laneHeading),
          ) <=
          (30 * Math.PI) / 180;

    const roadName = lift.anchor.road ? roadNameFor(ctx, lift.anchor.road.rsl as string) : '';

    const facts: Record<string, FactValue> = {
      ...(entry ? { entry_heading_deg: Math.round(bearingDegBetween(bayCentre, entryLocal) * 10) / 10 } : {}),
      stall_length_m: Math.round(longM * 100) / 100,
      stall_width_m: Math.round(shortM * 100) / 100,
      is_parallel_parking: isParallel,
      road_name: roadName,
      ...anchorFacts(lift.anchor),
    };

    const affordances: Affordance[] = ['parkedVehicle', 'propPlacement'];
    if (lift.anchor.road && lift.anchor.road.distanceM <= 12) affordances.push('vehicleSpawn');

    const identityKey = `guid:${guid}`;
    out.push({
      id: asLocationId(makeLocationIdString(mapId, TYPE, identityKey)),
      name: roadName ? `Parking bay on ${roadName}` : 'Parking bay',
      type: TYPE,
      subtype: isParallel ? 'parallel' : 'angled',
      tags: ['PARKING_SPACE', isParallel ? 'PARKING_PARALLEL' : 'PARKING_ANGLED'].sort(),
      anchor: lift.anchor,
      affordances: affordances.sort(),
      facts,
      provenance: [{ source: 'map-geojson', ref: guid, confidence: 1 }],
      quality: { anchor: lift.quality, confidence: lift.quality === 'unanchored' ? 0.5 : 0.95 },
      naming: {
        stems: [slugify(roadName ? `${roadName}-bay` : 'parking-bay')],
        roadNames: roadName ? [roadName] : [],
      },
      identityKey,
    });
  }
  return out;
}

/** Source footprint, never an invented default-size parking bay. */
export function parkingFootprint(ctx: BuildContext, feature: GeoFeature<MapGeojsonProperties>): Point2[] | null {
  if (feature.geometry.type === 'Polygon') {
    const rings = feature.geometry.coordinates as number[][][];
    const ring = rings[0];
    if (!ring || ring.length < 4) return null;
    return ring.slice(0, -1).map(([lng, lat]) => ctx.toLocal(lng!, lat!));
  }
  // XODR ingestion retains object dimensions and an absolute map heading.
  // Its GeoJSON point is the centre of that explicitly dimensioned rectangle.
  if (feature.geometry.type !== 'Point') return null;
  const [lng, lat] = feature.geometry.coordinates as number[];
  const length = Number(feature.properties.length), width = Number(feature.properties.width);
  const heading = feature.properties.hdg;
  if (!(length > 0 && width > 0) || heading === undefined || !Number.isFinite(heading)) return null;
  const centre = ctx.toLocal(lng!, lat!), c = Math.cos(heading), s = Math.sin(heading);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([along, across]) => ({
    x: centre.x + along! * length / 2 * c - across! * width / 2 * s,
    y: centre.y + along! * length / 2 * s + across! * width / 2 * c,
  }));
}

function bayDimensions(corners: Point2[]): {
  longM: number;
  shortM: number;
  longAxisHeading: number;
} {
  let longM = 0;
  let shortM = Infinity;
  let longAxisHeading = 0;
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i] as Point2;
    const b = corners[(i + 1) % corners.length] as Point2;
    const d = dist(a, b);
    if (d > longM) {
      longM = d;
      longAxisHeading = headingOf(a, b);
    }
    if (d < shortM) shortM = d;
  }
  return { longM, shortM: Number.isFinite(shortM) ? shortM : 0, longAxisHeading };
}
