import { discardResponseBody } from "@/app/lib/cloud/drain";
import { randomBytes } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { revalidateTag } from "next/cache";
import type { ScenarioMapDescriptorDto, StudioMapEntry } from "@simforge-oss/studio-host";
import { LOCAL_SESSION, LOCAL_WORKSPACE_ID } from "@/app/lib/auth/session";
import { getAppContext } from "@/app/lib/db/app-context";
import { LOCAL_CLOUD_ROOT } from "@/app/lib/db/config";
import { queryOne, queryRows } from "@/app/lib/db/data-api";
import {
  publishMapClosure,
  type DevAssetMap,
  type StoredMember,
} from "@/app/lib/map-ingest/server/dev-asset-publication";
import { ensureMapAsset, MapCacheError, materializeMapAssets, resolveCachedMapAsset } from "@/app/lib/map-cache/service";
import { registeredProfileInstalled } from "./map-profile-residency";
import { listScenarioMapDescriptors } from "@/app/lib/scenario/document-store";
import { localObjectPath, readLocalObjectSize } from "@/app/lib/s3/s3-object";
import { assertMapUsable, MapAccessError } from "./access";
import { BUNDLED_MAPS } from "./bundled-maps";
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
  loadRegisteredMapSummaries,
  type RegisteredMapSummary,
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
  locked: boolean;
  /**
   * Whether each profile's ENTRY POINT is on this computer. True from the
   * moment an owner-installed map is registered, which is what several
   * surfaces want (the map is listed, the editor may open it) and is not what
   * "installed" means — see {@link LocalMapDescriptor.installed}.
   */
  ready: { browser: boolean; semantic: boolean };
  /**
   * Whether the COMPLETE verified closure of each profile is on this
   * computer: every member, at its registered digest and byte length, in the
   * map cache. This is the fact an installer offer must be made from — a
   * registered map whose members were never materialized reads `ready` but
   * not `installed`, and an installed map reads `installed` in every process,
   * because nothing about it is remembered in one process's job table.
   */
  installed: { browser: boolean; semantic: boolean };
  /** Download size of each profile's closure, or null while the upstream plan is unknown. */
  closureBytes: { browser: number; semantic: number } | null;
};

export type LocalMapInstallState = {
  mapVersionId: string;
  profile: MapProfile;
  /**
   * `idle` means no job and not installed. `installed` is the closure being
   * complete on this computer with no job in this process — the state a
   * relaunch must still report, and the one a client must not offer a
   * download for.
   */
  state: "idle" | "installed" | "materializing" | "ready" | "error";
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

/**
 * An upstream read shared by every reader of one scope: the in-flight request
 * itself, so concurrent callers never open a second one, kept for
 * {@link CATALOG_TTL_MS} once it answered.
 */
type Cached<T> = { scope: string | null; expiresAt: number; value: Promise<T> };

type InstallJob = {
  state: LocalMapInstallState;
  promise: Promise<{ map: StudioMapEntry; directory: string }> | null;
};

type MapsState = {
  catalog: Cached<UpstreamDescriptor[]> | null;
  plans: Map<MapProfile, Cached<UpstreamPlanMap[]>>;
  installs: Map<string, InstallJob>;
  /** When the current catalog-read wait window opened; see {@link upstreamDeadline}. */
  upstreamWaitOpenedAt: number | null;
};
const STATE_KEY = Symbol.for("simforge.local-maps");
const state: MapsState = ((globalThis as Record<symbol, unknown>)[STATE_KEY] ??= {
  catalog: null,
  plans: new Map(),
  installs: new Map(),
  upstreamWaitOpenedAt: null,
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

/**
 * Bundled public maps are always in the upstream view. Anonymously they are
 * the whole catalog and the Cloud is not consulted at all; with an account
 * the Cloud's list wins for the same identity and the bundle fills any gap,
 * so a Cloud that stops serving Richmond anonymously never empties a first run.
 */
function withBundled<T extends { mapVersionId: string }>(upstream: T[], bundled: T[]): T[] {
  const seen = new Set(upstream.map((map) => map.mapVersionId));
  return [...upstream, ...bundled.filter((map) => !seen.has(map.mapVersionId))];
}

/**
 * Join the upstream read of one scope, or start it. The entry holds the
 * in-flight promise, so a hundred catalog readers during a slow answer cost
 * one request; a read that failed is forgotten, so the next reader retries
 * rather than inheriting the failure for the whole TTL. The read is not bound
 * to the reader that started it: a reader that stops waiting (see
 * {@link withinDeadline}) still leaves the answer warm for the next one.
 */
function sharedUpstreamRead<T>(
  scope: string | null,
  get: () => Cached<T> | null | undefined,
  set: (entry: Cached<T> | null) => void,
  read: () => Promise<T>,
): Promise<T> {
  const cached = get();
  if (cached && cached.scope === scope && cached.expiresAt > Date.now()) return cached.value;
  const entry: Cached<T> = { scope, expiresAt: Number.MAX_SAFE_INTEGER, value: read() };
  set(entry);
  entry.value.then(
    () => {
      entry.expiresAt = Date.now() + CATALOG_TTL_MS;
    },
    () => {
      if (get() === entry) set(null);
    },
  );
  return entry.value;
}

async function fetchUpstreamCatalog(signal?: AbortSignal): Promise<UpstreamDescriptor[]> {
  await primeCloudSession();
  const session = cloudSessionScope();
  const bundled = BUNDLED_MAPS.map((map) => map.descriptor);
  if (!session.active) return bundled;
  return sharedUpstreamRead(
    session.scope,
    () => state.catalog,
    (entry) => {
      state.catalog = entry;
    },
    async () => {
      const response = await upstreamGet("/api/simforge/maps", signal);
      if (!response.ok) {
        await discardResponseBody(response);
        throw new CloudConnectionError("cloud_unreachable", `SimCloud map catalog answered ${response.status}`);
      }
      const payload = await response.json() as { maps?: unknown };
      const maps = Array.isArray(payload.maps) ? payload.maps as UpstreamDescriptor[] : [];
      return withBundled(maps.filter((map) =>
        typeof map?.mapVersionId === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(map.mapVersionId)
        && typeof map.label === "string" && typeof map.sourceMapId === "string"), bundled);
    },
  );
}

async function fetchUpstreamPlan(profile: MapProfile, signal?: AbortSignal): Promise<UpstreamPlanMap[]> {
  await primeCloudSession();
  const session = cloudSessionScope();
  const bundled = BUNDLED_MAPS.map((map) => map.plans[profile]);
  if (!session.active) return bundled;
  return sharedUpstreamRead(
    session.scope,
    () => state.plans.get(profile),
    (entry) => {
      if (entry) state.plans.set(profile, entry);
      else state.plans.delete(profile);
    },
    async () => {
      const response = await upstreamGet(`/api/simforge/maps/cache-plan?profile=${profile}`, signal);
      if (!response.ok) {
        await discardResponseBody(response);
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
      return withBundled(maps, bundled);
    },
  );
}

/** Forget cached upstream reads; the next catalog call reflects the current session. */
export function invalidateUpstreamCatalog(): void {
  state.catalog = null;
  state.plans.clear();
  state.upstreamWaitOpenedAt = null;
}

/**
 * How long a catalog read may wait on SimCloud. Studio is a local-first
 * application: the maps this machine has are local facts, and a Cloud that is
 * merely slow (rather than down) must not hold them back.
 */
const UPSTREAM_CATALOG_BUDGET_MS = 500;

/** Returned instead of an upstream value the reader stopped waiting for. */
const BUDGET_EXPIRED = Symbol("upstream budget expired");

/**
 * The instant a catalog read must stop waiting for SimCloud. The budget
 * belongs to the wait window, not to the request: the reader that opens one
 * may spend it, the readers behind it inherit what is left and answer at
 * local speed, because waiting longer would only mean waiting for a read that
 * is already in flight — and which caches its answer for them anyway. A new
 * window opens once the cached reads would have expired.
 */
function upstreamDeadline(): number {
  const now = Date.now();
  if (state.upstreamWaitOpenedAt === null || now - state.upstreamWaitOpenedAt > CATALOG_TTL_MS) {
    state.upstreamWaitOpenedAt = now;
  }
  return state.upstreamWaitOpenedAt + UPSTREAM_CATALOG_BUDGET_MS;
}

/**
 * Wait for an upstream read until `deadline`, no longer. The read is NOT
 * cancelled when the deadline passes — it keeps running, and
 * {@link sharedUpstreamRead} keeps its answer, so the next reader gets the
 * real catalog while this one already answered with the local maps.
 */
async function withinDeadline<T>(read: Promise<T>, deadline: number): Promise<T | typeof BUDGET_EXPIRED> {
  // Thunks, so the losing outcome of the race is never an unhandled rejection.
  const settled = read.then<() => T, () => T>((value) => () => value, (error: unknown) => () => {
    throw error;
  });
  const { promise: expiry, resolve: expire } = Promise.withResolvers<() => typeof BUDGET_EXPIRED>();
  const timer = setTimeout(() => expire(() => BUDGET_EXPIRED), Math.max(0, deadline - Date.now()));
  try {
    return (await Promise.race([settled, expiry]))();
  } finally {
    clearTimeout(timer);
  }
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
    sumoStatus: map.sumoStatus ?? null,
    ambientTurnVerdicts: map.ambientTurnVerdicts ?? null,
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
 * Closure sizes of the maps registered on this installation, read from the
 * publication rows that recorded them. An installed map's download size is a
 * local fact: asking SimCloud for it would make the whole local catalog wait
 * on the network for a display detail.
 *
 * A map without an available native asset set has no semantic closure to
 * install, which is a size of zero rather than an unknown one.
 */
async function installedClosureBytes(): Promise<Map<string, { browser: number; semantic: number }>> {
  const rows = await queryRows<{ map_version_id: string; browser_bytes: number | string | null; semantic_bytes: number | string | null }>(
    `SELECT mv.id AS map_version_id, bs.byte_length AS browser_bytes, ns.byte_length AS semantic_bytes
     FROM simforge.map_versions mv
     LEFT JOIN simforge.browser_asset_sets bs ON bs.id = mv.browser_asset_set_id
       AND bs.workspace_id = mv.workspace_id AND bs.asset_set_state = 'available'
     LEFT JOIN simforge.native_map_asset_sets ns ON ns.id = mv.native_map_asset_set_id
       AND ns.workspace_id = mv.workspace_id AND ns.asset_set_state = 'available'
     WHERE mv.workspace_id = :workspace_id AND mv.retired_at IS NULL`,
    { workspace_id: LOCAL_WORKSPACE_ID },
  );
  const sizes = new Map<string, { browser: number; semantic: number }>();
  for (const row of rows) {
    if (row.browser_bytes === null) continue;
    sizes.set(row.map_version_id, { browser: Number(row.browser_bytes), semantic: Number(row.semantic_bytes ?? 0) });
  }
  return sizes;
}

/**
 * Total download size per profile of maps that are NOT installed here, from
 * the upstream cache plans this module already fetches and caches for
 * installs, so a selection screen can show sizes before anything is
 * downloaded.
 *
 * A size is an annotation on the catalog, never a reason to fail it: offline,
 * an account map without a session, an upstream that answers too slowly, or a
 * plan the upstream serves malformed all leave the size unknown while the
 * maps themselves still list.
 */
async function upstreamClosureBytes(deadline: number, signal?: AbortSignal): Promise<Map<string, { browser: number; semantic: number }>> {
  const sizes = new Map<string, { browser: number; semantic: number }>();
  for (const profile of ["browser", "semantic"] as const) {
    let plans: UpstreamPlanMap[] | typeof BUDGET_EXPIRED;
    try {
      plans = await withinDeadline(fetchUpstreamPlan(profile, signal), deadline);
    } catch {
      continue;
    }
    if (plans === BUDGET_EXPIRED) continue;
    for (const plan of plans) {
      const entry = sizes.get(plan.mapVersionId) ?? { browser: 0, semantic: 0 };
      entry[profile] = plan.assets.reduce((total, asset) => total + asset.byteLength, 0);
      sizes.set(plan.mapVersionId, entry);
    }
  }
  return sizes;
}

export type LocalMapCatalog = {
  maps: LocalMapDescriptor[];
  /**
   * Whether the configured Cloud answered the catalog request. Anonymously
   * the Cloud is the only source of the public Richmond Field Station map, so
   * a first run with an unreachable Cloud has nothing to offer; the message
   * is what the onboarding screen shows instead of an empty list.
   */
  upstream: { reachable: true } | { reachable: false; message: string };
};

/**
 * Whether each profile's complete verified closure is on this computer, from
 * the map cache's own index of what it holds.
 *
 * This is the same question {@link closureCached} answers for the installer,
 * asked the cheap way: the installer is about to open every member anyway, so
 * it stats them, while a catalog read only has to *say* whether they are here
 * and must do it for every map on every read. A 47,000-member cache answers
 * from the index in milliseconds.
 *
 * It is deliberately not derived from the install job table: a job is one
 * process's memory, so before this the whole installation forgot what it had
 * installed every time the daemon restarted, and offered the user a download
 * for 33 GB of maps already on the disk.
 */
/**
 * Installed = the closure is resident where this host keeps closures. Members in
 * the map cache are files this process can check — the entry point first, the
 * whole closure only when the entry point is there. Members in an object store
 * are resident as soon as the registry holds their asset set `available` (it
 * becomes so only once every blob is verified); a filesystem probe would never
 * find them on a host whose store is S3, which is why hosted catalogs used to
 * report every map as not installed.
 */
async function installedClosures(summary: RegisteredMapSummary | null): Promise<{ browser: boolean; semantic: boolean }> {
  if (!summary) return { browser: false, semantic: false };
  const profile = async (name: "browser" | "semantic", entryPoint: string): Promise<boolean> => {
    const member = summary[name].get(entryPoint);
    if (!member) return false;
    if (member.bucket !== MAP_CACHE_BUCKET) return summary.installed[name] === true;
    if (!(await registeredProfileInstalled([member]))) return false;
    const complete = await getRegisteredMap(summary.mapVersionId);
    return complete !== null && registeredProfileInstalled(complete[name].values());
  };
  const [browser, semantic] = await Promise.all([profile("browser", "3d/manifest.json"), profile("semantic", "master.gltf")]);
  return { browser, semantic };
}

/**
 * Every map this installation can show: registered local maps first, then
 * upstream maps not yet installed. Upstream unreachable is not an error here —
 * the local catalog stands on its own — but it is reported, because a fresh
 * installation has no local catalog to stand on.
 *
 * The local rows are produced from local data only, and the upstream reads
 * that add the not-yet-installed ones run under {@link UPSTREAM_CATALOG_BUDGET_MS}:
 * a SimCloud that is slow (not only one that is down) must not hold up the
 * maps this machine already has. A budget that runs out is the same fact the
 * UI already knows how to show — the Cloud was not reached.
 */
export async function readLocalMapCatalog(signal?: AbortSignal): Promise<LocalMapCatalog> {
  await primeCloudSession();
  const session = cloudSessionScope();
  const local = await listScenarioMapDescriptors(localContext());
  const installedBytes = await installedClosureBytes();
  const registeredById = await loadRegisteredMapSummaries(local.map((descriptor) => descriptor.mapVersionId));
  const maps: LocalMapDescriptor[] = [];
  const seen = new Set<string>();
  for (const descriptor of local) {
    const registered = registeredById.get(descriptor.mapVersionId) ?? null;
    const access = registered?.access ?? "local";
    const entryPoints = [["browser", "3d/manifest.json"], ["semantic", "master.gltf"]] as const;
    const readyValues = await Promise.all(entryPoints.map(async ([profile, entryPoint]) => {
      const member = registered?.[profile].get(entryPoint);
      if (!member) return false;
      if (member.bucket === MAP_CACHE_BUCKET) {
        const cached = await resolveCachedMapAsset(member.sha256);
        return cached !== null && cached.sizeBytes === member.byteLength;
      }
      // Verified registry blobs are the object-store presence contract; avoid
      // an S3 HEAD on every catalog request.
      return true;
    }));
    const ready = { browser: readyValues[0] ?? false, semantic: readyValues[1] ?? false };
    seen.add(descriptor.sourceMapId);
    maps.push({
      ...descriptor,
      access,
      locked: access === "cloud" && !session.active,
      ready,
      installed: await installedClosures(registered),
      closureBytes: installedBytes.get(descriptor.mapVersionId) ?? null,
    });
  }
  const deadline = upstreamDeadline();
  let upstream: UpstreamDescriptor[] = [];
  let reachability: LocalMapCatalog["upstream"] = { reachable: true };
  try {
    const answered = await withinDeadline(fetchUpstreamCatalog(signal), deadline);
    if (answered === BUDGET_EXPIRED) {
      reachability = { reachable: false, message: "SimCloud has not answered yet; showing the maps installed on this computer" };
    } else {
      upstream = answered;
    }
  } catch (error) {
    if (!(error instanceof CloudConnectionError)) throw error;
    reachability = { reachable: false, message: error.message };
  }
  const pending = upstream.filter((map) => !seen.has(map.sourceMapId));
  // Cache plans are fetched for their sizes alone, so they are worth a request
  // only when there is an uninstalled map to put a size on.
  const upstreamBytes = pending.length > 0 ? await upstreamClosureBytes(deadline, signal) : null;
  for (const map of pending) {
    if (seen.has(map.sourceMapId)) continue;
    seen.add(map.sourceMapId);
    maps.push({
      ...localizeDescriptor(map),
      access: accessOf(map),
      locked: false,
      ready: { browser: false, semantic: false },
      // Not registered here, so no closure of it is here either.
      installed: { browser: false, semantic: false },
      closureBytes: upstreamBytes?.get(map.mapVersionId) ?? null,
    });
  }
  return { maps, upstream: reachability };
}

export async function listLocalMapCatalog(signal?: AbortSignal): Promise<LocalMapDescriptor[]> {
  return (await readLocalMapCatalog(signal)).maps;
}

/**
 * The maps the editor can open on this host — protocol `maps.list`. Installed
 * for the browser and not behind a Cloud session the host does not have; the
 * `LocalMapDescriptor` extras stay server-side, the wire carries the
 * `ScenarioMapDescriptorDto` fields.
 */
export async function listEditorMapCatalog(signal?: AbortSignal): Promise<LocalMapDescriptor[]> {
  return (await listLocalMapCatalog(signal)).filter((map) => map.ready.browser && !map.locked);
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
    sumoStatus: map.sumoStatus ?? null,
    ambientTurnVerdicts: map.ambientTurnVerdicts ?? null,
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

/**
 * One member's transfer failure in the install's own vocabulary: bytes that do
 * not match the registered digest or size are an integrity failure, a source
 * the cache could not find at all is a missing member. Anything else (a
 * cancelled install, a full disk) keeps its own message.
 */
function memberTransferError(relativePath: string, error: unknown): unknown {
  if (!(error instanceof MapCacheError)) return error;
  if (error.name === "IntegrityError") {
    return new MapAccessError("MapCacheError", "map_member_integrity", `${relativePath} did not verify: ${error.message}`);
  }
  if (error.name === "NotFoundError") {
    return new MapAccessError("NotFound", "map_member_missing", `${relativePath} is not on this computer: ${error.message}`);
  }
  return error;
}

/** Pull every member of one closure into the cache, counting real completed members and bytes. */
async function transferClosure(
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
      let result;
      try {
        result = await ensureMapAsset({
          requestId: `install:${jobId}:${index}`,
          url: memberUrl(mapVersionId, profile, relativePath),
          sha256: member.sha256,
          sizeBytes: member.byteLength,
        }, signal);
      } catch (error) {
        throw memberTransferError(relativePath, error);
      }
      if (result.sha256 !== member.sha256 || result.sizeBytes !== member.byteLength) {
        throw new MapAccessError("MapCacheError", "map_member_integrity", `${relativePath} did not verify`);
      }
      progress.completedMembers += 1;
      progress.completedBytes += member.byteLength;
    }
  });
  await Promise.all(workers);
}

/**
 * Whether every member's verified object is in the cache. A registration
 * outlives its objects when the user clears the map cache; the closure then
 * needs (an incremental) download again, not trust.
 */
async function closureCached(members: Map<string, RegistryMember>): Promise<boolean> {
  for (const member of members.values()) {
    const cached = await resolveCachedMapAsset(member.sha256);
    if (!cached || cached.sizeBytes !== member.byteLength) return false;
  }
  return true;
}

/**
 * The first member whose bytes are not on this computer, or null when the
 * whole closure can be installed without an upstream. An owner-installed
 * member is a file in the local object store — the very file the catalog
 * stats to report the profile as installed; a member that names the map cache
 * has no other home, so it is present only while the cache holds it.
 */
async function missingLocalMember(members: Map<string, RegistryMember>): Promise<string | null> {
  for (const [relativePath, member] of members) {
    if (member.bucket === MAP_CACHE_BUCKET) {
      if (!(await resolveCachedMapAsset(member.sha256))) return relativePath;
      continue;
    }
    try {
      if (!(await stat(localObjectPath(member.bucket, member.key))).isFile()) return relativePath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return relativePath;
    }
  }
  return null;
}

/**
 * Install owner-installed closures from this machine: the members are already
 * registered under their immutable identity, so nothing is published again and
 * nothing is fetched. Every member still goes through the one map cache, which
 * verifies it against the registered digest and size (and hardlinks rather
 * than copies where the filesystem allows), so the result is exactly the
 * verified closure a download produces.
 */
async function ingestInstalledClosures(
  mapVersionId: string,
  closures: Array<[MapProfile, Map<string, RegistryMember>]>,
  progress: Progress,
  signal?: AbortSignal,
): Promise<void> {
  for (const [profile, members] of closures) {
    if (members.size === 0) {
      throw new MapAccessError("NotFound", "map_profile_not_installed", `${mapVersionId} has no installed ${profile} closure`);
    }
    const missing = await missingLocalMember(members);
    if (missing !== null) {
      throw new MapAccessError(
        "NotFound",
        "map_profile_not_installed",
        `${mapVersionId} was installed without its ${profile} member ${missing}`,
      );
    }
    progress.members += members.size;
    for (const member of members.values()) progress.bytes += member.byteLength;
  }
  for (const [profile, members] of closures) {
    await transferClosure(mapVersionId, profile, members, progress, signal);
  }
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

  const needsBrowser = !registered || registered.browser.size === 0 || !(await closureCached(registered.browser));
  const needsNative = profile === "semantic"
    && (!registered || registered.semantic.size === 0 || !(await closureCached(registered.semantic)));
  if (needsBrowser || needsNative) {
    if (registered?.access === "local") {
      // An owner-installed release has no upstream to fill a profile from —
      // but its members are on this computer: the local object store holds the
      // very files the catalog stats to report the profile as installed. Only
      // the sha-keyed map cache is empty (a fresh cache root, or one the user
      // cleared), so installing means ingesting those bytes, verified, rather
      // than looking for a release that was never published anywhere.
      const closures: Array<[MapProfile, Map<string, RegistryMember>]> = [];
      if (needsBrowser) closures.push(["browser", registered.browser]);
      if (needsNative) closures.push(["semantic", registered.semantic]);
      await ingestInstalledClosures(mapVersionId, closures, progress, signal);
    } else {
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
        await transferClosure(mapVersionId, downloadProfile, members, progress, signal);
      }
      await registerDownloadedMap(descriptor, browserPlan, browserMembers, nativeUpstream?.semantic ?? null);
      registered = await getRegisteredMap(mapVersionId);
    }
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

/** Start (or join) an install without waiting for it; the state is read back through {@link readMapInstallState}. */
export function startMapInstall(mapVersionId: string, profile: MapProfile): LocalMapInstallState {
  ensureLocalMap(mapVersionId, profile).catch(() => undefined);
  return getMapInstallState(mapVersionId, profile);
}

/** The install job of this process, or `idle` when it has none. */
export function getMapInstallState(mapVersionId: string, profile: MapProfile): LocalMapInstallState {
  const job = state.installs.get(`${mapVersionId}\0${profile}`);
  if (job) return { ...job.state, progress: job.state.progress ? { ...job.state.progress } : null };
  return { mapVersionId, profile, state: "idle", progress: null, directory: null, message: null };
}

/**
 * What this installation can say about one map profile: the job, when this
 * process has one, and otherwise whether the closure is on this computer.
 *
 * The job table alone was a lie by omission. A profile installed by an
 * earlier run of the daemon reported `idle` — indistinguishable from never
 * installed — so the UI offered a fresh download of gigabytes already on the
 * disk. `idle` now means what it says: no job, and nothing installed either.
 */
export async function readMapInstallState(mapVersionId: string, profile: MapProfile): Promise<LocalMapInstallState> {
  const job = state.installs.get(`${mapVersionId}\0${profile}`);
  if (job) return { ...job.state, progress: job.state.progress ? { ...job.state.progress } : null };
  const registered = await getRegisteredMap(mapVersionId);
  if (!registered || !(await registeredProfileInstalled(registered[profile].values()))) {
    return { mapVersionId, profile, state: "idle", progress: null, directory: null, message: null };
  }
  return {
    mapVersionId,
    profile,
    state: "installed",
    progress: null,
    // The closure is here; where it was last laid out for a native job is a
    // fact of that job, not of the install, so it is not claimed here.
    directory: null,
    message: null,
  };
}
