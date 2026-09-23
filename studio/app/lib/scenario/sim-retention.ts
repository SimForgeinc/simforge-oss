import "server-only";

import { queryRows, withTransaction } from "@/app/lib/db/data-api";
import { deleteS3Keys } from "@/app/lib/s3/s3-delete";

/**
 * Retention of simulation data, by REACHABILITY (never reference counts, which drift).
 *
 * A result is live while anything the product keeps points at it:
 *   - a revision's history row (`revision_simulations.sim_key` or `.previous_sim_key`),
 *   - a revision's active simulation (`revision_active_simulation`),
 *   - a render job (`render_jobs.sim_key`),
 *   - a draft's last shown result (`drafts.last_sim_key`),
 *   - a request younger than the request TTL (`sim_requests`, the in-flight memo),
 *   - a stored timeline another live result replays (shared trace).
 * Everything else is draft cache: a pure function of (content, map, engine) that is simulated
 * again on demand. Cache results older than `draftCacheDays` are deleted with their timeline rows,
 * requests and memoized diffs; their objects are deleted only when no remaining row names them.
 * Requests and editor verification events expire on their own TTLs.
 *
 * On SimCloud the GC runs as the dedicated GC role: the artifact bucket denies deleting the
 * content-addressed prefixes to everyone else (docs/operations/simulation-retention.md).
 */

export type RetentionPolicy = {
  /** Unreachable draft-cache results older than this are deleted. */
  draftCacheDays: number;
  /** Finished simulation requests (the queue, not history) older than this are deleted. */
  requestDays: number;
  /** Editor verification telemetry older than this is deleted. */
  verificationEventDays: number;
  /** Results examined per run (bounded work per invocation). */
  batch: number;
};

export const DEFAULT_RETENTION: RetentionPolicy = { draftCacheDays: 90, requestDays: 30, verificationEventDays: 90, batch: 500 };

export type RetentionReport = {
  apply: boolean;
  policy: RetentionPolicy;
  requests: number;
  verificationEvents: number;
  results: Array<{ workspaceId: string; simKey: string; createdAt: string }>;
  timelines: number;
  objects: Array<{ bucket: string; key: string }>;
};

type Candidate = { workspace_id: string; sim_key: string; created_at: string; storage_bucket: string; trace_storage_key: string; resolution_storage_key: string; timeline_storage_key: string | null };

const LIVE_RESULT = `
  EXISTS (SELECT 1 FROM simforge.revision_simulations rs WHERE rs.workspace_id = r.workspace_id AND (rs.sim_key = r.sim_key OR rs.previous_sim_key = r.sim_key))
  OR EXISTS (SELECT 1 FROM simforge.revision_active_simulation p WHERE p.workspace_id = r.workspace_id AND p.sim_key = r.sim_key)
  OR EXISTS (SELECT 1 FROM simforge.render_jobs j WHERE j.workspace_id = r.workspace_id AND j.sim_key = r.sim_key)
  OR EXISTS (SELECT 1 FROM simforge.drafts d WHERE d.workspace_id = r.workspace_id AND d.last_sim_key = r.sim_key)
  OR EXISTS (SELECT 1 FROM simforge.sim_requests q WHERE q.workspace_id = r.workspace_id AND q.sim_key = r.sim_key
               AND COALESCE(q.completed_at, q.updated_at) >= NOW() - (:request_days * INTERVAL '1 day'))`;

/** Unreachable results past the draft-cache TTL whose timelines no live result shares. */
async function candidates(policy: RetentionPolicy): Promise<Candidate[]> {
  return queryRows<Candidate>(
    `SELECT r.workspace_id, r.sim_key, r.created_at::text AS created_at, r.storage_bucket,
            r.trace_storage_key, r.resolution_storage_key, r.timeline_storage_key
       FROM simforge.sim_results r
      WHERE r.created_at < NOW() - (:cache_days * INTERVAL '1 day')
        AND NOT (${LIVE_RESULT})
        AND NOT EXISTS (
          SELECT 1 FROM simforge.sim_timelines t
            JOIN simforge.sim_results other ON other.workspace_id = t.workspace_id AND other.trace_sha256 = t.trace_sha256
             AND other.sim_key <> r.sim_key
           WHERE t.workspace_id = r.workspace_id AND t.source_sim_key = r.sim_key)
      ORDER BY r.created_at, r.sim_key
      LIMIT ${Math.max(1, Math.min(5_000, Math.floor(policy.batch)))}`,
    { cache_days: policy.draftCacheDays, request_days: policy.requestDays },
  );
}

/** Object keys of the deleted results and timelines that no remaining row names. */
async function orphanedObjects(deleted: Candidate[], timelineKeys: Array<{ bucket: string; key: string }>): Promise<Array<{ bucket: string; key: string }>> {
  const wanted = new Map<string, { bucket: string; key: string }>();
  for (const result of deleted) {
    for (const key of [result.trace_storage_key, result.resolution_storage_key, result.timeline_storage_key]) {
      if (key) wanted.set(`${result.storage_bucket}\n${key}`, { bucket: result.storage_bucket, key });
    }
  }
  for (const object of timelineKeys) wanted.set(`${object.bucket}\n${object.key}`, object);
  if (wanted.size === 0) return [];
  const keys = [...wanted.values()].map((object) => object.key);
  const stillNamed = await queryRows<{ key: string }>(
    `SELECT trace_storage_key AS key FROM simforge.sim_results WHERE trace_storage_key IN (SELECT jsonb_array_elements_text(CAST(:keys AS jsonb)))
     UNION SELECT resolution_storage_key FROM simforge.sim_results WHERE resolution_storage_key IN (SELECT jsonb_array_elements_text(CAST(:keys AS jsonb)))
     UNION SELECT timeline_storage_key FROM simforge.sim_results WHERE timeline_storage_key IN (SELECT jsonb_array_elements_text(CAST(:keys AS jsonb)))
     UNION SELECT storage_key FROM simforge.sim_timelines WHERE storage_key IN (SELECT jsonb_array_elements_text(CAST(:keys AS jsonb)))`,
    { keys },
  );
  const named = new Set(stillNamed.map((row) => row.key));
  return [...wanted.values()].filter((object) => !named.has(object.key));
}

/**
 * One retention pass. A dry run (`apply: false`) reports exactly what an applied run would delete
 * and changes nothing. Rows go first, in one transaction; objects after, so no row ever names a
 * deleted object (the bucket's versioning keeps deleted objects recoverable for its window).
 */
export async function runSimulationRetention(options: { apply: boolean; policy?: Partial<RetentionPolicy> }): Promise<RetentionReport> {
  const policy = { ...DEFAULT_RETENTION, ...options.policy };
  const doomed = await candidates(policy);
  const params = { request_days: policy.requestDays, event_days: policy.verificationEventDays };
  const expiredRequests = `request_state IN ('succeeded', 'failed')
      AND COALESCE(completed_at, updated_at) < NOW() - (:request_days * INTERVAL '1 day')`;
  const expiredEvents = `created_at < NOW() - (:event_days * INTERVAL '1 day')`;

  if (!options.apply) {
    const [requests] = await queryRows<{ n: number | string }>(`SELECT COUNT(*) AS n FROM simforge.sim_requests WHERE ${expiredRequests}`, params);
    const [events] = await queryRows<{ n: number | string }>(`SELECT COUNT(*) AS n FROM simforge.sim_verification_events WHERE ${expiredEvents}`, params);
    const timelineRows = doomed.length === 0 ? [] : await queryRows<{ n: number | string }>(
      `SELECT COUNT(*) AS n FROM simforge.sim_timelines WHERE (workspace_id, source_sim_key) IN (
         SELECT x->>'w', x->>'s' FROM jsonb_array_elements(CAST(:doomed AS jsonb)) x)`,
      { doomed: doomed.map((row) => ({ w: row.workspace_id, s: row.sim_key })) },
    );
    return {
      apply: false,
      policy,
      requests: Number(requests?.n ?? 0),
      verificationEvents: Number(events?.n ?? 0),
      results: doomed.map((row) => ({ workspaceId: row.workspace_id, simKey: row.sim_key, createdAt: row.created_at })),
      timelines: Number(timelineRows[0]?.n ?? 0),
      objects: [],
    };
  }

  const doomedJson = doomed.map((row) => ({ w: row.workspace_id, s: row.sim_key }));
  const outcome = await withTransaction(async (tx) => {
    const requests = await tx.queryRows<{ request_key: string }>(
      `DELETE FROM simforge.sim_requests WHERE ${expiredRequests} RETURNING request_key`, params,
    );
    const events = await tx.queryRows<{ id: string }>(
      `DELETE FROM simforge.sim_verification_events WHERE ${expiredEvents} RETURNING id`, params,
    );
    if (doomed.length === 0) return { requests: requests.length, events: events.length, timelines: [] as Array<{ bucket: string; key: string }> };
    const pairs = `SELECT x->>'w', x->>'s' FROM jsonb_array_elements(CAST(:doomed AS jsonb)) x`;
    // Everything that could still name a doomed result: its remaining requests and timelines.
    await tx.execute(`DELETE FROM simforge.sim_requests WHERE (workspace_id, sim_key) IN (${pairs})`, { doomed: doomedJson });
    const timelines = await tx.queryRows<{ storage_bucket: string; storage_key: string }>(
      `DELETE FROM simforge.sim_timelines WHERE (workspace_id, source_sim_key) IN (${pairs}) RETURNING storage_bucket, storage_key`,
      { doomed: doomedJson },
    );
    // Verification events and memoized diffs cascade with the result.
    const deleted = await tx.queryRows<{ sim_key: string }>(
      `DELETE FROM simforge.sim_results r WHERE (r.workspace_id, r.sim_key) IN (${pairs})
         AND r.created_at < NOW() - (:cache_days * INTERVAL '1 day') AND NOT (${LIVE_RESULT})
       RETURNING r.sim_key`,
      { doomed: doomedJson, cache_days: policy.draftCacheDays, request_days: policy.requestDays },
    );
    if (deleted.length !== doomed.length) {
      // Something became reachable between planning and deleting: roll back and let the next run replan.
      throw new Error(`simulation_retention_race: ${doomed.length - deleted.length} result(s) became reachable during the run`);
    }
    return {
      requests: requests.length,
      events: events.length,
      timelines: timelines.map((row) => ({ bucket: row.storage_bucket, key: row.storage_key })),
    };
  });
  const objects = await orphanedObjects(doomed, outcome.timelines);
  const byBucket = new Map<string, string[]>();
  for (const object of objects) byBucket.set(object.bucket, [...(byBucket.get(object.bucket) ?? []), object.key]);
  for (const [bucket, keys] of byBucket) await deleteS3Keys(keys, bucket);
  return {
    apply: true,
    policy,
    requests: outcome.requests,
    verificationEvents: outcome.events,
    results: doomed.map((row) => ({ workspaceId: row.workspace_id, simKey: row.sim_key, createdAt: row.created_at })),
    timelines: outcome.timelines.length,
    objects,
  };
}
