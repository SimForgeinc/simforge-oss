import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, posix, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import sharp from "sharp";
import { z } from "zod";

import { parseRoadwayConsistencyReport } from "@simforge-oss/maps/ingest";
import type { MapTopologyIndex } from "@simforge-oss/maps/topology";
import { LOCAL_USER_ID, LOCAL_WORKSPACE_ID } from "@/app/lib/auth/session";
import { execute } from "@/app/lib/db/data-api";
import { LOCAL_ARTIFACT_BUCKET } from "@/app/lib/db/config";
import { upsertMapAsset } from "@/app/lib/db/map-asset-store";
import { extractCoordinateRefFromXodr } from "@/app/lib/maps/metadata/xodr";
import { registerLocalFile, writeLocalObject, type LocalObjectMetadata } from "@/app/lib/s3/s3-object";
import {
  planNativeMapAssetSet,
  planUploadedMapClosure,
  REQUIRED_BROWSER_MEMBERS,
  type UploadedMapClosureMemberInput,
} from "./closure";
import { publishUploadedMapVersion, type PublishedMapIntel } from "./publication";
import { publishedMapReleaseId } from "./release-id";
import { nativeMasterResources } from "../native-master-resources";

export type DevAssetMap = readonly [slug: string, label: string, locality: string];

const SHA256 = /^[a-f0-9]{64}$/;
const Sha256Schema = z.string().regex(SHA256);
const SafeMemberPathSchema = z.string().refine(
  (path) =>
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.split("/").some((part) => part === "" || part === "." || part === "..") &&
    !/[\u0000-\u001f\u007f]/u.test(path),
  { message: "unsafe installation member path" },
);

/** One profile's `.map-release.json`, written by the registry installer after every member verified. */
export const MapInstallationReceiptSchema = z.object({
  schema: z.literal("simforge.map-installation.v1"),
  name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  version: z.string().regex(/^v[1-9][0-9]*$/),
  releaseDigest: Sha256Schema,
  canonicalDigest: Sha256Schema,
  webDigest: Sha256Schema.optional(),
  profile: z.enum(["semantic", "native", "web"]),
  members: z.record(
    SafeMemberPathSchema,
    z.object({ sha256: Sha256Schema, bytes: z.number().int().nonnegative() }),
  ),
});
export type MapInstallationReceipt = z.infer<typeof MapInstallationReceiptSchema>;

export type RegistryMapInstallation = {
  semanticRoot: string;
  webRoot: string;
  nativeRoot: string;
  semanticReceipt: MapInstallationReceipt;
  webReceipt: MapInstallationReceipt;
  nativeReceipt: MapInstallationReceipt;
};

type GeoJson = { features?: Array<{ geometry?: { coordinates?: unknown } }> };
type Manifest = {
  scene?: { totalTriangles?: number };
};
/** `derived/map-intel-build-receipt.json`, written by the Starter Road generator. */
const BuildReceiptSchema = z.object({
  contractVersion: z.string().min(1),
  builder: z.object({ package: z.string().min(1), version: z.string().min(1) }),
  mapId: z.string().min(1),
  catalogRevision: z.string().min(1),
  sourceHashes: z.record(z.string(), Sha256Schema),
  outputs: z.record(z.string(), z.unknown()),
});
/** `derived/locations.json.gz`: the map-intel catalog every release and the Starter carry. */
const LocationsSchema = z.object({
  catalogRevision: z.string().min(1),
  sourceHashes: z.record(z.string(), Sha256Schema),
  locations: z.array(z.unknown()),
});
const GeographySchema = z.object({
  bounds: z.object({
    min_lat: z.number().finite(),
    min_lng: z.number().finite(),
    max_lat: z.number().finite(),
    max_lng: z.number().finite(),
  }),
  center: z.object({ lat: z.number().finite(), lng: z.number().finite() }),
});
/** `derived/source-capabilities.json.gz`: only the fields publication binds. */
const SourceCapabilitiesSchema = z.object({
  geography: GeographySchema,
  thumbnail: z.object({ path: SafeMemberPathSchema, recipe: z.string().min(1).optional() }),
});

type StoredMember = UploadedMapClosureMemberInput & {
  metadata: LocalObjectMetadata;
  sourcePath?: string;
};

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

/**
 * Browser members every installed release must carry. The registry installer
 * materializes the web profile as the web closure plus every canonical semantic
 * member, so the web receipt alone is the complete browser publication input.
 */
const REQUIRED_INSTALLED_WEB_MEMBERS: readonly string[] = [
  ...REQUIRED_BROWSER_MEMBERS,
  "map.geojson.gz",
  "derived/source-capabilities.json.gz",
];

/** Map-intel source hash names and the closure member each must equal. */
const SOURCE_HASH_MEMBERS: Readonly<Record<string, string>> = {
  xodr: "map.xodr",
  "topology-index": "topology-index.json.gz",
  "lane-polygons": "lane-polygons.geojson.gz",
  signals: "signals.geojson.gz",
  "map-geojson": "map.geojson.gz",
};

function mediaType(path: string): string {
  if (path.endsWith(".geojson.gz") || path.endsWith(".json.gz") || path.endsWith(".xml.gz")) {
    return "application/gzip";
  }
  switch (extname(path).toLowerCase()) {
    case ".json": return "application/json";
    case ".geojson": return "application/geo+json";
    case ".xml": return "application/xml";
    case ".xodr": return "application/xml";
    case ".glb": return "model/gltf-binary";
    case ".gltf": return "model/gltf+json";
    case ".png": return "image/png";
    case ".webp": return "image/webp";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".ktx2": return "image/ktx2";
    case ".bin": return "application/octet-stream";
    default: return "application/octet-stream";
  }
}

async function stableFiles(root: string, directory = ""): Promise<string[]> {
  const entries = await readdir(resolve(root, directory), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".")) continue;
    const relativePath = directory ? posix.join(directory, entry.name) : entry.name;
    if (entry.isDirectory()) files.push(...await stableFiles(root, relativePath));
    else if (entry.isFile()) files.push(relativePath);
  }
  return files;
}

function coordinatePairs(value: unknown, output: Array<[number, number]>, limit = Number.POSITIVE_INFINITY): void {
  if (output.length >= limit || !Array.isArray(value)) return;
  if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
    if (Number.isFinite(value[0]) && Number.isFinite(value[1])) output.push([value[0], value[1]]);
    return;
  }
  for (const child of value) coordinatePairs(child, output, limit);
}

function geoBounds(geojson: GeoJson): { minX: number; minY: number; maxX: number; maxY: number } {
  const points: Array<[number, number]> = [];
  for (const feature of geojson.features ?? []) coordinatePairs(feature.geometry?.coordinates, points);
  if (points.length === 0) throw new Error("road-network GeoJSON contains no coordinates");
  return points.reduce(
    (bounds, [x, y]) => ({
      minX: Math.min(bounds.minX, x), minY: Math.min(bounds.minY, y),
      maxX: Math.max(bounds.maxX, x), maxY: Math.max(bounds.maxY, y),
    }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  );
}

async function renderRoadThumbnail(label: string, geojson: GeoJson): Promise<Buffer> {
  const width = 640;
  const height = 360;
  const margin = 24;
  const bounds = geoBounds(geojson);
  const spanX = Math.max(bounds.maxX - bounds.minX, Number.EPSILON);
  const spanY = Math.max(bounds.maxY - bounds.minY, Number.EPSILON);
  const scale = Math.min((width - margin * 2) / spanX, (height - margin * 2) / spanY);
  const offsetX = (width - spanX * scale) / 2;
  const offsetY = (height - spanY * scale) / 2;

  const paths: string[] = [];
  let renderedPoints = 0;
  for (const feature of geojson.features ?? []) {
    if (renderedPoints >= 24_000) break;
    const points: Array<[number, number]> = [];
    coordinatePairs(feature.geometry?.coordinates, points, 500);
    if (points.length < 2) continue;
    const d = points.map(([x, y], index) => {
      const px = offsetX + (x - bounds.minX) * scale;
      const py = height - (offsetY + (y - bounds.minY) * scale);
      return `${index === 0 ? "M" : "L"}${px.toFixed(1)} ${py.toFixed(1)}`;
    }).join(" ");
    paths.push(`<path d="${d}"/>`);
    renderedPoints += points.length;
  }
  const safeLabel = label.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;",
  })[character]!);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="#17212b"/><stop offset="1" stop-color="#071014"/></linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#bg)"/>
    <g fill="none" stroke="#43d7b5" stroke-opacity=".7" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">${paths.join("")}</g>
    <rect x="18" y="306" width="${Math.min(360, 34 + safeLabel.length * 10)}" height="36" rx="8" fill="#071014" fill-opacity=".82"/>
    <text x="32" y="330" fill="#f4f7f8" font-family="sans-serif" font-size="18" font-weight="600">${safeLabel}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).webp({ quality: 88 }).toBuffer();
}
function assertNativeMasterClosure(master: unknown, paths: ReadonlySet<string>): void {
  if (!master || typeof master !== "object" || Array.isArray(master)) {
    throw new Error("native master.gltf is not a JSON object");
  }
  for (const uri of nativeMasterResources(master)) {
    const relativePath = posix.normalize(uri.replace(/^\.\//, ""));
    if (
      relativePath.startsWith("../") ||
      relativePath.startsWith("/") ||
      /^[a-z][a-z0-9+.-]*:/i.test(relativePath) ||
      !paths.has(relativePath)
    ) {
      throw new Error(`native master.gltf dependency is not installed: ${uri}`);
    }
  }
}

function jsonFromGzip<T>(bytes: Buffer): T {
  return JSON.parse(gunzipSync(bytes).toString("utf8")) as T;
}

/**
 * Read one profile's `.map-release.json` and confirm every declared member is
 * present at its declared size. Digests are verified when members are stored.
 */
async function readInstallationReceipt(
  root: string,
  name: string,
  profile: MapInstallationReceipt["profile"],
): Promise<MapInstallationReceipt> {
  let raw: string;
  try {
    raw = await readFile(resolve(root, ".map-release.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`${profile} profile is not installed at ${root}`);
    }
    throw error;
  }
  const parsed = MapInstallationReceiptSchema.safeParse(JSON.parse(raw));
  if (!parsed.success || parsed.data.name !== name || parsed.data.profile !== profile) {
    throw new Error(`invalid ${profile} installation receipt at ${root}`);
  }
  const receipt = parsed.data;
  for (const [relativePath, member] of Object.entries(receipt.members)) {
    let memberStat;
    try {
      memberStat = await stat(resolve(root, relativePath));
    } catch {
      throw new Error(`${profile} receipt member is missing: ${relativePath}`);
    }
    if (!memberStat.isFile() || memberStat.size !== member.bytes) {
      throw new Error(`${profile} receipt member does not match its receipt size: ${relativePath}`);
    }
  }
  return receipt;
}

/**
 * Resolve the three installed profiles of one immutable registry release.
 *
 * The receipts must name one release (version, release digest, canonical
 * digest, web digest), members shared by the semantic and web profiles must be
 * the same bytes, the web profile must carry every browser publication input,
 * and the native profile must carry `master.gltf`. Nothing here depends on
 * build-only files: the release contract is exactly what the registry publishes.
 */
export async function resolveRegistryMapInstallation(input: {
  name: string;
  semanticRoot: string;
  webRoot: string;
  nativeRoot: string;
}): Promise<RegistryMapInstallation> {
  const { name, semanticRoot, webRoot, nativeRoot } = input;
  const [semanticReceipt, webReceipt, nativeReceipt] = await Promise.all([
    readInstallationReceipt(semanticRoot, name, "semantic"),
    readInstallationReceipt(webRoot, name, "web"),
    readInstallationReceipt(nativeRoot, name, "native"),
  ]);
  if (!webReceipt.webDigest) {
    throw new Error(`web profile of ${name} has no web closure digest`);
  }
  for (const receipt of [semanticReceipt, nativeReceipt]) {
    if (
      receipt.version !== webReceipt.version ||
      receipt.releaseDigest !== webReceipt.releaseDigest ||
      receipt.canonicalDigest !== webReceipt.canonicalDigest ||
      (receipt.webDigest !== undefined && receipt.webDigest !== webReceipt.webDigest)
    ) {
      throw new Error(
        `${receipt.profile} profile of ${name} is ${receipt.version} release ${receipt.releaseDigest}, `
        + `web profile is ${webReceipt.version} release ${webReceipt.releaseDigest}`,
      );
    }
  }
  for (const [relativePath, semanticMember] of Object.entries(semanticReceipt.members)) {
    const webMember = webReceipt.members[relativePath];
    if (
      webMember &&
      (webMember.sha256 !== semanticMember.sha256 || webMember.bytes !== semanticMember.bytes)
    ) {
      throw new Error(`semantic/web profile conflict for ${name}: ${relativePath}`);
    }
  }
  const missing = REQUIRED_INSTALLED_WEB_MEMBERS.filter((path) => !webReceipt.members[path]);
  if (missing.length > 0) {
    throw new Error(`web profile of ${name} lacks browser publication members: ${missing.join(", ")}`);
  }
  if (!nativeReceipt.members["master.gltf"]) {
    throw new Error(`native profile of ${name} lacks master.gltf`);
  }
  return { semanticRoot, webRoot, nativeRoot, semanticReceipt, webReceipt, nativeReceipt };
}

/**
 * Every map-intel source hash that names a published closure member must equal
 * that member's stored digest; the XODR and topology hashes are mandatory
 * because the roadway audit is bound through them.
 */
function assertSourceHashesBound(
  slug: string,
  sourceHashes: Record<string, string>,
  memberSha256: (path: string) => string,
): void {
  for (const required of ["xodr", "topology-index"]) {
    if (!sourceHashes[required]) throw new Error(`${slug} map-intel source hashes lack ${required}`);
  }
  for (const [source, digest] of Object.entries(sourceHashes)) {
    const path = SOURCE_HASH_MEMBERS[source];
    if (path && memberSha256(path) !== digest) {
      throw new Error(`${slug} map-intel source hash ${source} does not match closure member ${path}`);
    }
  }
}

async function storeSourceMember(
  mapRoot: string,
  slug: string,
  relativePath: string,
  keyPrefix = "",
  expected?: { sha256: string; bytes: number },
): Promise<StoredMember> {
  const sourcePath = resolve(mapRoot, relativePath);
  const key = `maps/${slug}/${keyPrefix}${relativePath}`;
  const metadata = await registerLocalFile(
    LOCAL_ARTIFACT_BUCKET,
    key,
    sourcePath,
    mediaType(relativePath),
  );
  if (
    expected &&
    (metadata.checksumSha256Hex !== expected.sha256 || metadata.sizeBytes !== expected.bytes)
  ) {
    throw new Error(`${slug} installation member does not match receipt: ${relativePath}`);
  }
  return {
    relativePath,
    sha256: metadata.checksumSha256Hex,
    byteLength: metadata.sizeBytes,
    mediaType: mediaType(relativePath),
    bucket: LOCAL_ARTIFACT_BUCKET,
    key,
    metadata,
    sourcePath,
  };
}

/**
 * Generated starter members live at content-addressed keys, like every
 * generated member: republishing a regenerated Starter Road must never rewrite
 * the bytes an earlier starter version's blob rows still resolve to.
 */
async function storeStarterMember(mapRoot: string, relativePath: string): Promise<StoredMember> {
  const sourcePath = resolve(mapRoot, relativePath);
  const digest = sha256(await readFile(sourcePath));
  const key = `map-closure/${digest}`;
  const metadata = await registerLocalFile(LOCAL_ARTIFACT_BUCKET, key, sourcePath, mediaType(relativePath));
  return {
    relativePath,
    sha256: digest,
    byteLength: metadata.sizeBytes,
    mediaType: mediaType(relativePath),
    bucket: LOCAL_ARTIFACT_BUCKET,
    key,
    metadata,
    sourcePath,
  };
}

async function storeGeneratedMember(relativePath: string, bytes: Buffer): Promise<StoredMember> {
  const digest = sha256(bytes);
  const key = `map-closure/${digest}`;
  const metadata = await writeLocalObject(LOCAL_ARTIFACT_BUCKET, key, bytes, mediaType(relativePath));
  return {
    relativePath,
    sha256: digest,
    byteLength: bytes.byteLength,
    mediaType: mediaType(relativePath),
    bucket: LOCAL_ARTIFACT_BUCKET,
    key,
    metadata,
  };
}

export async function publishDevAssetMap({
  map,
  assetsRoot,
  installation,
  assetCatalogVersionId,
  activeReleaseId,
}: {
  map: DevAssetMap;
  assetsRoot?: string;
  installation?: RegistryMapInstallation;
  assetCatalogVersionId: string;
  activeReleaseId: string;
}) {
  const [slug, label, locality] = map;
  if ((assetsRoot === undefined) === (installation === undefined)) {
    throw new Error("exactly one of assetsRoot or installation is required");
  }
  const semanticRoot = installation?.semanticRoot ?? resolve(assetsRoot!, slug);
  const browserRoot = installation?.webRoot ?? semanticRoot;

  // An installed web profile is self-contained (web closure plus canonical
  // semantic members), so it alone is the browser closure; every member is
  // digest-checked against its receipt as it is stored. The Starter Road is
  // generated in place and stored content-addressed.
  const members: StoredMember[] = [];
  if (installation) {
    for (const [relativePath, expected] of Object.entries(installation.webReceipt.members)
      .sort(([left], [right]) => left.localeCompare(right))) {
      members.push(await storeSourceMember(browserRoot, slug, relativePath, "", expected));
    }
    members.push(await storeSourceMember(browserRoot, slug, ".map-release.json"));
  } else {
    for (const relativePath of await stableFiles(semanticRoot)) {
      members.push(await storeStarterMember(semanticRoot, relativePath));
    }
  }
  const byPath = new Map(members.map((member) => [member.relativePath, member]));
  const requireMember = (path: string) => {
    const member = byPath.get(path);
    if (!member) throw new Error(`${slug} publication input missing ${path}`);
    return member;
  };

  // Starter Road alone may need generated derivatives. Registry installations
  // must carry the source pipeline's immutable reports unchanged.
  const sumoManifestPath = "derived/sumo/sumo-network-manifest.json";
  const sourceSumoMember = byPath.get(sumoManifestPath);
  if (!installation && sourceSumoMember?.sourcePath) {
    const sourceSumoManifest = JSON.parse(
      await readFile(sourceSumoMember.sourcePath, "utf8"),
    ) as Record<string, unknown>;
    const sumoManifestMember = await storeGeneratedMember(
      sumoManifestPath,
      Buffer.from(`${JSON.stringify({ ...sourceSumoManifest, sourceMapId: slug })}\n`),
    );
    const sumoManifestIndex = members.findIndex(
      (member) => member.relativePath === sumoManifestPath,
    );
    members[sumoManifestIndex] = sumoManifestMember;
    byPath.set(sumoManifestPath, sumoManifestMember);
  }

  const xodrMember = requireMember("map.xodr");
  const xodrBytes = await readFile(xodrMember.sourcePath!);
  const xodrText = xodrBytes.toString("utf8");
  const manifestBytes = await readFile(requireMember("3d/manifest.json").sourcePath!);
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as Manifest;
  const topologyMember = requireMember("topology-index.json.gz");
  const topology = jsonFromGzip<MapTopologyIndex>(await readFile(topologyMember.sourcePath!));
  // The roadway audit is published exactly as its producer wrote it, bound to
  // this map and to the XODR and topology bytes in the closure. A failed verdict
  // is published as failed.
  const roadwayMember = requireMember("derived/roadway-consistency.json.gz");
  const roadwayReport = parseRoadwayConsistencyReport(await readFile(roadwayMember.sourcePath!), {
    mapId: slug,
    sourceDigests: { xodrSha256: xodrMember.sha256, topologySha256: topologyMember.sha256 },
  });

  const roadGeoJsonCompressed = await readFile(requireMember("map.geojson.gz").sourcePath!);
  const roadGeoJsonBytes = gunzipSync(roadGeoJsonCompressed);
  const roadGeoJson = JSON.parse(roadGeoJsonBytes.toString("utf8")) as GeoJson;
  const geojsonKey = `maps/${slug}/map.geojson`;
  const geojsonMetadata = await writeLocalObject(
    LOCAL_ARTIFACT_BUCKET, geojsonKey, roadGeoJsonBytes, "application/geo+json",
  );

  let thumbnailMetadata: LocalObjectMetadata;
  let thumbnailKey: string;
  let thumbnailRecipe: string;
  let geography: z.infer<typeof GeographySchema> | undefined;
  if (installation) {
    const capabilities = SourceCapabilitiesSchema.parse(jsonFromGzip<unknown>(
      await readFile(requireMember("derived/source-capabilities.json.gz").sourcePath!),
    ));
    const thumbnail = requireMember(capabilities.thumbnail.path);
    thumbnailMetadata = thumbnail.metadata;
    thumbnailKey = thumbnail.key;
    thumbnailRecipe = capabilities.thumbnail.recipe ?? "registry-source-thumbnail";
    geography = capabilities.geography;
  } else {
    const thumbnailBytes = await renderRoadThumbnail(label, roadGeoJson);
    thumbnailKey = `maps/${slug}/thumbnail.webp`;
    thumbnailMetadata = await writeLocalObject(
      LOCAL_ARTIFACT_BUCKET, thumbnailKey, thumbnailBytes, "image/webp",
    );
    thumbnailRecipe = "uniscenario.road-network-thumbnail/v1";
  }

  const sourceMapId = slug;
  const releaseDigest = installation?.webReceipt.releaseDigest;
  const draftId = `usmapdraft_${sha256(
    releaseDigest ? `registry:${slug}:${releaseDigest}` : `dev-assets:${slug}`,
  ).slice(0, 32)}`;
  await upsertMapAsset({
    map_asset_id: sourceMapId,
    name: label,
    carla_map_name: installation ? null : slug.replaceAll("-", "_"),
    ue5_carla_map_name: installation ? null : slug.replaceAll("-", "_"),
    description: `${label} ${installation ? "installed registry" : "local development"} map`,
    crs: "OpenDRIVE",
    bbox: geography?.bounds ?? { min_lat: 0, min_lng: 0, max_lat: 0, max_lng: 0 },
    center: geography?.center ?? { lat: 0, lng: 0 },
    created_at: new Date(0).toISOString(),
    tags: installation ? ["local", "registry"] : ["local", "seeded"],
    map_coordinate_ref: extractCoordinateRefFromXodr(xodrText),
    map_source: installation
      ? {
        tool: "SimForge map registry",
        tool_version: installation.webReceipt.version,
        vendor: `release-sha256:${releaseDigest}`,
      }
      : { tool: "SimForge dev-assets publication" },
    place_context: { city: locality, geocoder: "manual" },
    artifacts: [
      {
        artifact_type: "xodr", uri: `s3://${LOCAL_ARTIFACT_BUCKET}/${requireMember("map.xodr").key}`,
        sha256: requireMember("map.xodr").sha256, size_bytes: xodrBytes.byteLength,
        created_at: new Date(0).toISOString(),
      },
      {
        artifact_type: "geojson", uri: `s3://${LOCAL_ARTIFACT_BUCKET}/${geojsonKey}`,
        sha256: geojsonMetadata.checksumSha256Hex, size_bytes: geojsonMetadata.sizeBytes,
        created_at: new Date(0).toISOString(),
      },
      {
        artifact_type: "thumbnail", uri: `s3://${LOCAL_ARTIFACT_BUCKET}/${thumbnailKey}`,
        sha256: thumbnailMetadata.checksumSha256Hex, size_bytes: thumbnailMetadata.sizeBytes,
        created_at: new Date(0).toISOString(),
      },
    ],
  });
  await execute(
    `INSERT INTO simforge.map_upload_drafts (
       id, workspace_id, created_by_user_id, label, locality, carla_map_name,
       source_map_id, xodr_sha256, xodr_byte_length, thumbnail_sha256,
       thumbnail_byte_length, layers, preflight, draft_state
     ) VALUES (
       :id, :workspace_id, :user_id, :label, :locality, :carla_map_name,
       :source_map_id, :xodr_sha256, :xodr_byte_length, :thumbnail_sha256,
       :thumbnail_byte_length, CAST(:layers AS jsonb), CAST(:preflight AS jsonb), 'publishing'
     ) ON CONFLICT (id) DO NOTHING`,
    {
      id: draftId,
      workspace_id: LOCAL_WORKSPACE_ID,
      user_id: LOCAL_USER_ID,
      label,
      locality,
      carla_map_name: installation ? null : slug.replaceAll("-", "_"),
      source_map_id: sourceMapId,
      xodr_sha256: requireMember("map.xodr").sha256,
      xodr_byte_length: xodrBytes.byteLength,
      thumbnail_sha256: thumbnailMetadata.checksumSha256Hex,
      thumbnail_byte_length: thumbnailMetadata.sizeBytes,
      layers: [],
      preflight: {
        source: installation ? "map-registry" : "dev-assets",
        fullPublishedClosure: true,
        ...(releaseDigest ? { registryReleaseDigest: releaseDigest } : {}),
      },
    },
  );

  const derivativeReleaseId = releaseDigest ?? publishedMapReleaseId({
    activeReleaseId,
    members,
  });
  const plan = planUploadedMapClosure({
    workspaceId: LOCAL_WORKSPACE_ID,
    sourceMapId,
    derivativeReleaseId,
    manifest,
    members,
  });
  let nativePlan;
  if (installation) {
    const nativeMembers: StoredMember[] = [];
    for (const [relativePath, expected] of Object.entries(installation.nativeReceipt.members)
      .sort(([left], [right]) => left.localeCompare(right))) {
      nativeMembers.push(await storeSourceMember(
        installation.nativeRoot,
        slug,
        relativePath,
        "native/",
        expected,
      ));
    }
    nativeMembers.push(await storeSourceMember(
      installation.nativeRoot,
      slug,
      ".map-release.json",
      "native/",
    ));
    const nativePaths = new Set(nativeMembers.map((member) => member.relativePath));
    const masterMember = nativeMembers.find((member) => member.relativePath === "master.gltf");
    if (!masterMember?.sourcePath) throw new Error(`${slug} native installation has no master.gltf`);
    assertNativeMasterClosure(
      JSON.parse(await readFile(masterMember.sourcePath, "utf8")),
      nativePaths,
    );
    nativePlan = planNativeMapAssetSet({
      workspaceId: LOCAL_WORKSPACE_ID,
      mapVersionId: plan.mapVersionId,
      registryReleaseDigest: installation.nativeReceipt.releaseDigest,
      canonicalDigest: installation.nativeReceipt.canonicalDigest,
      members: nativeMembers,
    });
  }
  if (installation && !nativePlan) throw new Error("registry native asset set was not planned");

  const locations = LocationsSchema.parse(jsonFromGzip<unknown>(
    await readFile(requireMember("derived/locations.json.gz").sourcePath!),
  ));
  const memberSha256 = (path: string) => requireMember(path).sha256;
  const counts = {
    locationCount: locations.locations.length,
    laneCount: Object.keys(topology.lanes).length,
    junctionCount: Object.keys(topology.junctions).length,
  };
  const roadwayConsistency: PublishedMapIntel["roadwayConsistency"] = {
    format: roadwayReport.format,
    validatorVersion: roadwayReport.validatorVersion,
    verdict: roadwayReport.verdict,
    stats: roadwayReport.stats,
    artifactSha256: roadwayMember.sha256,
    sourceDigests: roadwayReport.sourceDigests,
  };
  let mapIntel: PublishedMapIntel;
  if (installation) {
    // Same projection SimCloud records for a registry import: the release is
    // the receipt, and map-intel identity comes from the catalog it shipped.
    assertSourceHashesBound(slug, locations.sourceHashes, memberSha256);
    mapIntel = {
      contractVersion: "simforge.map-release.v1",
      builder: { package: "@simforge-oss/map-registry", version: "1" },
      mapId: slug,
      catalogRevision: locations.catalogRevision,
      sourceHashes: locations.sourceHashes,
      outputs: {},
      receiptSha256: installation.webReceipt.releaseDigest,
      ...counts,
      roadwayConsistency,
    };
  } else {
    const receiptBytes = await readFile(requireMember("derived/map-intel-build-receipt.json").sourcePath!);
    const receipt = BuildReceiptSchema.parse(JSON.parse(receiptBytes.toString("utf8")));
    if (receipt.mapId !== slug || receipt.catalogRevision !== locations.catalogRevision) {
      throw new Error(`${slug} map-intel build receipt does not describe its locations catalog`);
    }
    assertSourceHashesBound(slug, receipt.sourceHashes, memberSha256);
    mapIntel = {
      ...receipt,
      receiptSha256: sha256(receiptBytes),
      ...counts,
      roadwayConsistency,
    };
  }
  const result = await publishUploadedMapVersion({
    draftId,
    plan,
    workspaceId: LOCAL_WORKSPACE_ID,
    sourceMapId,
    sourceMapAssetId: sourceMapId,
    assetCatalogVersionId,
    derivativeReleaseId,
    label,
    locality,
    carlaMapName: installation ? null : slug.replaceAll("-", "_"),
    provenance: installation
      ? {
        kind: "map-registry-installation",
        name: slug,
        version: installation.webReceipt.version,
        releaseDigest: installation.webReceipt.releaseDigest,
        canonicalDigest: installation.webReceipt.canonicalDigest,
        ...(installation.webReceipt.webDigest
          ? { webDigest: installation.webReceipt.webDigest }
          : {}),
        semanticRoot,
        browserRoot,
        nativeRoot: installation.nativeRoot,
      }
      : { kind: "dev-assets-publication", source: semanticRoot },
    thumbnail: {
      bucket: LOCAL_ARTIFACT_BUCKET,
      key: thumbnailKey,
      sha256: thumbnailMetadata.checksumSha256Hex,
      byteLength: thumbnailMetadata.sizeBytes,
      mediaType: "image/webp",
      recipe: thumbnailRecipe,
      sourceBucket: LOCAL_ARTIFACT_BUCKET,
      sourceKey: installation ? thumbnailKey : geojsonKey,
    },
    mapIntel,
    triangleCount: manifest.scene?.totalTriangles ?? 0,
    ...(installation
      ? {
        registryReleaseDigest: installation.webReceipt.releaseDigest,
        nativePlan,
      }
      : {}),
  });
  await execute(
    `UPDATE simforge.map_upload_drafts
     SET draft_state = 'published', map_version_id = :map_version_id, updated_at = NOW()
     WHERE id = :id`,
    { id: draftId, map_version_id: result.mapVersionId },
  );
  return {
    ...result,
    sumoNetworkSha256: plan.sumoNetworkSha256,
    thumbnailBytes: thumbnailMetadata.sizeBytes,
  };
}
