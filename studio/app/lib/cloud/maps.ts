import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { revalidateTag } from "next/cache";
import type { ScenarioMapDescriptorDto, StudioMapEntry } from "@simforge-oss/studio-host";
import { LOCAL_SESSION, LOCAL_WORKSPACE_ID } from "@/app/lib/auth/session";
import { getAppContext } from "@/app/lib/db/app-context";
import { LOCAL_CLOUD_ROOT } from "@/app/lib/db/config";
import { queryOne } from "@/app/lib/db/data-api";
import {
  publishMapClosure,
  type DevAssetMap,
  type StoredMember,
} from "@/app/lib/map-ingest/server/dev-asset-publication";
import { ensureMapAsset, materializeMapAssets, resolveCachedMapAsset } from "@/app/lib/map-cache/service";
import { listScenarioMapDescriptors } from "@/app/lib/scenario/document-store";
import { assertMapUsable, MapAccessError } from "./access";
import {
  CloudConnectionError,
  cloudPublicRequest,
  cloudRequest,
  cloudSessionScope,
  primeCloudSession,
} from "./connection";
import {
  CLOUD_DOWNLOAD_PROVENANCE,
  getRegisteredMap,
  invalidateRegisteredMap,
  MAP_CACHE_BUCKET,
  MAP_CACHE_KEY_PREFIX,
  rememberUpstreamMap,
  type MapAccess,
  type MapProfile,
  type RegisteredMap,
  type RegistryMember,
} from "./map-registry";

/**
 * The local map catalog and map installation.
 *
 * The catalog is the union of maps registered in the local database and the
 * maps the configured Cloud publishes to this installation: anonymously that
 * is exactly the real Richmond Field Station; with an active account session
 * it is every published map the account may read. Installing a map downloads
 * its complete verified closure through the one local map cache, registers
 * the map's immutable identity (same map version id and digests as upstream)
 * in the local database, and materializes a directory the compiler and the
 * native renderer read directly.
 */

const SHA256 = /^[a-f0-9]{64}$/;
const CATALOG_TTL_MS = 5 * 60_000;
const DOWNLOAD_CONCURRENCY = 4;
const MAPS_ROOT = resolve(LOCAL_CLOUD_ROOT, "maps");

export type LocalMapDescriptor = ScenarioMapDescriptorDto & {
  access: MapAccess;
  /** A registered account map while this installation has no active session. */
  locked: boolean;
  installed: { browser: boolean; semantic: boolean };
};

export type LocalMapInstallState = {
  mapVersionId: string;
  profile: MapProfile;
  state: "idle" | "materializing" | "ready" | "error";
  progress: { members: number; completedMembers: number; bytes: number; completedBytes: number } | null;
  directory: string | null;
  message: string | null;
};

type UpstreamDescriptor = ScenarioMapDescriptorDto & {
  visibility?: "public" | "private";
  logicalMapId?: string | null;
};

type UpstreamPlanAsset = {
  relativePath: string;
  sha256: string;
  byteLength: number;
  mediaType: string;
  required: boolean;
};

type UpstreamPlanMap = {
  mapVersionId: string;
  closureSha256: string;
  assets: UpstreamPlanAsset[];
  registryReleaseDigest?: string | null;
  canonicalDigest?: string | null;
  registryVersion?: number | null;
  logicalMapId?: string | null;
  visibility?: "public" | "private";
};

type Cached<T> = { scope: string | null; expiresAt: number; value: T };

type InstallJob = {
  state: LocalMapInstallState;
  promise: Promise<{ map: StudioMapEntry; directory: string }> | null;
};

type MapsState = {
  catalog: Cached<UpstreamDescriptor[]> | null;
  plans: Map<MapProfile, Cached<UpstreamPlanMap[]>>;
  installs: Map<string, InstallJob>;
};
const STATE_KEY = Symbol.for("simforge.local-maps");
const state: MapsState = ((globalThis as Record<symbol, unknown>)[STATE_KEY] ??= {
  catalog: null,
  plans: new Map(),
  installs: new Map(),
} satisfies MapsState) as MapsState;

function localContext() {
  return getAppContext(LOCAL_SESSION);
}

function installDirectory(mapVersionId: string, profile: MapProfile) {
  return join(MAPS_ROOT, mapVersionId, profile);
}

/** Upstream reads use the account when it is active and the public catalog otherwise. */
export async function upstreamGet(path: string, signal?: AbortSignal): Promise<Response> {
  const session = cloudSessionScope();
  return session.active
    ? cloudRequest(path, { method: "GET" }, { signal })
    : cloudPublicRequest(path, { method: "GET" }, signal);
}

async function fetchUpstreamCatalog(signal?: AbortSignal): Promise<UpstreamDescriptor[]> {
  await primeCloudSession();
  const scope = cloudSessionScope().scope;
  const cached = state.catalog;
  if (cached && cached.scope === scope && cached.expiresAt > Date.now()) return cached.value;
  const response = await upstreamGet("/api/simforge/maps", signal);
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new CloudConnectionError("cloud_unreachable", `SimCloud map catalog answered ${response.status}`);
  }
  const payload = await response.json() as { maps?: unknown };
  const maps = Array.isArray(payload.maps) ? payload.maps as UpstreamDescriptor[] : [];
  const value = maps.filter((map) =>
    typeof map?.mapVersionId === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(map.mapVersionId)
    && typeof map.label === "string" && typeof map.sourceMapId === "string");
  state.catalog = { scope, expiresAt: Date.now() + CATALOG_TTL_MS, value };
  return value;
}

async function fetchUpstreamPlan(profile: MapProfile, signal?: AbortSignal): Promise<UpstreamPlanMap[]> {
  await primeCloudSession();
  const scope = cloudSessionScope().scope;
  const cached = state.plans.get(profile);
  if (cached && cached.scope === scope && cached.expiresAt > Date.now()) return cached.value;
  const response = await upstreamGet(`/api/simforge/maps/cache-plan?profile=${profile}`, signal);
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new CloudConnectionError("cloud_unreachable", `SimCloud cache plan answered ${response.status}`);
  }
  const payload = await response.json() as { maps?: unknown };
  const maps = Array.isArray(payload.maps) ? payload.maps as UpstreamPlanMap[] : [];
  for (const map of maps) {
    if (typeof map.mapVersionId !== "string" || !Array.isArray(map.assets)) {
      throw new MapAccessError("MapCacheError", "map_plan_invalid", "malformed SimCloud cache plan");
    }
    for (const asset of map.assets) {
      if (
        typeof asset.relativePath !== "string" || !SHA256.test(asset.sha256)
        || !Number.isSafeInteger(asset.byteLength) || asset.byteLength < 0 || typeof asset.mediaType !== "string"
      ) {
        throw new MapAccessError("MapCacheError", "map_plan_invalid", `malformed plan member for ${map.mapVersionId}`);
      }
    }
  }
  state.plans.set(profile, { scope, expiresAt: Date.now() + CATALOG_TTL_MS, value: maps });
  return maps;
}

/** Forget cached upstream reads; the next catalog call reflects the current session. */
export function invalidateUpstreamCatalog(): void {
  state.catalog = null;
  state.plans.clear();
}

function accessOf(map: UpstreamDescriptor): MapAccess {
  return map.visibility === "public" ? "public" : "cloud";
}

/** Rewrite upstream first-party routes onto this service; the descriptor's identities stay verbatim. */
function localizeDescriptor(map: UpstreamDescriptor): ScenarioMapDescriptorDto {
  const root = `/api/simforge/maps/${encodeURIComponent(map.mapVersionId)}/browser-assets`;
  return {
    mapVersionId: map.mapVersionId,
    sourceMapId: map.sourceMapId,
    label: map.label,
    locality: map.locality ?? null,
    browserAssetRootUrl: root,
    browserManifestUrl: `${root}/3d/manifest.json`,
    browserClosureSha256: map.browserClosureSha256,
    artifacts: map.artifacts,
    sumoNetworkSha256: map.sumoNetworkSha256 ?? null,
    topologyArtifactUrl: `${root}/topology-index.json.gz`,
    derivedTopologyUrl: `${root}/derived/topology-derived.json.gz`,
    locationsUrl: `${root}/derived/locations.json.gz`,
    sumoNetworkUrl: null,
    thumbnailUrl: map.thumbnailUrl ? `/api/simforge/maps/${encodeURIComponent(map.mapVersionId)}/thumbnail` : null,
    signalsArtifactUrl: `${root}/signals.geojson.gz`,
    xodr: map.xodr,
    coordinateSystem: map.coordinateSystem,
  };
}

/**
 * Every map this installation can show: registered local maps first, then
 * upstream maps not yet installed. Upstream unreachable is not an error here —
 * the local catalog stands on its own; the connection status says why.
 */
export async function listLocalMapCatalog(signal?: AbortSignal): Promise<LocalMapDescriptor[]> {
  await primeCloudSession();
  const session = cloudSessionScope();
  const local = await listScenarioMapDescriptors(localContext());
  const result: LocalMapDescriptor[] = [];
  const seen = new Set<string>();
  for (const descriptor of local) {
    const registered = await getRegisteredMap(descriptor.mapVersionId);
    const access = registered?.access ?? "local";
    seen.add(descriptor.mapVersionId);
    result.push({
      ...descriptor,
      access,
      locked: access === "cloud" && !session.active,
      installed: { browser: true, semantic: (registered?.semantic.size ?? 0) > 0 },
    });
  }
  let upstream: UpstreamDescriptor[] = [];
  try {
    upstream = await fetchUpstreamCatalog(signal);
  } catch (error) {
    if (!(error instanceof CloudConnectionError)) throw error;
  }
  for (const map of upstream) {
    if (seen.has(map.mapVersionId)) continue;
    seen.add(map.mapVersionId);
    result.push({
      ...localizeDescriptor(map),
      access: accessOf(map),
      locked: false,
      installed: { browser: false, semantic: false },
    });
  }
  return result;
}

function studioMapEntry(map: ScenarioMapDescriptorDto): StudioMapEntry {
  return {
    id: map.mapVersionId,
    versionId: map.mapVersionId,
    mapVersionId: map.mapVersionId,
    sourceMapId: map.sourceMapId,
    label: map.label,
    locality: map.locality ?? "",
    browserAssetRootUrl: map.browserAssetRootUrl,
    browserManifestUrl: map.browserManifestUrl,
    browserClosureSha256: map.browserClosureSha256,
    artifacts: map.artifacts,
    sumoNetworkSha256: map.sumoNetworkSha256,
    manifestUrl: map.browserManifestUrl,
    topologyUrl: map.topologyArtifactUrl,
    derivedTopologyUrl: map.derivedTopologyUrl,
    locationsUrl: map.locationsUrl,
    signalsUrl: map.signalsArtifactUrl,
    sumoNetworkUrl: map.sumoNetworkUrl,
    thumbnailUrl: map.thumbnailUrl,
    xodrArtifactId: map.xodr.artifactId,
    coordinateSystemId: map.coordinateSystem.id,
  };
}

/** The catalog as the shared editor consumes it. */
export async function listAvailableMaps(): Promise<StudioMapEntry[]> {
  return (await listLocalMapCatalog()).map(studioMapEntry);
}

async function upstreamDescriptor(mapVersionId: string, signal?: AbortSignal): Promise<UpstreamDescriptor> {
  let catalog: UpstreamDescriptor[];
  try {
    catalog = await fetchUpstreamCatalog(signal);
  } catch (error) {
    if (error instanceof CloudConnectionError) {
      throw new MapAccessError("MapCacheError", error.code, error.message);
    }
    throw error;
  }
  const descriptor = catalog.find((map) => map.mapVersionId === mapVersionId);
  if (!descriptor) {
    throw new MapAccessError(
      cloudSessionScope().active ? "NotFound" : "NotAuthorized",
      cloudSessionScope().active ? "map_version_not_found" : "map_requires_cloud_connection",
      cloudSessionScope().active
        ? `SimCloud publishes no map ${mapVersionId} to this account`
        : "map_requires_cloud_connection",
    );
  }
  return descriptor;
}

/**
 * Whether this installation may use the map right now: registered public and
 * owner-installed maps always; registered account maps and not-yet-installed
 * upstream maps only with an active session (anonymously, only public RFS).
 */
export async function assertLocalMapAccess(mapVersionId: string): Promise<void> {
  await primeCloudSession();
  const registered = await getRegisteredMap(mapVersionId);
  if (registered) {
    assertMapUsable(registered);
    return;
  }
  const descriptor = await upstreamDescriptor(mapVersionId);
  if (accessOf(descriptor) === "cloud" && !cloudSessionScope().active) {
    throw new MapAccessError("NotAuthorized", "map_requires_cloud_connection", "map_requires_cloud_connection");
  }
}

function planToRegistered(descriptor: UpstreamDescriptor, plan: UpstreamPlanMap, profile: MapProfile): RegisteredMap {
  const members = new Map<string, RegistryMember>();
  for (const asset of plan.assets) {
    members.set(asset.relativePath, {
      sha256: asset.sha256,
      byteLength: asset.byteLength,
      mediaType: asset.mediaType,
      bucket: MAP_CACHE_BUCKET,
      key: `${MAP_CACHE_KEY_PREFIX}${asset.sha256}`,
    });
  }
  return {
    mapVersionId: descriptor.mapVersionId,
    access: accessOf(descriptor),
    origin: cloudSessionScope().origin,
    registryReleaseDigest: plan.registryReleaseDigest ?? null,
    canonicalDigest: plan.canonicalDigest ?? null,
    browser: profile === "browser" ? members : new Map(),
    semantic: profile === "semantic" ? members : new Map(),
  };
}

function memberUrl(mapVersionId: string, profile: MapProfile, relativePath: string) {
  return `/api/simforge/maps/${encodeURIComponent(mapVersionId)}/${profile}-assets/${
    relativePath.split("/").map(encodeURIComponent).join("/")}`;
}

type Progress = LocalMapInstallState["progress"] & object;

/** Pull every member of one closure into the cache, counting real completed members and bytes. */
async function downloadClosure(
  mapVersionId: string,
  profile: MapProfile,
  members: Map<string, RegistryMember>,
  progress: Progress,
  signal?: AbortSignal,
): Promise<void> {
  const jobId = randomBytes(8).toString("base64url");
  const entries = [...members.entries()];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, entries.length) }, async () => {
    while (cursor < entries.length) {
      if (signal?.aborted) throw new MapAccessError("MapCacheError", "AbortError", "map install cancelled");
      const index = cursor++;
      const [relativePath, member] = entries[index]!;
      const result = await ensureMapAsset({
        requestId: `install:${jobId}:${index}`,
        url: memberUrl(mapVersionId, profile, relativePath),
        sha256: member.sha256,
        sizeBytes: member.byteLength,
      }, signal);
      if (result.sha256 !== member.sha256 || result.sizeBytes !== member.byteLength) {
        throw new MapAccessError("MapCacheError", "map_member_integrity", `${relativePath} did not verify`);
      }
      progress.completedMembers += 1;
      progress.completedBytes += member.byteLength;
    }
  });
  await Promise.all(workers);
}

async function storedMembers(members: Map<string, RegistryMember>): Promise<StoredMember[]> {
  const stored: StoredMember[] = [];
  for (const [relativePath, member] of members) {
    const cached = await resolveCachedMapAsset(member.sha256);
    if (!cached || cached.sizeBytes !== member.byteLength) {
      throw new MapAccessError("MapCacheError", "map_member_missing", `${relativePath} is not in the map cache`);
    }
    stored.push({
      relativePath,
      sha256: member.sha256,
      byteLength: member.byteLength,
      mediaType: member.mediaType,
      bucket: MAP_CACHE_BUCKET,
      key: `${MAP_CACHE_KEY_PREFIX}${member.sha256}`,
      sourcePath: cached.path,
    });
  }
  return stored;
}

async function activeAssetCatalogVersionId(): Promise<string> {
  const row = await queryOne<{ asset_catalog_version_id: string }>(
    `SELECT asset_catalog_version_id FROM simforge.editor_asset_releases
     WHERE workspace_id = :workspace_id AND release_state = 'active'
     ORDER BY activated_at DESC NULLS LAST, id ASC LIMIT 1`,
    { workspace_id: LOCAL_WORKSPACE_ID },
  );
  if (!row) throw new MapAccessError("MapCacheError", "editor_asset_release_missing", "the local editor asset release is not seeded");
  return row.asset_catalog_version_id;
}

/**
 * Register a downloaded closure under its upstream identity. Browser and
 * native members are published together; a second call with the native set
 * re-publishes identical browser rows (every insert is idempotent) and binds
 * the native set.
 */
async function registerDownloadedMap(
  descriptor: UpstreamDescriptor,
  browserPlan: UpstreamPlanMap,
  browserMembers: Map<string, RegistryMember>,
  nativeMembers: Map<string, RegistryMember> | null,
): Promise<void> {
  const releaseDigest = browserPlan.registryReleaseDigest ?? null;
  const canonicalDigest = browserPlan.canonicalDigest ?? null;
  if (!releaseDigest || !SHA256.test(releaseDigest)) {
    throw new MapAccessError("MapCacheError", "map_release_identity_missing", `SimCloud publishes no release digest for ${descriptor.mapVersionId}`);
  }
  if (nativeMembers && (!canonicalDigest || !SHA256.test(canonicalDigest))) {
    throw new MapAccessError("MapCacheError", "map_release_identity_missing", `SimCloud publishes no canonical digest for ${descriptor.mapVersionId}`);
  }
  const slug = descriptor.logicalMapId ?? descriptor.sourceMapId;
  const map: DevAssetMap = [slug, descriptor.label, descriptor.locality ?? ""];
  const origin = cloudSessionScope().origin;
  await publishMapClosure({
    map,
    release: {
      version: browserPlan.registryVersion ? `v${browserPlan.registryVersion}` : "upstream",
      releaseDigest,
      // The browser-only registration still names the canonical digest when the plan carries it.
      canonicalDigest: canonicalDigest ?? releaseDigest,
    },
    browserMembers: await storedMembers(browserMembers),
    ...(nativeMembers ? { nativeMembers: await storedMembers(nativeMembers) } : {}),
    assetCatalogVersionId: await activeAssetCatalogVersionId(),
    mapVersionId: descriptor.mapVersionId,
    provenance: {
      kind: CLOUD_DOWNLOAD_PROVENANCE,
      origin,
      visibility: descriptor.visibility === "public" ? "public" : "private",
      upstreamMapVersionId: descriptor.mapVersionId,
      browserClosureSha256: browserPlan.closureSha256,
    },
    mapSource: { tool: "SimCloud", tool_version: browserPlan.registryVersion ? `v${browserPlan.registryVersion}` : "published", vendor: origin },
    tags: ["simcloud", descriptor.visibility === "public" ? "public" : "account"],
  });
  invalidateRegisteredMap(descriptor.mapVersionId);
  // The descriptor read is a long-lived "use cache" entry; a new registration must show up now.
  try {
    revalidateTag("scenario:maps:global", "max");
    revalidateTag(`scenario:map-version:${descriptor.mapVersionId}`, "max");
  } catch {
    // Outside a request scope the cache key change (catalog revision) makes the new map visible.
  }
}

async function materializeProfile(
  mapVersionId: string,
  profile: MapProfile,
  members: Map<string, RegistryMember>,
  signal?: AbortSignal,
): Promise<string> {
  const directory = installDirectory(mapVersionId, profile);
  await mkdir(directory, { recursive: true });
  await materializeMapAssets({
    directory,
    members: [...members.entries()].map(([relativePath, member]) => ({
      path: relativePath,
      url: memberUrl(mapVersionId, profile, relativePath),
      sha256: member.sha256,
      sizeBytes: member.byteLength,
    })),
  }, signal);
  return directory;
}

function findPlan(plans: UpstreamPlanMap[], mapVersionId: string, profile: MapProfile): UpstreamPlanMap {
  const plan = plans.find((candidate) => candidate.mapVersionId === mapVersionId);
  if (!plan || plan.assets.length === 0) {
    throw new MapAccessError("NotFound", "map_plan_not_found", `SimCloud publishes no ${profile} closure for ${mapVersionId}`);
  }
  return plan;
}

async function ensureLocalMapUncounted(
  mapVersionId: string,
  profile: MapProfile,
  progress: Progress,
  signal?: AbortSignal,
): Promise<{ map: StudioMapEntry; directory: string }> {
  await primeCloudSession();
  let registered = await getRegisteredMap(mapVersionId);
  if (registered) assertMapUsable(registered);

  const needsBrowser = !registered || registered.browser.size === 0;
  const needsNative = profile === "semantic" && (!registered || registered.semantic.size === 0);
  if (needsBrowser || needsNative) {
    if (registered?.access === "local") {
      // An owner-installed release is complete by construction; there is no upstream to fill a missing profile from.
      throw new MapAccessError("NotFound", "map_profile_not_installed", `${mapVersionId} has no installed ${profile} closure`);
    }
    const descriptor = await upstreamDescriptor(mapVersionId, signal);
    if (accessOf(descriptor) === "cloud" && !cloudSessionScope().active) {
      throw new MapAccessError("NotAuthorized", "map_requires_cloud_connection", "map_requires_cloud_connection");
    }
    const browserPlan = findPlan(await fetchUpstreamPlan("browser", signal), mapVersionId, "browser");
    const browserUpstream = planToRegistered(descriptor, browserPlan, "browser");
    rememberUpstreamMap(browserUpstream);
    let nativeUpstream: RegisteredMap | null = null;
    if (needsNative) {
      const nativePlan = findPlan(await fetchUpstreamPlan("semantic", signal), mapVersionId, "semantic");
      nativeUpstream = planToRegistered(descriptor, nativePlan, "semantic");
      rememberUpstreamMap(nativeUpstream);
    }
    const browserMembers = registered?.browser.size ? registered.browser : browserUpstream.browser;
    const toDownload: Array<[MapProfile, Map<string, RegistryMember>]> = [];
    if (needsBrowser) toDownload.push(["browser", browserMembers]);
    if (nativeUpstream) toDownload.push(["semantic", nativeUpstream.semantic]);
    for (const [, members] of toDownload) {
      progress.members += members.size;
      for (const member of members.values()) progress.bytes += member.byteLength;
    }
    for (const [downloadProfile, members] of toDownload) {
      await downloadClosure(mapVersionId, downloadProfile, members, progress, signal);
    }
    await registerDownloadedMap(descriptor, browserPlan, browserMembers, nativeUpstream?.semantic ?? null);
    registered = await getRegisteredMap(mapVersionId);
  }
  if (!registered || registered.browser.size === 0 || (profile === "semantic" && registered.semantic.size === 0)) {
    throw new MapAccessError("MapCacheError", "map_registration_incomplete", `${mapVersionId} did not register completely`);
  }

  const members = profile === "browser" ? registered.browser : registered.semantic;
  const directory = await materializeProfile(mapVersionId, profile, members, signal);
  progress.completedMembers = progress.members;
  progress.completedBytes = progress.bytes;
  const descriptor = (await listScenarioMapDescriptors(localContext()))
    .find((candidate) => candidate.mapVersionId === mapVersionId);
  if (!descriptor) throw new MapAccessError("MapCacheError", "map_registration_incomplete", `${mapVersionId} is not in the local catalog`);
  return { map: studioMapEntry(descriptor), directory };
}

/**
 * Make one map profile fully usable on this machine: complete verified
 * closure in the cache, immutable identity registered locally, and a
 * directory of the closure members at their relative paths. Idempotent;
 * concurrent calls for the same profile share one install.
 */
export async function ensureLocalMap(
  mapVersionId: string,
  profile: MapProfile,
  signal?: AbortSignal,
): Promise<{ map: StudioMapEntry; directory: string }> {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(mapVersionId)) {
    throw new MapAccessError("NotFound", "map_version_not_found", `malformed map version id`);
  }
  if (profile !== "browser" && profile !== "semantic") {
    throw new MapAccessError("MapCacheError", "invalid_map_profile", `unknown map profile ${String(profile)}`);
  }
  const key = `${mapVersionId}\0${profile}`;
  let running = state.installs.get(key)?.promise ?? null;
  if (!running) {
    const install: LocalMapInstallState = {
      mapVersionId,
      profile,
      state: "materializing",
      progress: { members: 0, completedMembers: 0, bytes: 0, completedBytes: 0 },
      directory: null,
      message: null,
    };
    const job: InstallJob = { state: install, promise: null };
    // The install outlives any one caller; a caller's abort does not stop it.
    running = ensureLocalMapUncounted(mapVersionId, profile, install.progress!).then(
      (result) => {
        install.state = "ready";
        install.directory = result.directory;
        job.promise = null;
        return result;
      },
      (error: unknown) => {
        install.state = "error";
        install.message = error instanceof MapAccessError || error instanceof CloudConnectionError
          ? error.code
          : error instanceof Error ? error.message : String(error);
        job.promise = null;
        throw error;
      },
    );
    job.promise = running;
    state.installs.set(key, job);
  }
  if (!signal) return running;
  const { promise, resolve: settle, reject } = Promise.withResolvers<{ map: StudioMapEntry; directory: string }>();
  const onAbort = () => reject(new MapAccessError("MapCacheError", "AbortError", "map install wait cancelled"));
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  running.then(settle, reject).finally(() => signal.removeEventListener("abort", onAbort));
  return promise;
}

/** Start (or join) an install without waiting for it; the state is read back through {@link getMapInstallState}. */
export function startMapInstall(mapVersionId: string, profile: MapProfile): LocalMapInstallState {
  ensureLocalMap(mapVersionId, profile).catch(() => undefined);
  return getMapInstallState(mapVersionId, profile);
}

export function getMapInstallState(mapVersionId: string, profile: MapProfile): LocalMapInstallState {
  const job = state.installs.get(`${mapVersionId}\0${profile}`);
  if (job) return { ...job.state, progress: job.state.progress ? { ...job.state.progress } : null };
  return { mapVersionId, profile, state: "idle", progress: null, directory: null, message: null };
}
