import { createHash } from "node:crypto";
import { queryRows } from "@/app/lib/db/data-api";
import { getPresignedGetUrl } from "@/app/lib/s3/s3-presign";

/**
 * Worker cache prewarm: the published native map closures an approved render
 * worker keeps in its content-addressed cache, their members (paged under the
 * Data API's 1 MB result cap), and batch URL signing for those blobs by
 * digest. Only blobs that belong to a published (unretired, available) set
 * can be signed, so the route cannot be used to read arbitrary objects.
 */

const CONTROL_SCHEMA = "simforge.render-worker-control/v2";
const NATIVE_SET_CONTRACT = "simforge.native-map-asset-set.v1";
/** Members per page: ~150 B per formatted row keeps a page well under 1 MB. */
export const PREWARM_MEMBERS_PAGE = 3000;
export const BLOB_URLS_MAX = 500;
const BLOB_URL_TTL_SECONDS = 3600;

function runtimeEnvironment(): "dev" | "staging" | "prod" {
  const value = process.env.SIMFORGE_ENV?.trim();
  if (value !== "dev" && value !== "staging" && value !== "prod") {
    throw new Error("SIMFORGE_ENV must identify the Scenario control-plane environment.");
  }
  return value;
}

/** The published-set predicate every query here shares (same as the native lease's). */
const PUBLISHED_SETS = `
  FROM simforge.map_versions mv
  JOIN simforge.native_map_asset_sets s
    ON s.id = mv.native_map_asset_set_id
   AND s.workspace_id = mv.workspace_id
   AND s.map_version_id = mv.id
   AND s.asset_set_state = 'available'
   AND s.contract_version = '${NATIVE_SET_CONTRACT}'
   AND s.registry_release_digest = mv.descriptor->>'registryReleaseDigest'
 WHERE mv.retired_at IS NULL`;

/** An approved, actively registered worker of this environment. */
export async function approvedRenderWorker(workerNodeId: string, registrationId?: string): Promise<boolean> {
  const rows = await queryRows<{ id: string }>(
    `SELECT id FROM simforge.worker_nodes
      WHERE id = :worker_node_id AND environment = :environment
        AND registration_state = 'active'
        AND approved_worker_version = worker_version
        AND approved_image_digest = image_digest
        AND approved_hardware_profile = hardware_profile
        AND approved_at IS NOT NULL
        ${registrationId ? "AND registration_id = :registration_id" : ""}
      LIMIT 1`,
    { worker_node_id: workerNodeId, environment: runtimeEnvironment(), ...(registrationId ? { registration_id: registrationId } : {}) },
  );
  return rows.length > 0;
}

export async function listPrewarmSets() {
  const rows = await queryRows<{
    set_id: string; map_version_id: string; map_id: string; closure_sha256: string;
    object_count: number | string; byte_length: number | string; created_at: string; turn_verdicts_sha256: string | null;
  }>(
    `SELECT s.id AS set_id, mv.id AS map_version_id, mv.source_map_id AS map_id,
            s.closure_sha256, s.object_count, s.byte_length, mv.created_at::text AS created_at,
            mv.descriptor->'ambientTurnVerdicts'->>'sha256' AS turn_verdicts_sha256
     ${PUBLISHED_SETS}
     ORDER BY mv.created_at DESC, s.id`,
  );
  const sets = rows.map((row) => ({
    setId: row.set_id,
    mapVersionId: row.map_version_id,
    mapId: row.map_id,
    closureSha256: row.closure_sha256,
    objectCount: Number(row.object_count),
    byteLength: Number(row.byte_length),
    createdAt: row.created_at,
    ...(row.turn_verdicts_sha256 && /^[a-f0-9]{64}$/.test(row.turn_verdicts_sha256) ? { turnVerdictsSha256: row.turn_verdicts_sha256 } : {}),
  }));
  const generation = createHash("sha256")
    .update(JSON.stringify(sets.map((set) => [set.setId, set.closureSha256, set.objectCount, set.turnVerdictsSha256 ?? null])))
    .digest("hex");
  return { schema: CONTROL_SCHEMA, type: "worker.prewarm-manifest" as const, generation, sets };
}

/** One page of a published set's members, ordered by path; `.map-release.json` is not a render input. */
export async function listPrewarmMembers(setId: string, after: string | null, pageSize = PREWARM_MEMBERS_PAGE) {
  const rows = await queryRows<{ relative_path: string; sha256: string; byte_length: number | string }>(
    `SELECT m.relative_path, b.sha256, b.byte_length
       FROM simforge.native_map_asset_members m
       JOIN simforge.native_map_asset_blobs b ON b.id = m.blob_id AND b.verification_state = 'verified'
      WHERE m.asset_set_id = :set_id
        AND m.relative_path <> '.map-release.json'
        AND m.relative_path > :after
        AND EXISTS (SELECT 1 ${PUBLISHED_SETS} AND s.id = :set_id)
      ORDER BY m.relative_path
      LIMIT ${Math.max(1, Math.min(PREWARM_MEMBERS_PAGE, Math.floor(pageSize))) + 1}`,
    { set_id: setId, after: after ?? "" },
  );
  const limit = Math.max(1, Math.min(PREWARM_MEMBERS_PAGE, Math.floor(pageSize)));
  const page = rows.slice(0, limit);
  const next = rows.length > limit ? page.at(-1)!.relative_path : null;
  const members = page.map((row) => ({ relativePath: row.relative_path, sha256: row.sha256, sizeBytes: Number(row.byte_length) }));
  // The published ambient turn-verdict table rides with the closure when the
  // map version binds it (WS-A, `descriptor.ambientTurnVerdicts`); served on
  // the last page so it is listed exactly once.
  if (next === null) {
    const verdicts = await boundTurnVerdicts(setId);
    if (verdicts && !members.some((member) => member.relativePath === AMBIENT_TURN_VERDICTS_PATH)) members.push(verdicts);
  }
  return { schema: CONTROL_SCHEMA, type: "worker.prewarm-members" as const, members, next };
}

export const AMBIENT_TURN_VERDICTS_PATH = "derived/ambient/turn-verdicts.json.gz";

/** The turn-verdict blob a published set's map version binds, if any. */
async function boundTurnVerdicts(setId: string) {
  const rows = await queryRows<{ sha256: string; byte_length: number | string }>(
    `SELECT b.sha256, b.byte_length
       FROM simforge.browser_asset_blobs b
      WHERE b.verification_state = 'verified'
        AND b.sha256 = (SELECT mv.descriptor->'ambientTurnVerdicts'->>'sha256' ${PUBLISHED_SETS} AND s.id = :set_id LIMIT 1)
      LIMIT 1`,
    { set_id: setId },
  );
  const row = rows[0];
  return row ? { relativePath: AMBIENT_TURN_VERDICTS_PATH, sha256: row.sha256, sizeBytes: Number(row.byte_length) } : null;
}

/**
 * Signs GET URLs for blobs of one published set; digests that are not
 * verified members of that set (or a set that is not published) are omitted.
 * Scoping by set keeps the lookup on the members primary key (~0.5 s per
 * 500 digests on dev) instead of a join across every set.
 */
export async function signPrewarmBlobs(setId: string, sha256s: readonly string[]) {
  const digests = [...new Set(sha256s)].filter((digest) => /^[0-9a-f]{64}$/.test(digest)).slice(0, BLOB_URLS_MAX);
  const downloads: Record<string, { url: string; headers: Record<string, string>; expiresAt: string }> = {};
  if (digests.length === 0) return { schema: CONTROL_SCHEMA, type: "worker.blob-urls" as const, downloads };
  const rows = await queryRows<{ sha256: string; storage_bucket: string; storage_key: string }>(
    `SELECT DISTINCT ON (b.sha256) b.sha256, b.storage_bucket, b.storage_key
       FROM simforge.native_map_asset_members m
       JOIN simforge.native_map_asset_blobs b ON b.id = m.blob_id AND b.verification_state = 'verified'
      WHERE m.asset_set_id = :set_id
        AND b.sha256 = ANY(string_to_array(:digests, ','))
        AND EXISTS (SELECT 1 ${PUBLISHED_SETS} AND s.id = :set_id)
      ORDER BY b.sha256, b.id`,
    { set_id: setId, digests: digests.join(",") },
  );
  const verdictRows = await queryRows<{ sha256: string; storage_bucket: string; storage_key: string }>(
    `SELECT b.sha256, b.storage_bucket, b.storage_key
       FROM simforge.browser_asset_blobs b
      WHERE b.verification_state = 'verified'
        AND b.sha256 = ANY(string_to_array(:digests, ','))
        AND b.sha256 = (SELECT mv.descriptor->'ambientTurnVerdicts'->>'sha256' ${PUBLISHED_SETS} AND s.id = :set_id LIMIT 1)
      LIMIT 1`,
    { set_id: setId, digests: digests.join(",") },
  );
  if (verdictRows[0] && !rows.some((row) => row.sha256 === verdictRows[0]!.sha256)) rows.push(verdictRows[0]);
  const expiresAt = new Date(Date.now() + BLOB_URL_TTL_SECONDS * 1000).toISOString();
  await Promise.all(rows.map(async (row) => {
    downloads[row.sha256] = {
      url: await getPresignedGetUrl(row.storage_key, row.storage_bucket, BLOB_URL_TTL_SECONDS),
      headers: {},
      expiresAt,
    };
  }));
  return { schema: CONTROL_SCHEMA, type: "worker.blob-urls" as const, downloads };
}

/** Stores the worker's reported cache/prewarm status beside its registration metadata. */
export async function recordWorkerCacheStatus(workerNodeId: string, registrationId: string, cache: unknown) {
  const rows = await queryRows<{ id: string }>(
    `UPDATE simforge.worker_nodes
        SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('cacheStatus', CAST(:cache AS jsonb))
      WHERE id = :worker_node_id AND registration_id = :registration_id AND environment = :environment
      RETURNING id`,
    { worker_node_id: workerNodeId, registration_id: registrationId, environment: runtimeEnvironment(), cache: JSON.stringify(cache) },
  );
  return rows.length > 0 ? { schema: CONTROL_SCHEMA, type: "worker.cache-status" as const } : null;
}

type Queryable = { queryRows<T>(sql: string, params?: Record<string, unknown>): Promise<T[]> };

/**
 * Scene memory (textures + geometry + reserve) a native map needs at a
 * texture tier, as measured by warm workers from its KTX2 headers; null when
 * no worker has measured it yet (admission then cannot judge and admits).
 */
export async function knownNativeSceneDemand(mapVersionId: string, renderTextures: string, db: Queryable = { queryRows }) {
  const rows = await db.queryRows<{ scene_bytes: string | number | null }>(
    `SELECT MAX((d->>'sceneBytes')::bigint) AS scene_bytes
       FROM simforge.worker_nodes w,
            jsonb_array_elements(COALESCE(w.metadata->'cacheStatus'->'demand', '[]'::jsonb)) d
      WHERE w.environment = :environment AND w.renderer_engine = 'native'
        AND d->>'mapVersionId' = :map_version_id AND d->>'renderTextures' = :render_textures`,
    { environment: runtimeEnvironment(), map_version_id: mapVersionId, render_textures: renderTextures },
  );
  const value = rows[0]?.scene_bytes;
  return value === null || value === undefined ? null : Number(value);
}

/** GPU memory (bytes) of every approved, active native worker of this environment. */
export async function activeNativeGpuCapacities(db: Queryable = { queryRows }) {
  const rows = await db.queryRows<{ gpu_memory_mib: string | number | null }>(
    `SELECT (metadata->>'gpuMemoryMiB')::integer AS gpu_memory_mib
       FROM simforge.worker_nodes
      WHERE environment = :environment AND renderer_engine = 'native'
        AND registration_state = 'active' AND approved_at IS NOT NULL
        AND approved_worker_version = worker_version AND approved_image_digest = image_digest
        AND last_heartbeat_at > NOW() - INTERVAL '1 day'`,
    { environment: runtimeEnvironment() },
  );
  return rows.map((row) => Number(row.gpu_memory_mib) * 1024 * 1024).filter((bytes) => Number.isFinite(bytes) && bytes > 0);
}

/** Per-worker headroom kept free of scene + attachments (driver, desktop, co-tenant idle services). */
export const NATIVE_GPU_HEADROOM_BYTES = 1024 ** 3;

export class NativeSceneMemoryError extends Error {
  readonly detail: string;
  constructor(readonly neededBytes: number, readonly largestBytes: number, renderTextures: string) {
    super("uniscenario_render_resource_mapTextureMemory_exceeded");
    const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
    this.detail = `Not enough GPU memory for this map at ${renderTextures === "bc7-512" ? "ML" : "full"} texture quality: it needs about ${gb(neededBytes)} GB and the largest available render GPU has ${gb(largestBytes)} GB. `
      + (renderTextures === "uastc-full" ? "Render at ML quality or below 720p, or " : "")
      + "wait for a worker with more GPU memory.";
  }
}
