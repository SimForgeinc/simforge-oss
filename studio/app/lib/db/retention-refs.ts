import { queryRows } from "@/app/lib/db/data-api";

/**
 * What this installation's records still reference, for every path that
 * deletes stored bytes.
 *
 * Scenario revisions, saved simulation results and render jobs are immutable
 * and name their inputs by content digest (map version members, the road file,
 * closures, traces, timelines) or by storage key (artifact rows). Map bytes are
 * content-addressed and shared between releases, so "this map asset no longer
 * lists the file" or "no registry closure names this blob" never proves that
 * nothing else needs it. Deleting paths ask here first and keep anything named.
 *
 * Every query covers retired rows too: a retired map version still binds the
 * revisions made on it. A failing query throws; callers must treat that as
 * "everything is referenced", never as "nothing is".
 */

export const RETENTION_REFS_SCHEMA = "simforge.retention-refs.v1";

/** One column of a table that holds a sha256 some immutable record depends on. */
const DIGEST_COLUMNS: ReadonlyArray<readonly [table: string, column: string]> = [
  ["simforge.map_versions", "xodr_sha256"],
  ["simforge.map_versions", "descriptor->>'registryReleaseDigest'"],
  ["simforge.browser_asset_sets", "closure_sha256"],
  ["simforge.browser_asset_blobs", "sha256"],
  ["simforge.native_map_asset_sets", "closure_sha256"],
  ["simforge.native_map_asset_sets", "registry_release_digest"],
  ["simforge.native_map_asset_sets", "canonical_digest"],
  ["simforge.native_map_asset_blobs", "sha256"],
  ["simforge.artifacts", "sha256"],
  ["simforge.drafts", "map_closure_sha256"],
  ["simforge.revisions", "map_closure_sha256"],
  ["simforge.sim_results", "trace_sha256"],
  ["simforge.sim_results", "authored_trace_sha256"],
  ["simforge.sim_results", "trace_gzip_sha256"],
  ["simforge.sim_results", "resolution_sha256"],
  ["simforge.sim_results", "timeline_sha256"],
  ["simforge.sim_results", "map_closure_digest"],
  ["simforge.render_jobs", "trace_sha256"],
  ["simforge.render_jobs", "timeline_sha256"],
];

/** Every storage location an immutable record names, as (bucket, key) columns. */
const KEY_COLUMNS: ReadonlyArray<readonly [table: string, bucket: string, key: string]> = [
  ["simforge.artifacts", "storage_bucket", "storage_key"],
  ["simforge.browser_asset_blobs", "storage_bucket", "storage_key"],
  ["simforge.native_map_asset_blobs", "storage_bucket", "storage_key"],
  ["simforge.sim_results", "storage_bucket", "trace_storage_key"],
  ["simforge.sim_results", "storage_bucket", "resolution_storage_key"],
  ["simforge.sim_results", "storage_bucket", "timeline_storage_key"],
  ["public.map_asset_artifacts", "s3_bucket", "s3_key"],
];

const DIGEST = /^[a-f0-9]{64}$/;

/** All digests any record references (the `simforge.retention-refs.v1` payload). */
export async function collectReferencedDigests(): Promise<Set<string>> {
  const sql = DIGEST_COLUMNS
    .map(([table, column]) => `SELECT ${column} AS digest FROM ${table} WHERE ${column} IS NOT NULL`)
    .join("\nUNION\n");
  const digests = new Set<string>();
  for (const row of await queryRows<{ digest: string }>(sql)) {
    if (DIGEST.test(row.digest)) digests.add(row.digest);
  }
  return digests;
}

export type RetentionRefsDocument = {
  schema: typeof RETENTION_REFS_SCHEMA;
  generatedAt: string;
  source: string;
  digests: string[];
};

/** Snapshot for `simforge maps prune --gc --refs <file>`; generate it right before the prune. */
export async function retentionRefsDocument(source: string, now: Date = new Date()): Promise<RetentionRefsDocument> {
  const digests = [...(await collectReferencedDigests())].sort();
  return { schema: RETENTION_REFS_SCHEMA, generatedAt: now.toISOString(), source, digests };
}

export type RetentionCandidate = { key: string; sha256?: string | null };
export type RetainedObject = { key: string; reasons: string[] };

/**
 * Split objects a caller wants to delete into those no record needs and those
 * that must stay. An object stays when any record names its bucket/key, or —
 * when its digest is known — when any record references that digest (a map
 * version, a revision's map pin, a simulation result, a render job).
 */
export async function partitionReferencedObjects(
  bucket: string,
  candidates: readonly RetentionCandidate[],
): Promise<{ deletable: string[]; retained: RetainedObject[] }> {
  if (candidates.length === 0) return { deletable: [], retained: [] };
  const reasons = new Map<string, Set<string>>();
  const note = (key: string, reason: string) => {
    const set = reasons.get(key) ?? new Set<string>();
    set.add(reason);
    reasons.set(key, set);
  };
  const keys = [...new Set(candidates.map((candidate) => candidate.key))];
  for (const [table, bucketColumn, keyColumn] of KEY_COLUMNS) {
    const rows = await queryRows<{ key: string }>(
      `SELECT DISTINCT ${keyColumn} AS key FROM ${table}
        WHERE ${bucketColumn} = :bucket
          AND ${keyColumn} IN (SELECT jsonb_array_elements_text(CAST(:keys AS jsonb)))`,
      { bucket, keys: JSON.stringify(keys) },
    );
    for (const row of rows) note(row.key, `${table}.${keyColumn}`);
  }
  const digests = [...new Set(candidates.flatMap((candidate) =>
    candidate.sha256 && DIGEST.test(candidate.sha256) ? [candidate.sha256] : []))];
  if (digests.length > 0) {
    const sql = DIGEST_COLUMNS
      .map(([table, column]) =>
        `SELECT DISTINCT ${column} AS digest, '${table}.${column.replace(/'/g, "")}' AS source FROM ${table}
          WHERE ${column} = ANY(string_to_array(:digests, ','))`)
      .join("\nUNION\n");
    const referenced = new Map<string, Set<string>>();
    for (const row of await queryRows<{ digest: string; source: string }>(sql, { digests: digests.join(",") })) {
      const set = referenced.get(row.digest) ?? new Set<string>();
      set.add(row.source);
      referenced.set(row.digest, set);
    }
    for (const candidate of candidates) {
      for (const source of candidate.sha256 ? referenced.get(candidate.sha256) ?? [] : []) note(candidate.key, source);
    }
  }
  return {
    deletable: keys.filter((key) => !reasons.has(key)),
    retained: keys.filter((key) => reasons.has(key)).map((key) => ({ key, reasons: [...reasons.get(key)!].sort() })),
  };
}
