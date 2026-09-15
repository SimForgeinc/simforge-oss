/**
 * The WGS84 footprint of one map: its OpenDRIVE extents rectangle projected
 * out of the map's own transverse-Mercator frame.
 *
 * Pure geometry over the `.xodr` header text, deliberately free of host/IO
 * imports so both the coverage route and its unit test use the same code.
 */

import { CoordinateFrame } from "@simforge-oss/maps/coordinate-frame";

/** `[lon, lat]` degrees. */
export type LonLat = [number, number];

export type MapFootprintGeometry = {
  /** Closed ring (first point repeated last) in lon/lat, south-west corner first. */
  polygon: LonLat[];
  /** Centre of the extents rectangle, projected. */
  center: LonLat;
};

/**
 * Project the extents rectangle of an OpenDRIVE header to WGS84.
 *
 * The four corners are projected individually rather than projecting a centre
 * and offsetting: a transverse Mercator's meridian convergence rotates the
 * rectangle slightly, and the drawn polygon should carry that rotation the
 * same way the road network does.
 *
 * @param xodrHeaderText Raw `.xodr` text — a leading slice is enough.
 * @throws If the header has no `<geoReference>` PROJ string or no numeric
 *   extents (`parseXodrHeader`), if the rectangle is degenerate, or if it
 *   projects off the globe. A map whose header cannot be georeferenced is
 *   reported as such, never drawn at a guessed place.
 */
export function mapFootprintGeometry(xodrHeaderText: string): MapFootprintGeometry {
  const frame = CoordinateFrame.fromMapAssets(xodrHeaderText);
  const extents = frame.extents;
  if (!extents) throw new Error("xodr header carries no extents");
  const { north, south, east, west } = extents;
  if (!(east > west) || !(north > south)) {
    throw new Error(
      `xodr extents are degenerate: west=${west} east=${east} south=${south} north=${north}`,
    );
  }
  const corners: LonLat[] = [
    frame.localToWgs84(west, south),
    frame.localToWgs84(east, south),
    frame.localToWgs84(east, north),
    frame.localToWgs84(west, north),
  ];
  for (const [lon, lat] of corners) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      throw new Error(`xodr extents project outside WGS84: ${lon}, ${lat}`);
    }
  }
  return {
    polygon: [...corners, corners[0] as LonLat],
    center: frame.localToWgs84((west + east) / 2, (south + north) / 2),
  };
}
