import { SUMO_RUNTIME_VERSION } from "@simforge-oss/studio-ui/lib/scenario/sumo-runtime";
import { localObjectPath, readLocalObjectMetadata } from "@/app/lib/s3/s3-object";
import { LOCAL_ARTIFACT_BUCKET } from "@/app/lib/db/config";
import { cloudPublicRequest, cloudRequest, cloudSessionScope, primeCloudSession } from "./connection";
import { discardResponseBody } from "@/app/lib/cloud/drain";
import {
  MAP_CACHE_BUCKET,
  resolveKnownMap,
  type MapProfile,
  type RegisteredMap,
  type RegistryMember,
} from "./map-registry";

/**
 * Authorization and source resolution for the local service's map cache.
 *
 * The cache asks {@link authorizeLocalMapAssetUrl} before every hit and
 * {@link resolveMapAssetSource} once per miss. Authorization is a registry
 * lookup plus the in-memory session view — no network, no per-member database
 * read — and answers with a scope naming who may use the bytes: `public` for
 * the real RFS and owner-installed maps, an origin/account/sign-in scope for
 * maps published to accounts. Owning a digest never grants access; signing
 * out ends the scope. This is retained-authorization policy for an
 * open-source local cache, not DRM over files already on the user's disk.
 */

const MAP_ASSET_PATH = /^\/api\/simforge\/maps\/([^/]+)\/(browser|semantic)-assets\/(.+)$/;
const SUMO_RUNTIME_PATH = /^\/api\/simforge\/sumo-runtime\/(.+)$/;
const DOWNLOAD_URL_BATCH = 128;
/** Presigned delivery URLs are valid for an hour upstream; reuse them well inside that. */
const SIGNED_URL_TTL_MS = 45 * 60_000;
const SUMO_RUNTIME_FILES: Readonly<Record<string, string>> = {
  "sumo.mjs": "text/javascript",
  "sumo.wasm": "application/wasm",
  "runtime-manifest.json": "application/json",
  "THIRD_PARTY_NOTICES.md": "text/markdown",
};

export class MapAccessError extends Error {
  constructor(name: "NotAuthorized" | "NotFound" | "MapCacheError", readonly code: string, message = code) {
    super(message);
    this.name = name;
  }
}

export type LocalMapAssetRef =
  | { kind: "map"; mapVersionId: string; profile: MapProfile; relativePath: string }
  | { kind: "sumo-runtime"; fileName: string };

function isLoopbackHost(hostname: string) {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
}

function safeRelativePath(raw: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new MapAccessError("MapCacheError", "invalid_map_asset_url", "malformed asset path");
  }
  if (
    decoded.length === 0 || decoded.includes("\\") || /[\u0000-\u001f\u007f]/u.test(decoded)
    || decoded.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new MapAccessError("MapCacheError", "invalid_map_asset_url", "unsafe asset path");
  }
  return decoded;
}

/**
 * Parse a local immutable map or runtime asset URL: a root-relative path or an
 * absolute loopback URL. Anything else is not something this cache serves.
 */
export function parseLocalMapAssetUrl(url: string): LocalMapAssetRef {
  let pathname: string;
  if (url.startsWith("/") && !url.startsWith("//")) {
    pathname = new URL(url, "http://127.0.0.1").pathname;
  } else {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new MapAccessError("MapCacheError", "invalid_map_asset_url", `not a map asset URL: ${url}`);
    }
    if (parsed.protocol !== "http:" || !isLoopbackHost(parsed.hostname) || parsed.username || parsed.password) {
      throw new MapAccessError("MapCacheError", "invalid_map_asset_url", `not a local map asset URL: ${url}`);
    }
    pathname = parsed.pathname;
  }
  const map = MAP_ASSET_PATH.exec(pathname);
  if (map) {
    let mapVersionId: string;
    try {
      mapVersionId = decodeURIComponent(map[1]!);
    } catch {
      throw new MapAccessError("MapCacheError", "invalid_map_asset_url", "malformed map version id");
    }
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(mapVersionId)) {
      throw new MapAccessError("MapCacheError", "invalid_map_asset_url", "malformed map version id");
    }
    return { kind: "map", mapVersionId, profile: map[2] as MapProfile, relativePath: safeRelativePath(map[3]!) };
  }
  const sumo = SUMO_RUNTIME_PATH.exec(pathname);
  if (sumo) {
    const relativePath = safeRelativePath(sumo[1]!);
    const prefix = `${SUMO_RUNTIME_VERSION}/`;
    const fileName = relativePath.startsWith(prefix) ? relativePath.slice(prefix.length) : "";
    if (!SUMO_RUNTIME_FILES[fileName]) {
      throw new MapAccessError("NotFound", "sumo_runtime_asset_not_found");
    }
    return { kind: "sumo-runtime", fileName };
  }
  throw new MapAccessError("MapCacheError", "invalid_map_asset_url", `not an immutable local map URL: ${pathname}`);
}

export type ResolvedMapMember = {
  map: RegisteredMap;
  member: RegistryMember;
  ref: Extract<LocalMapAssetRef, { kind: "map" }>;
};
/** Registry lookup plus the access gate; shared by authorization and the asset routes. */
export async function resolveAuthorizedMapMember(ref: Extract<LocalMapAssetRef, { kind: "map" }>): Promise<ResolvedMapMember> {
  const map = await resolveKnownMap(ref.mapVersionId, ref.profile);
  if (!map) throw new MapAccessError("NotFound", "map_version_not_found", `unknown map ${ref.mapVersionId}`);
  assertMapUsable(map);
  const member = map[ref.profile].get(ref.relativePath);
  if (!member) {
    throw new MapAccessError("NotFound", "map_asset_not_found", `${ref.mapVersionId} has no ${ref.profile} member ${ref.relativePath}`);
  }
  return { map, member, ref };
}

/** Maps published to accounts need this installation's Cloud session to be active right now. */
export function assertMapUsable(map: RegisteredMap): void {
  if (map.access !== "cloud") return;
  const session = cloudSessionScope();
  if (!session.active || (map.origin && map.origin !== session.origin)) {
    throw new MapAccessError(
      "NotAuthorized",
      "map_requires_cloud_connection",
      "map_requires_cloud_connection",
    );
  }
}

/** The stable authority/account/sign-in scope a map's bytes may be served under. */
export function mapAccessScope(map: RegisteredMap): string {
  if (map.access !== "cloud") return "public";
  const session = cloudSessionScope();
  if (!session.active || !session.scope) {
    throw new MapAccessError("NotAuthorized", "map_requires_cloud_connection", "map_requires_cloud_connection");
  }
  return session.scope;
}

/**
 * Authorize one local immutable asset URL and return its verified identity.
 * Throws `NotAuthorized` for an account map without an active session,
 * `NotFound` for unknown maps/members and `MapCacheError` for URLs that are
 * not immutable local map assets at all.
 */
export async function authorizeLocalMapAssetUrl(
  url: string,
): Promise<{ scope: string; sha256?: string; sizeBytes?: number }> {
  const ref = parseLocalMapAssetUrl(url);
  if (ref.kind === "sumo-runtime") {
    const key = `uniscenario/sumo-runtime/${SUMO_RUNTIME_VERSION}/${ref.fileName}`;
    try {
      const metadata = await readLocalObjectMetadata(LOCAL_ARTIFACT_BUCKET, key);
      return { scope: "public", sha256: metadata.checksumSha256Hex, sizeBytes: metadata.sizeBytes };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new MapAccessError("NotFound", "sumo_runtime_asset_not_found");
      }
      throw error;
    }
  }
  await primeCloudSession();
  const { map, member } = await resolveAuthorizedMapMember(ref);
  return { scope: mapAccessScope(map), sha256: member.sha256, sizeBytes: member.byteLength };
}

// ── Upstream delivery URLs ───────────────────────────────────────────────────

type SignedUrl = { url: string; expiresAt: number };
type UrlPool = {
  signed: Map<string, SignedUrl>;
  wanted: Set<string>;
  inflight: Promise<void> | null;
};
const POOL_KEY = Symbol.for("simforge.map-download-url-pool");
const pools: Map<string, UrlPool> = ((globalThis as Record<symbol, unknown>)[POOL_KEY] ??= new Map()) as Map<string, UrlPool>;

async function requestDownloadUrls(
  map: RegisteredMap,
  profile: MapProfile,
  relativePaths: string[],
  signal?: AbortSignal,
): Promise<Array<{ relativePath: string; url: string }>> {
  const body = JSON.stringify({
    profile,
    assets: relativePaths.map((relativePath) => ({ mapVersionId: map.mapVersionId, relativePath })),
  });
  const init: RequestInit = { method: "POST", headers: { "content-type": "application/json" }, body };
  const response = map.access === "cloud"
    ? await cloudRequest("/api/simforge/maps/cache-download-urls", init, { signal })
    : await cloudPublicRequest("/api/simforge/maps/cache-download-urls", init, signal);
  if (response.status === 401 || response.status === 403) {
    await discardResponseBody(response);
    throw new MapAccessError("NotAuthorized", "map_requires_cloud_connection", "map_requires_cloud_connection");
  }
  if (!response.ok) {
    await discardResponseBody(response);
    throw new MapAccessError("MapCacheError", "map_download_urls_unavailable", `SimCloud answered ${response.status} for download URLs`);
  }
  const payload = await response.json() as { assets?: unknown };
  if (!Array.isArray(payload.assets)) {
    throw new MapAccessError("MapCacheError", "map_download_urls_unavailable", "malformed download URL response");
  }
  const urls: Array<{ relativePath: string; url: string }> = [];
  for (const entry of payload.assets as Array<{ mapVersionId?: unknown; relativePath?: unknown; url?: unknown }>) {
    if (entry.mapVersionId !== map.mapVersionId || typeof entry.relativePath !== "string" || typeof entry.url !== "string") continue;
    let parsed: URL;
    try {
      parsed = new URL(entry.url);
    } catch {
      continue;
    }
    // Delivery is presigned storage or the Cloud itself; never plaintext to a remote host.
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopbackHost(parsed.hostname))) continue;
    urls.push({ relativePath: entry.relativePath, url: entry.url });
  }
  return urls;
}

/**
 * Presigned delivery URL for one member, fetched in batches so a 4 000-member
 * download costs tens of catalog requests rather than thousands.
 */
async function signedDownloadUrl(
  map: RegisteredMap,
  profile: MapProfile,
  relativePath: string,
  signal?: AbortSignal,
): Promise<string> {
  const poolKey = `${map.mapVersionId}\0${profile}`;
  let pool = pools.get(poolKey);
  if (!pool) {
    pool = { signed: new Map(), wanted: new Set(), inflight: null };
    pools.set(poolKey, pool);
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const fresh = pool.signed.get(relativePath);
    if (fresh && fresh.expiresAt > Date.now()) return fresh.url;
    pool.wanted.add(relativePath);
    if (!pool.inflight) {
      const current = pool;
      pool.inflight = (async () => {
        const now = Date.now();
        const batch = [...current.wanted];
        current.wanted.clear();
        for (const path of map[profile].keys()) {
          if (batch.length >= DOWNLOAD_URL_BATCH) break;
          const existing = current.signed.get(path);
          if (!batch.includes(path) && (!existing || existing.expiresAt <= now)) batch.push(path);
        }
        const urls = await requestDownloadUrls(map, profile, batch.slice(0, DOWNLOAD_URL_BATCH), signal);
        for (const { relativePath: path, url } of urls) {
          current.signed.set(path, { url, expiresAt: now + SIGNED_URL_TTL_MS });
        }
      })().finally(() => {
        current.inflight = null;
      });
    }
    await pool.inflight;
  }
  // A queued member can arrive in the final batch we just awaited.
  const delivered = pool.signed.get(relativePath);
  if (delivered && delivered.expiresAt > Date.now()) return delivered.url;
  throw new MapAccessError("NotFound", "map_asset_not_found", `SimCloud did not deliver ${relativePath}`);
}

/**
 * Where the bytes for one authorized asset come from on a cache miss: the
 * authenticated real upstream delivery URL, or a verified local file when
 * the member was installed on this machine. Never the cache endpoint itself.
 */
export async function resolveMapAssetSource(
  url: string,
  signal?: AbortSignal,
): Promise<{ url: string; headers?: Record<string, string> } | { path: string }> {
  const ref = parseLocalMapAssetUrl(url);
  if (ref.kind === "sumo-runtime") {
    return { path: localObjectPath(LOCAL_ARTIFACT_BUCKET, `uniscenario/sumo-runtime/${SUMO_RUNTIME_VERSION}/${ref.fileName}`) };
  }
  await primeCloudSession();
  const { map, member } = await resolveAuthorizedMapMember(ref);
  if (member.bucket !== MAP_CACHE_BUCKET) {
    return { path: localObjectPath(member.bucket, member.key) };
  }
  return { url: await signedDownloadUrl(map, ref.profile, ref.relativePath, signal) };
}
