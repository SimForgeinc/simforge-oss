import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import { buildCityManifest, buildSemantics } from "../app/lib/map-ingest/server/city-manifest";
import { buildMapColliderDerivative } from "../app/lib/map-ingest/server/colliders";
import { buildDerivedArtifacts, MAP_INTEL_BUILDER_VERSION } from "../app/lib/map-ingest/server/derived";
import { buildRoadSidecars } from "../app/lib/map-ingest/server/sidecars";
import { buildStarterRoadGlb, STARTER_ROAD, STARTER_ROAD_HALF_LENGTH_M } from "./starter-road-geometry";

export const STARTER_MAP = [
  "simforge-starter-road",
  "SimForge Starter Road",
  "Local demo",
] as const;

/**
 * Bump whenever the generated closure changes shape or content. The marker is a
 * dotfile so publication never lists it as a browser member, and a stale
 * version wipes the generated map root so no member from an older layout
 * survives into the next publication.
 */
const STARTER_MAP_VERSION = 5;

/**
 * One straight two-lane road, described from the same {@link STARTER_ROAD}
 * record the road GLB is built from: header extents, reference line and lane
 * widths are the authored numbers, not a transcription of them.
 */
const XODR = `<?xml version="1.0" standalone="yes"?>
<OpenDRIVE>
<header revMajor="1" revMinor="4" name="SimForge Starter Road" version="1.00" date="1970-01-01T00:00:00Z" north="${STARTER_ROAD.laneWidthM}" south="${-STARTER_ROAD.laneWidthM}" east="${STARTER_ROAD_HALF_LENGTH_M}" west="${-STARTER_ROAD_HALF_LENGTH_M}" vendor="SimForge"><geoReference><![CDATA[+proj=utm +zone=10 +datum=WGS84 +units=m +no_defs]]></geoReference></header>
<road name="Starter Road" length="${STARTER_ROAD.lengthM}" id="1" junction="-1">
<link/>
<type s="0" type="town"><speed max="50" unit="km/h"/></type>
<planView>
<geometry s="0" x="${-STARTER_ROAD_HALF_LENGTH_M}" y="0" hdg="0" length="${STARTER_ROAD.lengthM}"><line/></geometry>
</planView>
<elevationProfile><elevation s="0" a="0" b="0" c="0" d="0"/></elevationProfile>
<lateralProfile/>
<lanes>
<laneOffset s="0" a="0" b="0" c="0" d="0"/>
<laneSection s="0">
<left>
<lane id="1" type="driving" level="false">
<link/>
<width sOffset="0" a="${STARTER_ROAD.laneWidthM}" b="0" c="0" d="0"/>
<roadMark sOffset="0" type="broken" weight="standard" color="white" width="${STARTER_ROAD.edgeMarkWidthM}" laneChange="both"/>
</lane>
</left>
<center>
<lane id="0" type="none" level="false">
<link/>
<roadMark sOffset="0" type="solid" weight="standard" color="yellow" width="${STARTER_ROAD.centreMarkWidthM}" laneChange="none"/>
</lane>
</center>
<right>
<lane id="-1" type="driving" level="false">
<link/>
<width sOffset="0" a="${STARTER_ROAD.laneWidthM}" b="0" c="0" d="0"/>
<roadMark sOffset="0" type="broken" weight="standard" color="white" width="${STARTER_ROAD.edgeMarkWidthM}" laneChange="both"/>
</lane>
</right>
</laneSection>
</lanes>
<objects/>
<signals/>
<surface/>
</road>
</OpenDRIVE>
`;

const ROAD_LAYER_FILE = "tiles/road.glb";

function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function gzipJson(value: unknown): Buffer {
  return gzipSync(Buffer.from(`${JSON.stringify(value)}\n`), { level: 9 });
}

/**
 * Materialize the tiny, checked-source starter world used by a clean Studio
 * checkout. Every member is generated: the road GLB from the authored
 * dimensions, and the browser-facing members (city manifest, semantics, road
 * sidecars, map-intel derivatives and the static-collider derivative) from the
 * same builders the map upload publish route runs, so the playback loader
 * verifies the starter closure exactly like an uploaded map:
 * `variants/manifest.json` binds the manifest bytes' SHA-256 and the artifact
 * it names is digest-checked before use.
 */
export async function ensureStarterMapAssets(assetsRoot: string): Promise<void> {
  const mapRoot = resolve(assetsRoot, STARTER_MAP[0]);
  const markerPath = resolve(mapRoot, ".starter-map-version.json");
  try {
    const marker = JSON.parse(await readFile(markerPath, "utf8")) as { version?: number };
    if (marker.version === STARTER_MAP_VERSION) return;
  } catch {
    // First boot or an older generated starter map: rebuild deterministically.
  }
  await rm(mapRoot, { recursive: true, force: true });

  const roadGlb = buildStarterRoadGlb();
  const layers = [{ layerId: "road" as const, fileName: ROAD_LAYER_FILE, bytes: roadGlb }];
  const city = buildCityManifest(layers);
  const semantics = buildSemantics(layers);
  if (!semantics) throw new Error("starter road semantics generation produced no document");
  const xodrSha256 = sha256(XODR);
  const sidecars = buildRoadSidecars({ xodrText: XODR, xodrSha256, mapName: STARTER_MAP[0] });
  const derived = buildDerivedArtifacts({
    mapId: STARTER_MAP[0],
    xodrText: XODR,
    xodrSha256,
    topologyIndex: sidecars.topology.index,
    topologyBytes: sidecars.topology.bytes,
    lanePolygonsJson: sidecars.lanePolygons.json,
    signalsJson: sidecars.signals.json,
    manifest: city.manifest,
    roadGlbBytes: roadGlb,
  });
  const colliders = buildMapColliderDerivative({
    mapId: STARTER_MAP[0],
    manifest: city.manifest,
    manifestBytes: city.bytes,
    topologyIndex: sidecars.topology.index,
    layers,
  });

  const mapGeoJson = {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: { name: "Starter Road", highway: "residential" },
      geometry: {
        type: "LineString",
        coordinates: [[-STARTER_ROAD_HALF_LENGTH_M, 0], [STARTER_ROAD_HALF_LENGTH_M, 0]],
      },
    }],
  };
  // Same receipt the upload publish route records for a published map, bound
  // to the catalog revision map-intel actually minted for these sources.
  const { catalogRevision } = JSON.parse(
    gunzipSync(derived.locations.bytes).toString("utf8"),
  ) as { catalogRevision: string };
  const receipt = {
    contractVersion: "uniscenario.map-intel-build/v1",
    builder: { package: "@simforge-oss/maps", version: MAP_INTEL_BUILDER_VERSION },
    mapId: STARTER_MAP[0],
    catalogRevision,
    sourceHashes: {
      xodr: xodrSha256,
      "topology-index": sha256(sidecars.topology.bytes),
      "lane-polygons": sha256(sidecars.lanePolygons.bytes),
      signals: sha256(sidecars.signals.bytes),
    },
    outputs: {
      locations: {
        path: "derived/locations.json.gz",
        sha256: sha256(derived.locations.bytes),
        sizeBytes: derived.locations.bytes.byteLength,
      },
      derivedTopology: {
        path: "derived/topology-derived.json.gz",
        sha256: sha256(derived.derivedTopology.bytes),
        sizeBytes: derived.derivedTopology.bytes.byteLength,
      },
    },
    locationsBytes: derived.locations.bytes.byteLength,
    derivedBytes: derived.derivedTopology.bytes.byteLength,
  };

  await Promise.all([
    mkdir(resolve(mapRoot, "3d/tiles"), { recursive: true }),
    mkdir(resolve(mapRoot, dirname(colliders.artifact.relativePath)), { recursive: true }),
    mkdir(resolve(mapRoot, "derived"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(resolve(mapRoot, "3d", ROAD_LAYER_FILE), roadGlb),
    writeFile(resolve(mapRoot, "map.xodr"), XODR),
    writeFile(resolve(mapRoot, "topology-index.json.gz"), sidecars.topology.bytes),
    writeFile(resolve(mapRoot, "lane-polygons.geojson.gz"), sidecars.lanePolygons.bytes),
    writeFile(resolve(mapRoot, "signals.geojson.gz"), sidecars.signals.bytes),
    writeFile(resolve(mapRoot, "map.geojson.gz"), gzipJson(mapGeoJson)),
    writeFile(resolve(mapRoot, "3d/manifest.json"), city.bytes),
    writeFile(resolve(mapRoot, "3d/semantics.json"), semantics.bytes),
    writeFile(resolve(mapRoot, colliders.variantManifest.relativePath), colliders.variantManifest.bytes),
    writeFile(resolve(mapRoot, colliders.artifact.relativePath), colliders.artifact.bytes),
    writeFile(resolve(mapRoot, "derived/topology-derived.json.gz"), derived.derivedTopology.bytes),
    writeFile(resolve(mapRoot, "derived/locations.json.gz"), derived.locations.bytes),
    writeFile(resolve(mapRoot, "derived/roadway-consistency.json.gz"), derived.roadwayConsistency.bytes),
    writeFile(
      resolve(mapRoot, "derived/map-intel-build-receipt.json"),
      `${JSON.stringify(receipt, null, 2)}\n`,
    ),
  ]);
  await writeFile(markerPath, `${JSON.stringify({ version: STARTER_MAP_VERSION })}\n`);
}
