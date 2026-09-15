#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createHttpStudioHost } from "../packages/studio-host/dist/index.js";

const [baseUrl, token] = process.argv.slice(2);
if (!baseUrl || !token) {
  console.error("usage: node scripts/map-load-acceptance.mjs <host-origin> <bearer-token>");
  process.exitCode = 2;
  process.exit();
}

const origin = new URL(baseUrl);
if (origin.pathname !== "/" || origin.search || origin.hash) {
  throw new Error("host origin must be a bare http(s) origin");
}

const headers = { authorization: `Bearer ${token}` };
const host = createHttpStudioHost({ baseUrl: origin.origin, headers });
const fetchAsset = async (rawUrl, label) => {
  const url = new URL(rawUrl, origin.origin);
  if (url.origin !== origin.origin) throw new Error(`${label}: asset escapes host origin (${url.origin})`);
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const maps = await host.artifacts.listMaps(undefined, { fresh: true });
if (maps.length === 0) throw new Error("host returned zero maps");
const results = [];
for (const map of maps) {
  const root = map.browserAssetRootUrl.replace(/\/+$/, "");
  if (map.browserManifestUrl !== `${root}/3d/manifest.json`) {
    throw new Error(`${map.mapVersionId}: manifest is outside declared asset root`);
  }
  const manifest = await fetchAsset(map.browserManifestUrl, `${map.mapVersionId}/manifest`);
  let manifestJson;
  try {
    manifestJson = JSON.parse(Buffer.from(manifest, "utf8"));
  } catch {
    throw new Error(`${map.mapVersionId}: manifest is not JSON`);
  }
  if (!manifestJson || typeof manifestJson !== "object") {
    throw new Error(`${map.mapVersionId}: manifest has invalid shape`);
  }
  const assets = [
    ["map.xodr", map.artifacts.xodrSha256],
    ["topology-index.json.gz", map.artifacts.topologySha256],
    ["lane-polygons.geojson.gz", map.artifacts.lanePolygonsSha256],
    ["signals.geojson.gz", map.artifacts.signalsSha256],
    ["derived/topology-derived.json.gz", map.artifacts.derivedTopologySha256],
    ["derived/locations.json.gz", map.artifacts.locationsSha256],
  ];
  if (map.sumoNetworkSha256) assets.push(["derived/sumo/sumo-network-manifest.json", null]);
  let verifiedBytes = manifest.byteLength;
  for (const [path, expected] of assets) {
    const bytes = await fetchAsset(`${root}/${path}`, `${map.mapVersionId}/${path}`);
    const actual = sha256(bytes);
    if (expected && actual !== expected) throw new Error(`${map.mapVersionId}/${path}: digest mismatch`);
    verifiedBytes += bytes.byteLength;
  }
  results.push({ mapVersionId: map.mapVersionId, manifestSha256: sha256(manifest), artifactCount: assets.length, verifiedBytes });
}

console.log(JSON.stringify({ host: origin.origin, mapCount: results.length, maps: results }, null, 2));
