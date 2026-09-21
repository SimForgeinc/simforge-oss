import type { AppContext } from "@/app/lib/db/app-context";
import { queryRows } from "@/app/lib/db/data-api";
import { CLOUD_DOWNLOAD_PROVENANCE, type RegisteredMap } from "@/app/lib/cloud/map-registry";
import type { ScenarioMapBrowserAsset } from "./document-store";

/** Read only authorization metadata and the bound preview, never either closure. */
export async function getScenarioMapThumbnail(
  _context: AppContext,
  mapVersionId: string,
): Promise<{ map: Pick<RegisteredMap, "access" | "origin">; thumbnail: ScenarioMapBrowserAsset | null } | null> {
  const [row] = await queryRows<{
    provenance_kind: string | null;
    provenance_origin: string | null;
    provenance_visibility: string | null;
    storage_bucket: string | null;
    storage_key: string | null;
    sha256: string | null;
    byte_length: number | null;
    media_type: string | null;
  }>(
    `SELECT mv.descriptor->'provenance'->>'kind' AS provenance_kind,
       mv.descriptor->'provenance'->>'origin' AS provenance_origin,
       mv.descriptor->'provenance'->>'visibility' AS provenance_visibility,
       a.storage_bucket, a.storage_key, a.sha256, a.byte_length, a.media_type
     FROM simforge.map_versions mv
     LEFT JOIN simforge.artifacts a ON a.id = mv.thumbnail_artifact_id
       AND a.workspace_id = mv.workspace_id
       AND a.artifact_kind = 'map-thumbnail-v2'
       AND a.artifact_state = 'available'
       AND a.deleted_at IS NULL
     WHERE mv.id = :map_version_id AND mv.retired_at IS NULL
     LIMIT 1`,
    { map_version_id: mapVersionId },
  );
  if (!row) return null;
  const downloaded = row.provenance_kind === CLOUD_DOWNLOAD_PROVENANCE;
  return {
    map: {
      access: downloaded ? (row.provenance_visibility === "public" ? "public" : "cloud") : "local",
      origin: downloaded ? row.provenance_origin : null,
    },
    thumbnail: row.sha256 && row.storage_bucket && row.storage_key && row.media_type && row.byte_length !== null
      ? {
          bucket: row.storage_bucket,
          key: row.storage_key,
          objectVersionId: null,
          sha256: row.sha256,
          byteLength: Number(row.byte_length),
          mediaType: row.media_type,
        }
      : null,
  };
}
