import { queryRows } from "@/app/lib/db/data-api";

/**
 * The registered native input identity of an immutable map version: the
 * single lookup every native consumer (full Bevy renders and still previews)
 * uses to learn which release the map is bound to and exactly which verified
 * bytes make up its runtime closure.
 *
 * Eligibility is the map's own binding, not a heuristic: the native asset
 * set must belong to the same workspace and map version, be available under
 * the v1 contract, and carry the registry release digest the map descriptor
 * pins. Every member must be a verified blob and the set must be complete
 * against its recorded object count before anything is handed out.
 */

export const NATIVE_MAP_ASSET_SET_CONTRACT = "simforge.native-map-asset-set.v1";

/**
 * The publisher's installation receipt is registered as a set member so the
 * closure digest covers it, but it is not a runtime resource: the renderer
 * never loads it and a prepared profile directory need not contain it.
 */
export const NATIVE_MAP_RELEASE_RECEIPT = ".map-release.json";

export type RegisteredNativeMapMember = {
  relativePath: string;
  sha256: string;
  sizeBytes: number;
};

export type RegisteredNativeMapSource = {
  /** Upstream map asset the version was derived from; null for locally authored maps. */
  sourceMapAssetId: string | null;
  registryReleaseDigest: string;
  canonicalDigest: string;
  /** Runtime members sorted by relative path; the receipt is omitted. */
  members: RegisteredNativeMapMember[];
};

type SourceRow = {
  source_map_asset_id: string | null;
  registry_release_digest: string;
  canonical_digest: string;
  object_count: number | string;
  relative_path: string | null;
  sha256: string | null;
  byte_length: number | string | null;
};

/**
 * Null when the map version binds no eligible native set. Throws
 * `native_map_asset_set_incomplete` when the bound set has fewer verified
 * members than it declares, and `native_map_master_unavailable` when the
 * closure lacks `master.gltf`.
 */
export async function getRegisteredNativeMapSource(
  workspaceId: string,
  mapVersionId: string,
): Promise<RegisteredNativeMapSource | null> {
  const rows = await queryRows<SourceRow>(
    `SELECT mv.source_map_asset_id, s.registry_release_digest, s.canonical_digest, s.object_count,
            m.relative_path, b.sha256, b.byte_length
       FROM simforge.map_versions mv
       JOIN simforge.native_map_asset_sets s
         ON s.id = mv.native_map_asset_set_id
        AND s.workspace_id = mv.workspace_id
        AND s.map_version_id = mv.id
        AND s.asset_set_state = 'available'
        AND s.contract_version = :contract
        AND s.registry_release_digest = mv.descriptor->>'registryReleaseDigest'
       LEFT JOIN simforge.native_map_asset_members m ON m.asset_set_id = s.id
       LEFT JOIN simforge.native_map_asset_blobs b
         ON b.id = m.blob_id AND b.verification_state = 'verified'
      WHERE mv.id = :map_version_id AND mv.workspace_id = :workspace_id
      ORDER BY m.relative_path`,
    { map_version_id: mapVersionId, workspace_id: workspaceId, contract: NATIVE_MAP_ASSET_SET_CONTRACT },
  );
  const first = rows[0];
  if (!first) return null;
  const verified = rows.filter(
    (row): row is SourceRow & { relative_path: string; sha256: string; byte_length: number | string } =>
      row.relative_path !== null && row.sha256 !== null && row.byte_length !== null,
  );
  const expectedCount = Number(first.object_count);
  if (expectedCount < 1 || verified.length !== expectedCount) throw new Error("native_map_asset_set_incomplete");
  const members = verified.filter((row) => row.relative_path !== NATIVE_MAP_RELEASE_RECEIPT);
  if (!members.some((row) => row.relative_path === "master.gltf")) throw new Error("native_map_master_unavailable");
  return {
    sourceMapAssetId: first.source_map_asset_id?.trim() || null,
    registryReleaseDigest: first.registry_release_digest,
    canonicalDigest: first.canonical_digest,
    members: members.map((row) => ({
      relativePath: row.relative_path,
      sha256: row.sha256,
      sizeBytes: Number(row.byte_length),
    })),
  };
}
