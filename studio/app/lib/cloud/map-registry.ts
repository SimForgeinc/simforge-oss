import { queryRows } from "@/app/lib/db/data-api";

/**
 * Verified metadata of the maps this installation may serve: every immutable
 * member of a map's browser and native closures with its digest, size, media
 * type and where the bytes live. Asset authorization reads this in memory —
 * one database load per map version per process, never per member — and
 * knows which maps the local owner may use without an account.
 *
 * Bytes of a downloaded map live in the local service's content-addressed
 * map cache, recorded in the blob rows under {@link MAP_CACHE_BUCKET}; bytes
 * of a registry release installed on this machine (a development input) live
 * in the local object store under its real bucket/key.
 */

/** Virtual blob bucket naming the local service's map cache; `key` is `objects/<sha256>`. */
export const MAP_CACHE_BUCKET = "simforge-map-cache";

export const MAP_CACHE_KEY_PREFIX = "objects/";

/** Provenance kind recorded on maps downloaded from the connected/public Cloud. */
export const CLOUD_DOWNLOAD_PROVENANCE = "simcloud-download";

export type MapProfile = "browser" | "semantic";

/**
 * - `public`: published for everyone by the Cloud (the real Richmond Field Station).
 * - `local`: installed on this machine by its owner; no account involved.
 * - `cloud`: published to signed-in accounts; usable while this installation's session is active.
 */
export type MapAccess = "public" | "local" | "cloud";

export type RegistryMember = {
  sha256: string;
  byteLength: number;
  mediaType: string;
  bucket: string;
  key: string;
};

export type RegisteredMap = {
  mapVersionId: string;
  access: MapAccess;
  /** Cloud origin the map was published by, for downloaded maps. */
  origin: string | null;
  /** Immutable identities the native asset set is bound to; null until the native set is registered. */
  registryReleaseDigest: string | null;
  canonicalDigest: string | null;
  browser: Map<string, RegistryMember>;
  /** Native closure members (master.gltf and its resources); empty until registered. */
  semantic: Map<string, RegistryMember>;
};

type MemberRow = {
  relative_path: string;
  sha256: string;
  byte_length: number | string;
  media_type: string;
  storage_bucket: string;
  storage_key: string;
};

type MapRow = {
  id: string;
  provenance_kind: string | null;
  provenance_origin: string | null;
  provenance_visibility: string | null;
  registry_release_digest: string | null;
  canonical_digest: string | null;
};

const REGISTRY_KEY = Symbol.for("simforge.local-map-registry");
type RegistryState = {
  maps: Map<string, Promise<RegisteredMap | null>>;
  /** Members known from an upstream plan before the map is registered locally. */
  upstream: Map<string, RegisteredMap>;
};
const registry: RegistryState = ((globalThis as Record<symbol, unknown>)[REGISTRY_KEY] ??= {
  maps: new Map(),
  upstream: new Map(),
} satisfies RegistryState) as RegistryState;

function memberMap(rows: MemberRow[]): Map<string, RegistryMember> {
  const members = new Map<string, RegistryMember>();
  for (const row of rows) {
    members.set(row.relative_path, {
      sha256: row.sha256,
      byteLength: Number(row.byte_length),
      mediaType: row.media_type,
      bucket: row.storage_bucket,
      key: row.storage_key,
    });
  }
  return members;
}

async function loadRegisteredMap(mapVersionId: string): Promise<RegisteredMap | null> {
  const [map] = await queryRows<MapRow>(
    `SELECT mv.id,
       mv.descriptor->'provenance'->>'kind' AS provenance_kind,
       mv.descriptor->'provenance'->>'origin' AS provenance_origin,
       mv.descriptor->'provenance'->>'visibility' AS provenance_visibility,
       mv.descriptor->>'registryReleaseDigest' AS registry_release_digest,
       ns.canonical_digest
     FROM simforge.map_versions mv
     LEFT JOIN simforge.native_map_asset_sets ns ON ns.id = mv.native_map_asset_set_id
       AND ns.workspace_id = mv.workspace_id AND ns.asset_set_state = 'available'
     WHERE mv.id = :map_version_id AND mv.retired_at IS NULL
     LIMIT 1`,
    { map_version_id: mapVersionId },
  );
  if (!map) return null;
  const browserRows = await queryRows<MemberRow>(
    `SELECT m.relative_path, b.sha256, b.byte_length, b.media_type, b.storage_bucket, b.storage_key
     FROM simforge.map_versions mv
     JOIN simforge.browser_asset_sets s ON s.id = mv.browser_asset_set_id
       AND s.workspace_id = mv.workspace_id AND s.asset_set_state = 'available'
     JOIN simforge.browser_asset_members m ON m.asset_set_id = s.id
     JOIN simforge.browser_asset_blobs b ON b.id = m.blob_id AND b.verification_state = 'verified'
     WHERE mv.id = :map_version_id`,
    { map_version_id: mapVersionId },
  );
  const nativeRows = await queryRows<MemberRow>(
    `SELECT m.relative_path, b.sha256, b.byte_length, b.media_type, b.storage_bucket, b.storage_key
     FROM simforge.map_versions mv
     JOIN simforge.native_map_asset_sets s ON s.id = mv.native_map_asset_set_id
       AND s.workspace_id = mv.workspace_id AND s.asset_set_state = 'available'
     JOIN simforge.native_map_asset_members m ON m.asset_set_id = s.id
     JOIN simforge.native_map_asset_blobs b ON b.id = m.blob_id AND b.verification_state = 'verified'
     WHERE mv.id = :map_version_id`,
    { map_version_id: mapVersionId },
  );
  const downloaded = map.provenance_kind === CLOUD_DOWNLOAD_PROVENANCE;
  return {
    mapVersionId,
    access: downloaded ? (map.provenance_visibility === "public" ? "public" : "cloud") : "local",
    origin: downloaded ? map.provenance_origin : null,
    registryReleaseDigest: map.registry_release_digest,
    canonicalDigest: map.canonical_digest,
    browser: memberMap(browserRows),
    semantic: memberMap(nativeRows),
  };
}

/** The locally registered map, memoized per process once registered; null when not registered. */
export function getRegisteredMap(mapVersionId: string): Promise<RegisteredMap | null> {
  let pending = registry.maps.get(mapVersionId);
  if (!pending) {
    pending = loadRegisteredMap(mapVersionId).then(
      (map) => {
        // Only registrations are durable facts; an absent map may be registered next.
        if (!map) registry.maps.delete(mapVersionId);
        return map;
      },
      (error: unknown) => {
        registry.maps.delete(mapVersionId);
        throw error;
      },
    );
    registry.maps.set(mapVersionId, pending);
  }
  return pending;
}

/** Forget the memoized rows after registration changes them. */
export function invalidateRegisteredMap(mapVersionId: string): void {
  registry.maps.delete(mapVersionId);
}

/**
 * Members of a map known from the Cloud's verified plan while it downloads,
 * before local registration exists. Authorization consults this after the
 * local registry so a download can be served member by member.
 */
export function rememberUpstreamMap(map: RegisteredMap): void {
  const existing = registry.upstream.get(map.mapVersionId);
  if (!existing) {
    registry.upstream.set(map.mapVersionId, map);
    return;
  }
  for (const [path, member] of map.browser) existing.browser.set(path, member);
  for (const [path, member] of map.semantic) existing.semantic.set(path, member);
  existing.registryReleaseDigest ??= map.registryReleaseDigest;
  existing.canonicalDigest ??= map.canonicalDigest;
}

/**
 * Resolve a map for authorizing one profile's members. A plan remembered from
 * the Cloud for that profile is the verified identity of what is downloading
 * (and, once registered, of the same rows), so it answers without a database
 * read per member; otherwise the local registration is consulted.
 */
export async function resolveKnownMap(mapVersionId: string, profile: MapProfile): Promise<RegisteredMap | null> {
  const upstream = registry.upstream.get(mapVersionId);
  if (upstream && upstream[profile].size > 0) return upstream;
  return getRegisteredMap(mapVersionId);
}
