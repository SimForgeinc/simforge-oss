import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, posix, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { z } from "zod";

import { parseRoadwayConsistencyReport } from "@simforge-oss/maps/ingest";
import type { MapTopologyIndex } from "@simforge-oss/maps/topology";
import { LOCAL_USER_ID, LOCAL_WORKSPACE_ID } from "@/app/lib/auth/session";
import { execute } from "@/app/lib/db/data-api";
import { LOCAL_ARTIFACT_BUCKET } from "@/app/lib/db/config";
import { upsertMapAsset } from "@/app/lib/db/map-asset-store";
import { extractCoordinateRefFromXodr } from "@/app/lib/maps/metadata/xodr";
import { registerLocalFile } from "@/app/lib/s3/s3-object";
import {
  planNativeMapAssetSet,
  planUploadedMapClosure,
  REQUIRED_BROWSER_MEMBERS,
  type UploadedMapClosureMemberInput,
} from "./closure";
import { publishUploadedMapVersion, type PublishedMapIntel } from "./publication";
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

type Manifest = {
  scene?: { totalTriangles?: number };
};
/** `derived/locations.json.gz`: the map-intel catalog every release carries. */
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

/**
 * One closure member whose verified bytes are readable at `sourcePath` and
 * registered at `bucket`/`key` for the blob rows.
 */
export type StoredMember = UploadedMapClosureMemberInput & {
  sourcePath: string;
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

export function mapMemberMediaType(path: string): string {
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
    mapMemberMediaType(relativePath),
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
    mediaType: mapMemberMediaType(relativePath),
    bucket: LOCAL_ARTIFACT_BUCKET,
    key,
    sourcePath,
  };
}

/** The immutable release identity a closure publication is bound to. */
export type MapClosureRelease = {
  /** Registry version label such as `v3`. */
  version: string;
  releaseDigest: string;
  canonicalDigest: string;
  webDigest?: string;
};

export type PublishMapClosureInput = {
  map: DevAssetMap;
  release: MapClosureRelease;
  /** Complete browser closure; every member readable at `sourcePath`. */
  browserMembers: StoredMember[];
  /** Complete native closure (master.gltf and its resources), when publishing the native set. */
  nativeMembers?: StoredMember[];
  assetCatalogVersionId: string;
  /** Use this immutable identity instead of deriving one; downloaded maps keep their upstream id. */
  mapVersionId?: string;
  provenance: Record<string, unknown>;
  mapSource: { tool: string; tool_version: string; vendor: string };
  tags: string[];
};

/**
 * Publish one complete immutable map closure into the local catalog: source
 * map row, upload draft, artifacts, browser asset set and (optionally) the
 * native asset set. Digests come from the members themselves; the map-intel
 * catalog and roadway audit the closure carries are bound to those digests
 * exactly as SimCloud binds them, so a map registered here and the same map
 * on the server describe identical bytes.
 */
export async function publishMapClosure({
  map,
  release,
  browserMembers,
  nativeMembers,
  assetCatalogVersionId,
  mapVersionId,
  provenance,
  mapSource,
  tags,
}: PublishMapClosureInput) {
  const [slug, label, locality] = map;
  const byPath = new Map(browserMembers.map((member) => [member.relativePath, member]));
  const requireMember = (path: string) => {
    const member = byPath.get(path);
    if (!member) throw new Error(`${slug} publication input missing ${path}`);
    return member;
  };

  const xodrMember = requireMember("map.xodr");
  const xodrBytes = await readFile(xodrMember.sourcePath);
  const xodrText = xodrBytes.toString("utf8");
  const manifestBytes = await readFile(requireMember("3d/manifest.json").sourcePath);
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as Manifest;
  const topologyMember = requireMember("topology-index.json.gz");
  const topology = jsonFromGzip<MapTopologyIndex>(await readFile(topologyMember.sourcePath));
  // The roadway audit is published exactly as its producer wrote it, bound to
  // this map and to the XODR and topology bytes in the closure. A failed verdict
  // is published as failed.
  const roadwayMember = requireMember("derived/roadway-consistency.json.gz");
  const roadwayReport = parseRoadwayConsistencyReport(await readFile(roadwayMember.sourcePath), {
    mapId: slug,
    sourceDigests: { xodrSha256: xodrMember.sha256, topologySha256: topologyMember.sha256 },
  });

  // Geography and the preview come from the release's own capability record
  // when it carries one; SimCloud-published closures always carry the preview
  // at `derived/thumbnail.webp`.
  const capabilitiesMember = byPath.get("derived/source-capabilities.json.gz");
  const capabilities = capabilitiesMember
    ? SourceCapabilitiesSchema.parse(jsonFromGzip<unknown>(await readFile(capabilitiesMember.sourcePath)))
    : null;
  const thumbnailPath = capabilities?.thumbnail.path ?? "derived/thumbnail.webp";
  const thumbnail = byPath.get(thumbnailPath);
  if (!thumbnail) throw new Error(`${slug} closure carries no preview at ${thumbnailPath}`);
  const thumbnailRecipe = capabilities?.thumbnail.recipe ?? "registry-source-thumbnail";
  const geography = capabilities?.geography;

  const sourceMapId = slug;
  const draftId = `usmapdraft_${sha256(`registry:${slug}:${release.releaseDigest}`).slice(0, 32)}`;
  await upsertMapAsset({
    map_asset_id: sourceMapId,
    name: label,
    carla_map_name: null,
    ue5_carla_map_name: null,
    description: `${label} installed registry map`,
    crs: "OpenDRIVE",
    bbox: geography?.bounds ?? { min_lat: 0, min_lng: 0, max_lat: 0, max_lng: 0 },
    center: geography?.center ?? { lat: 0, lng: 0 },
    created_at: new Date(0).toISOString(),
    tags,
    map_coordinate_ref: extractCoordinateRefFromXodr(xodrText),
    map_source: mapSource,
    place_context: { city: locality, geocoder: "manual" },
    artifacts: [
      {
        artifact_type: "xodr", uri: `s3://${xodrMember.bucket}/${xodrMember.key}`,
        sha256: xodrMember.sha256, size_bytes: xodrBytes.byteLength,
        created_at: new Date(0).toISOString(),
      },
      {
        artifact_type: "thumbnail", uri: `s3://${thumbnail.bucket}/${thumbnail.key}`,
        sha256: thumbnail.sha256, size_bytes: thumbnail.byteLength,
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
       :id, :workspace_id, :user_id, :label, :locality, NULL,
       :source_map_id, :xodr_sha256, :xodr_byte_length, :thumbnail_sha256,
       :thumbnail_byte_length, CAST(:layers AS jsonb), CAST(:preflight AS jsonb), 'publishing'
     ) ON CONFLICT (id) DO NOTHING`,
    {
      id: draftId,
      workspace_id: LOCAL_WORKSPACE_ID,
      user_id: LOCAL_USER_ID,
      label,
      locality,
      source_map_id: sourceMapId,
      xodr_sha256: xodrMember.sha256,
      xodr_byte_length: xodrBytes.byteLength,
      thumbnail_sha256: thumbnail.sha256,
      thumbnail_byte_length: thumbnail.byteLength,
      layers: [],
      preflight: {
        source: "map-registry",
        fullPublishedClosure: true,
        registryReleaseDigest: release.releaseDigest,
      },
    },
  );

  const plan = planUploadedMapClosure({
    workspaceId: LOCAL_WORKSPACE_ID,
    sourceMapId,
    derivativeReleaseId: release.releaseDigest,
    manifest,
    members: browserMembers,
    ...(mapVersionId ? { mapVersionId } : {}),
  });
  let nativePlan;
  if (nativeMembers) {
    const nativePaths = new Set(nativeMembers.map((member) => member.relativePath));
    const masterMember = nativeMembers.find((member) => member.relativePath === "master.gltf");
    if (!masterMember) throw new Error(`${slug} native closure has no master.gltf`);
    assertNativeMasterClosure(
      JSON.parse(await readFile(masterMember.sourcePath, "utf8")),
      nativePaths,
    );
    nativePlan = planNativeMapAssetSet({
      workspaceId: LOCAL_WORKSPACE_ID,
      mapVersionId: plan.mapVersionId,
      registryReleaseDigest: release.releaseDigest,
      canonicalDigest: release.canonicalDigest,
      members: nativeMembers,
    });
  }

  const locations = LocationsSchema.parse(jsonFromGzip<unknown>(
    await readFile(requireMember("derived/locations.json.gz").sourcePath),
  ));
  assertSourceHashesBound(slug, locations.sourceHashes, (path) => requireMember(path).sha256);
  // Same projection SimCloud records for a registry import: the release is
  // the receipt, and map-intel identity comes from the catalog it shipped.
  const mapIntel: PublishedMapIntel = {
    contractVersion: "simforge.map-release.v1",
    builder: { package: "@simforge-oss/map-registry", version: "1" },
    mapId: slug,
    catalogRevision: locations.catalogRevision,
    sourceHashes: locations.sourceHashes,
    outputs: {},
    receiptSha256: release.releaseDigest,
    locationCount: locations.locations.length,
    laneCount: Object.keys(topology.lanes).length,
    junctionCount: Object.keys(topology.junctions).length,
    roadwayConsistency: {
      format: roadwayReport.format,
      validatorVersion: roadwayReport.validatorVersion,
      verdict: roadwayReport.verdict,
      stats: roadwayReport.stats,
      artifactSha256: roadwayMember.sha256,
      sourceDigests: roadwayReport.sourceDigests,
    },
  };
  const result = await publishUploadedMapVersion({
    draftId,
    plan,
    workspaceId: LOCAL_WORKSPACE_ID,
    sourceMapId,
    sourceMapAssetId: sourceMapId,
    assetCatalogVersionId,
    derivativeReleaseId: release.releaseDigest,
    label,
    locality,
    carlaMapName: null,
    provenance: {
      ...provenance,
      version: release.version,
      releaseDigest: release.releaseDigest,
      canonicalDigest: release.canonicalDigest,
      ...(release.webDigest ? { webDigest: release.webDigest } : {}),
    },
    thumbnail: {
      bucket: thumbnail.bucket,
      key: thumbnail.key,
      sha256: thumbnail.sha256,
      byteLength: thumbnail.byteLength,
      mediaType: "image/webp",
      recipe: thumbnailRecipe,
      sourceBucket: thumbnail.bucket,
      sourceKey: thumbnail.key,
    },
    mapIntel,
    triangleCount: manifest.scene?.totalTriangles ?? 0,
    registryReleaseDigest: release.releaseDigest,
    ...(nativePlan ? { nativePlan } : {}),
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
    thumbnailBytes: thumbnail.byteLength,
  };
}

/**
 * Publish a registry release installed on this machine (a development input:
 * the three verified profile directories of one release). An installed web
 * profile is self-contained, so it alone is the browser closure; every member
 * is digest-checked against its receipt as it is stored.
 */
export async function publishRegistryInstallation({
  map,
  installation,
  assetCatalogVersionId,
}: {
  map: DevAssetMap;
  installation: RegistryMapInstallation;
  assetCatalogVersionId: string;
}) {
  const [slug] = map;
  const browserMembers: StoredMember[] = [];
  for (const [relativePath, expected] of Object.entries(installation.webReceipt.members)
    .sort(([left], [right]) => left.localeCompare(right))) {
    browserMembers.push(await storeSourceMember(installation.webRoot, slug, relativePath, "", expected));
  }
  browserMembers.push(await storeSourceMember(installation.webRoot, slug, ".map-release.json"));
  const nativeMembers: StoredMember[] = [];
  for (const [relativePath, expected] of Object.entries(installation.nativeReceipt.members)
    .sort(([left], [right]) => left.localeCompare(right))) {
    nativeMembers.push(await storeSourceMember(installation.nativeRoot, slug, relativePath, "native/", expected));
  }
  nativeMembers.push(await storeSourceMember(installation.nativeRoot, slug, ".map-release.json", "native/"));
  const receipt = installation.webReceipt;
  return publishMapClosure({
    map,
    release: {
      version: receipt.version,
      releaseDigest: receipt.releaseDigest,
      canonicalDigest: receipt.canonicalDigest,
      ...(receipt.webDigest ? { webDigest: receipt.webDigest } : {}),
    },
    browserMembers,
    nativeMembers,
    assetCatalogVersionId,
    provenance: {
      kind: "map-registry-installation",
      name: slug,
      semanticRoot: installation.semanticRoot,
      browserRoot: installation.webRoot,
      nativeRoot: installation.nativeRoot,
    },
    mapSource: {
      tool: "SimForge map registry",
      tool_version: receipt.version,
      vendor: `release-sha256:${receipt.releaseDigest}`,
    },
    tags: ["local", "registry"],
  });
}
