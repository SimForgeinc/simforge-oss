import "server-only";

import {
  buildSimulationDualPlayback,
  describeSimulationMotionDiff,
  diffSimulationTraces,
  SIMULATION_MOTION_DIFF_FORMAT,
  type SimulationMotionDiff,
} from "@simforge-oss/openscenario/trace-diff";
import { engineSemantics } from "@simforge-oss/compiler/node";
import type { SimTrace } from "@simforge-oss/engine";
import { parseTrace } from "@simforge-oss/engine/node";
import type {
  RevisionSimulationReason,
  ScenarioEngineChangeDto,
  ScenarioSimulationStatusDto,
  ScenarioVersionActorDto,
  ScenarioVersionCreatedFor,
  ScenarioVersionDto,
  ScenarioVersionsDto,
  SimulationComparisonDto,
  SimulationMotionDiffDto,
} from "@simforge-oss/studio-host";

import type { AppContext } from "@/app/lib/db/app-context";
import { queryOne, queryRows, withTransaction, type Transaction } from "@/app/lib/db/data-api";
import { parseJsonObject } from "@/app/lib/db/json-helpers";
import { getS3ObjectBytes } from "@/app/lib/s3/s3-get-object";

import { sha256 } from "./core";
import { readSimulationRecord, resolveSimulation, SimulationFailedError } from "./sim-result-store";

/**
 * Simulation history of a scenario (docs/engineering/simulation-history.md).
 *
 * - A revision (a user's "Version N") keeps every simulation it ever had in the append-only
 *   `revision_simulations`; `revision_active_simulation` names the one its renders replay. Nothing
 *   moves that pointer but an explicit user action: an engine upgrade never does.
 * - A draft is a cache: `drafts.last_sim_key` is the authoritative result the author last saw, which
 *   is what "Keep the old motion" freezes into a version when the engine changes under an unchanged
 *   draft.
 * - Rollback is replay: an older result is used as it was stored; nothing is simulated with an old
 *   engine.
 */

export class SimulationHistoryError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 404 | 409 | 422 = 409) {
    super(message);
    this.name = "SimulationHistoryError";
  }
}

// ── Traces and motion diffs ───────────────────────────────────────────────────────────────

/**
 * An authoritative trace by key, verified against its recorded digest and read through the native
 * reader, which upgrades any released trace format in memory (stored bytes are never rewritten).
 */
export async function readSimulationTrace(workspaceId: string, simKey: string): Promise<SimTrace> {
  const record = await readSimulationRecord(workspaceId, simKey);
  if (!record) throw new SimulationHistoryError("simulation_not_found", `simulation ${simKey} does not exist in this workspace`, 404);
  const bytes = await getS3ObjectBytes(record.storage_bucket, record.trace_storage_key);
  if (bytes.byteLength !== Number(record.trace_byte_length) || sha256(bytes) !== record.trace_gzip_sha256) {
    throw new SimulationFailedError("simulation_trace_corrupt", `stored trace for ${simKey} does not match its recorded digest`);
  }
  return parseTrace(bytes).toTrace();
}

function diffDto(diff: SimulationMotionDiff, baseSimKey: string, candidateSimKey: string): SimulationMotionDiffDto {
  return {
    format: SIMULATION_MOTION_DIFF_FORMAT,
    baseSimKey,
    candidateSimKey,
    identical: diff.identical,
    summary: describeSimulationMotionDiff(diff),
    maxPositionErrorM: diff.maxPositionErrorM,
    maxHeadingErrorDeg: diff.maxHeadingErrorDeg,
    worst: diff.worst,
    actors: {
      compared: diff.actors.compared,
      changedCount: diff.actors.changedCount,
      changed: [...diff.actors.changed],
      added: [...diff.actors.added],
      removed: [...diff.actors.removed],
    },
    eventsChanged: diff.eventsChanged,
    collisionsChanged: diff.collisionsChanged,
    signalsChanged: diff.signalsChanged,
    durationS: diff.durationS,
    strict: diff.strict,
  };
}

function identicalDiff(baseSimKey: string, candidateSimKey: string, durationS: number): SimulationMotionDiffDto {
  return {
    format: SIMULATION_MOTION_DIFF_FORMAT,
    baseSimKey,
    candidateSimKey,
    identical: true,
    summary: "Motion identical",
    maxPositionErrorM: 0,
    maxHeadingErrorDeg: 0,
    worst: null,
    actors: { compared: 0, changedCount: 0, changed: [], added: [], removed: [] },
    eventsChanged: 0,
    collisionsChanged: 0,
    signalsChanged: 0,
    durationS: { base: durationS, candidate: durationS },
    strict: { profile: "strict-trajectory-v1", verdict: "pass", reportHash: null, errorFindings: 0, reason: "the two results store the same trace" },
  };
}

function parseDiff(value: unknown): SimulationMotionDiffDto | null {
  const parsed = parseJsonObject(value as string | Record<string, unknown> | null);
  return parsed && parsed.format === SIMULATION_MOTION_DIFF_FORMAT ? parsed as unknown as SimulationMotionDiffDto : null;
}

/**
 * The motion change from `baseSimKey` to `candidateSimKey`, memoized in `sim_motion_diffs`. Two
 * results that store the same trace digest are identical without reading either trace.
 */
export async function simulationMotionDiff(workspaceId: string, baseSimKey: string, candidateSimKey: string): Promise<SimulationMotionDiffDto> {
  if (baseSimKey === candidateSimKey) throw new SimulationHistoryError("simulation_diff_same_key", "a simulation cannot be compared with itself", 400);
  const memo = await queryOne<{ diff: unknown }>(
    `SELECT diff FROM simforge.sim_motion_diffs
      WHERE workspace_id = :workspace_id AND base_sim_key = :base AND candidate_sim_key = :candidate AND profile = :profile`,
    { workspace_id: workspaceId, base: baseSimKey, candidate: candidateSimKey, profile: SIMULATION_MOTION_DIFF_FORMAT },
  );
  const cached = memo ? parseDiff(memo.diff) : null;
  if (cached) return cached;
  const [base, candidate] = await Promise.all([
    readSimulationRecord(workspaceId, baseSimKey),
    readSimulationRecord(workspaceId, candidateSimKey),
  ]);
  if (!base || !candidate) {
    throw new SimulationHistoryError("simulation_not_found", `simulation ${!base ? baseSimKey : candidateSimKey} does not exist in this workspace`, 404);
  }
  let dto: SimulationMotionDiffDto;
  if (base.trace_sha256 === candidate.trace_sha256) {
    const trace = await readSimulationTrace(workspaceId, baseSimKey);
    dto = identicalDiff(baseSimKey, candidateSimKey, trace.header.clipSeconds);
  } else {
    const [a, b] = await Promise.all([readSimulationTrace(workspaceId, baseSimKey), readSimulationTrace(workspaceId, candidateSimKey)]);
    dto = diffDto(diffSimulationTraces(a, b), baseSimKey, candidateSimKey);
  }
  await queryRows(
    `INSERT INTO simforge.sim_motion_diffs (workspace_id, base_sim_key, candidate_sim_key, profile, diff)
     VALUES (:workspace_id, :base, :candidate, :profile, CAST(:diff AS jsonb))
     ON CONFLICT DO NOTHING RETURNING base_sim_key`,
    { workspace_id: workspaceId, base: baseSimKey, candidate: candidateSimKey, profile: SIMULATION_MOTION_DIFF_FORMAT, diff: dto },
  );
  return dto;
}

/** Both simulations side by side for the Compare view. */
export async function compareSimulations(workspaceId: string, baseSimKey: string, candidateSimKey: string): Promise<SimulationComparisonDto> {
  const [baseRecord, candidateRecord] = await Promise.all([
    readSimulationRecord(workspaceId, baseSimKey),
    readSimulationRecord(workspaceId, candidateSimKey),
  ]);
  if (!baseRecord || !candidateRecord) {
    throw new SimulationHistoryError("simulation_not_found", `simulation ${!baseRecord ? baseSimKey : candidateSimKey} does not exist in this workspace`, 404);
  }
  const [base, candidate] = await Promise.all([readSimulationTrace(workspaceId, baseSimKey), readSimulationTrace(workspaceId, candidateSimKey)]);
  const diff = baseSimKey === candidateSimKey
    ? identicalDiff(baseSimKey, candidateSimKey, base.header.clipSeconds)
    : await simulationMotionDiff(workspaceId, baseSimKey, candidateSimKey);
  const playback = buildSimulationDualPlayback(base, candidate, 10);
  return {
    base: { simKey: baseSimKey, engineSemVer: baseRecord.engine_sem_ver },
    candidate: { simKey: candidateSimKey, engineSemVer: candidateRecord.engine_sem_ver },
    diff,
    playback: {
      sampleHz: playback.sampleHz,
      durationS: playback.durationS,
      frames: playback.frames.map((frame) => ({ t: frame.t, actors: { ...frame.actors } })),
    },
  };
}

// ── Revision history rows and the active pointer ─────────────────────────────────────────

type Executor = Pick<Transaction, "queryOne" | "queryRows" | "execute">;

async function onExecutor<T>(tx: Transaction | null, run: (executor: Executor) => Promise<T>): Promise<T> {
  return tx ? run(tx) : withTransaction(run);
}

/**
 * Append one simulation to a revision's history (idempotent per (revision, sim_key)). `origin` is
 * still written for rc.73 readers during the expand window.
 */
export async function appendRevisionSimulation(
  tx: Transaction | null,
  input: {
    workspaceId: string;
    revisionId: string;
    simKey: string;
    engineSemVer: string;
    reason: RevisionSimulationReason;
    userId: string | null;
    previousSimKey?: string | null;
    motionDiff?: SimulationMotionDiffDto | null;
  },
): Promise<boolean> {
  return onExecutor(tx, async (executor) => {
    const rows = await executor.queryRows<{ sim_key: string }>(
      `INSERT INTO simforge.revision_simulations (
         workspace_id, revision_id, engine_sem_ver, sim_key, origin, reason, created_by_user_id,
         previous_sim_key, motion_diff
       ) VALUES (
         :workspace_id, :revision_id, :engine_sem_ver, :sim_key, :origin, :reason, :user_id,
         :previous_sim_key, CAST(:motion_diff AS jsonb)
       ) ON CONFLICT DO NOTHING
       RETURNING sim_key`,
      {
        workspace_id: input.workspaceId,
        revision_id: input.revisionId,
        engine_sem_ver: input.engineSemVer,
        sim_key: input.simKey,
        origin: input.reason === "commit" ? "commit" : "lazy",
        reason: input.reason,
        user_id: input.userId,
        previous_sim_key: input.previousSimKey && input.previousSimKey !== input.simKey ? input.previousSimKey : null,
        motion_diff: input.previousSimKey && input.previousSimKey !== input.simKey ? input.motionDiff ?? null : null,
      },
    );
    return rows.length > 0;
  });
}

export type ActivePointerReason = "commit" | "backfill-commit" | "backfill-resimulated" | "user";

/**
 * Point a revision's renders at `simKey`, which must already be in its history.
 * TODO(playability-phase1): replace with phase 1's exported `setRevisionActiveSimulation` once
 * feat/playability-phase1 lands it (same signature).
 */
export async function setRevisionActiveSimulation(
  tx: Transaction | null,
  input: { workspaceId: string; revisionId: string; simKey: string; reason: ActivePointerReason; userId: string | null },
): Promise<void> {
  await onExecutor(tx, async (executor) => {
    const inHistory = await executor.queryOne<{ sim_key: string }>(
      `SELECT sim_key FROM simforge.revision_simulations
        WHERE workspace_id = :workspace_id AND revision_id = :revision_id AND sim_key = :sim_key`,
      { workspace_id: input.workspaceId, revision_id: input.revisionId, sim_key: input.simKey },
    );
    if (!inHistory) {
      throw new SimulationHistoryError("simulation_not_in_history", `simulation ${input.simKey} is not in revision ${input.revisionId}'s history`, 409);
    }
    await executor.execute(
      `INSERT INTO simforge.revision_active_simulation (workspace_id, revision_id, sim_key, reason, set_by_user_id, set_at)
       VALUES (:workspace_id, :revision_id, :sim_key, :reason, :user_id, NOW())
       ON CONFLICT (workspace_id, revision_id) DO UPDATE
         SET sim_key = EXCLUDED.sim_key, reason = EXCLUDED.reason,
             set_by_user_id = EXCLUDED.set_by_user_id, set_at = EXCLUDED.set_at`,
      { workspace_id: input.workspaceId, revision_id: input.revisionId, sim_key: input.simKey, reason: input.reason, user_id: input.userId },
    );
  });
}

async function readActiveSimKey(workspaceId: string, revisionId: string): Promise<string | null> {
  const row = await queryOne<{ sim_key: string }>(
    `SELECT sim_key FROM simforge.revision_active_simulation WHERE workspace_id = :workspace_id AND revision_id = :revision_id`,
    { workspace_id: workspaceId, revision_id: revisionId },
  );
  return row?.sim_key ?? null;
}

// ── Draft: the result the author last saw, and the engine-change banner ─────────────────

type DraftSimRow = {
  draft_version: number | string;
  last_sim_key: string | null;
  last_sim_draft_version: number | string | null;
  last_engine_sem_ver: string | null;
};

async function readDraftSim(workspaceId: string, documentId: string): Promise<DraftSimRow | null> {
  return queryOne<DraftSimRow>(
    `SELECT dr.draft_version, dr.last_sim_key, dr.last_sim_draft_version, r.engine_sem_ver AS last_engine_sem_ver
       FROM simforge.drafts dr
       JOIN simforge.documents d ON d.id = dr.document_id AND d.workspace_id = dr.workspace_id AND d.deleted_at IS NULL
       LEFT JOIN simforge.sim_results r ON r.workspace_id = dr.workspace_id AND r.sim_key = dr.last_sim_key
      WHERE dr.workspace_id = :workspace_id AND dr.document_id = :document_id`,
    { workspace_id: workspaceId, document_id: documentId },
  );
}

async function writeDraftLastSim(workspaceId: string, documentId: string, draftVersion: number, simKey: string): Promise<void> {
  // Only for the draft version the result was computed for: a newer save owns the next result.
  await queryRows(
    `UPDATE simforge.drafts
        SET last_sim_key = :sim_key, last_sim_draft_version = :draft_version, last_sim_at = NOW()
      WHERE workspace_id = :workspace_id AND document_id = :document_id AND draft_version = :draft_version
      RETURNING document_id`,
    { workspace_id: workspaceId, document_id: documentId, draft_version: draftVersion, sim_key: simKey },
  );
}

/**
 * Record that the draft at `draftVersion` now shows `status`'s result. When the draft did not
 * change but its result did (an engine or pipeline change) and the motion differs, the previous
 * result stays recorded and the change is returned for the banner: the author decides whether to
 * keep the old motion as a version or accept the new one. Identical motion advances silently.
 */
export async function recordDraftSimulation(
  context: AppContext,
  documentId: string,
  draftVersion: number,
  status: ScenarioSimulationStatusDto,
): Promise<ScenarioEngineChangeDto | null> {
  if (status.state !== "succeeded") return null;
  const current = status.result;
  const draft = await readDraftSim(context.workspaceId, documentId);
  if (!draft || Number(draft.draft_version) !== draftVersion) return null;
  const previousKey = draft.last_sim_key;
  if (previousKey === current.simKey) return null;
  const sameDraft = previousKey !== null && Number(draft.last_sim_draft_version) === draftVersion;
  if (!sameDraft || !previousKey) {
    await writeDraftLastSim(context.workspaceId, documentId, draftVersion, current.simKey);
    return null;
  }
  const motionDiff = await simulationMotionDiff(context.workspaceId, previousKey, current.simKey);
  if (motionDiff.identical) {
    await writeDraftLastSim(context.workspaceId, documentId, draftVersion, current.simKey);
    return null;
  }
  return {
    previous: { simKey: previousKey, engineSemVer: draft.last_engine_sem_ver ?? "unknown" },
    current: { simKey: current.simKey, engineSemVer: current.engineSemVer },
    motionDiff,
  };
}

/** "Use the new motion": the draft now shows the current engine's result. */
export async function acceptDraftSimulation(
  context: AppContext,
  documentId: string,
  input: { expectedVersion: number; simKey: string },
): Promise<void> {
  const draft = await readDraftSim(context.workspaceId, documentId);
  if (!draft) throw new SimulationHistoryError("document_not_found", "document not found", 404);
  if (Number(draft.draft_version) !== input.expectedVersion) {
    throw new SimulationHistoryError("draft_version_conflict", "the draft changed; reload it", 409);
  }
  const result = await readSimulationRecord(context.workspaceId, input.simKey);
  if (!result) throw new SimulationHistoryError("simulation_not_found", `simulation ${input.simKey} does not exist`, 404);
  await writeDraftLastSim(context.workspaceId, documentId, input.expectedVersion, input.simKey);
}

// ── Versions panel ────────────────────────────────────────────────────────────────────────

type VersionRow = {
  id: string;
  revision_number: number | string;
  label: string | null;
  created_for: ScenarioVersionCreatedFor;
  created_at: string;
  created_by_user_id: string | null;
  created_by_name: string | null;
  source_draft_version: number | string;
  content_sha256: string;
  map_version_id: string | null;
  map_label: string | null;
  map_created_at: string | null;
  active_sim_key: string | null;
  active_set_at: string | null;
  active_set_by: string | null;
  active_set_by_name: string | null;
};

type HistoryRow = {
  revision_id: string;
  sim_key: string;
  engine_sem_ver: string;
  reason: RevisionSimulationReason;
  created_at: string;
  created_by_user_id: string | null;
  created_by_name: string | null;
  previous_sim_key: string | null;
  motion_diff: unknown;
  trace_sha256: string;
  timeline_sha256: string | null;
  map_closure_digest: string;
  resolved_input_digest: string;
  engine_build: unknown;
  producer: string;
};

const actor = (id: string | null, name: string | null): ScenarioVersionActorDto => (id ? { id, name } : null);

export async function listDocumentVersions(context: AppContext, documentId: string): Promise<ScenarioVersionsDto | null> {
  const draft = await queryOne<{
    draft_version: number | string; content_sha256: string; map_version_id: string | null;
    last_sim_key: string | null; last_sim_draft_version: number | string | null; last_engine_sem_ver: string | null;
  }>(
    `SELECT dr.draft_version, dr.content_sha256, dr.map_version_id, dr.last_sim_key, dr.last_sim_draft_version,
            r.engine_sem_ver AS last_engine_sem_ver
       FROM simforge.drafts dr
       JOIN simforge.documents d ON d.id = dr.document_id AND d.workspace_id = dr.workspace_id AND d.deleted_at IS NULL
       LEFT JOIN simforge.sim_results r ON r.workspace_id = dr.workspace_id AND r.sim_key = dr.last_sim_key
      WHERE dr.workspace_id = :workspace_id AND dr.document_id = :document_id`,
    { workspace_id: context.workspaceId, document_id: documentId },
  );
  if (!draft) return null;
  const versions = await queryRows<VersionRow>(
    `SELECT rv.id, rv.revision_number, rv.label, rv.created_for, rv.created_at::text AS created_at,
            rv.created_by_user_id, u.name AS created_by_name, rv.source_draft_version, rv.content_sha256,
            rv.map_version_id, mv.label AS map_label, mv.created_at::text AS map_created_at,
            p.sim_key AS active_sim_key, p.set_at::text AS active_set_at, p.set_by_user_id AS active_set_by,
            pu.name AS active_set_by_name
       FROM simforge.revisions rv
       LEFT JOIN public.ba_user u ON u.id = rv.created_by_user_id
       LEFT JOIN simforge.map_versions mv ON mv.id = rv.map_version_id
       LEFT JOIN simforge.revision_active_simulation p ON p.workspace_id = rv.workspace_id AND p.revision_id = rv.id
       LEFT JOIN public.ba_user pu ON pu.id = p.set_by_user_id
      WHERE rv.workspace_id = :workspace_id AND rv.document_id = :document_id
      ORDER BY rv.revision_number DESC
      LIMIT 200`,
    { workspace_id: context.workspaceId, document_id: documentId },
  );
  const history = versions.length === 0 ? [] : await queryRows<HistoryRow>(
    `SELECT rs.revision_id, rs.sim_key, rs.engine_sem_ver, rs.reason, rs.created_at::text AS created_at,
            rs.created_by_user_id, u.name AS created_by_name, rs.previous_sim_key, rs.motion_diff,
            r.trace_sha256, r.timeline_sha256, r.map_closure_digest, r.resolved_input_digest, r.engine_build, r.producer
       FROM simforge.revision_simulations rs
       JOIN simforge.revisions rv ON rv.id = rs.revision_id AND rv.workspace_id = rs.workspace_id
       JOIN simforge.sim_results r ON r.workspace_id = rs.workspace_id AND r.sim_key = rs.sim_key
       LEFT JOIN public.ba_user u ON u.id = rs.created_by_user_id
      WHERE rs.workspace_id = :workspace_id AND rv.document_id = :document_id
      ORDER BY rs.created_at DESC, rs.sim_key`,
    { workspace_id: context.workspaceId, document_id: documentId },
  );
  const byRevision = new Map<string, HistoryRow[]>();
  for (const row of history) byRevision.set(row.revision_id, [...(byRevision.get(row.revision_id) ?? []), row]);
  return {
    documentId,
    draftVersion: Number(draft.draft_version),
    currentEngineSemVer: engineSemantics().engineSemVer,
    draft: {
      lastSimKey: draft.last_sim_key,
      lastSimEngineSemVer: draft.last_engine_sem_ver,
      lastSimDraftVersion: draft.last_sim_draft_version === null ? null : Number(draft.last_sim_draft_version),
    },
    versions: versions.map((row): ScenarioVersionDto => ({
      revisionId: row.id,
      revisionNumber: Number(row.revision_number),
      label: row.label,
      createdFor: row.created_for,
      createdAt: row.created_at,
      createdBy: actor(row.created_by_user_id, row.created_by_name),
      sourceDraftVersion: Number(row.source_draft_version),
      contentSha256: row.content_sha256,
      map: row.map_version_id
        ? { mapVersionId: row.map_version_id, name: row.map_label ?? row.map_version_id, publishedAt: row.map_created_at ?? "" }
        : null,
      active: row.active_sim_key
        ? { simKey: row.active_sim_key, setAt: row.active_set_at ?? "", setBy: actor(row.active_set_by, row.active_set_by_name) }
        : null,
      simulations: (byRevision.get(row.id) ?? []).map((sim) => ({
        simKey: sim.sim_key,
        engineSemVer: sim.engine_sem_ver,
        reason: sim.reason,
        createdAt: sim.created_at,
        createdBy: actor(sim.created_by_user_id, sim.created_by_name),
        active: sim.sim_key === row.active_sim_key,
        previousSimKey: sim.previous_sim_key,
        motionDiff: parseDiff(sim.motion_diff),
        details: {
          traceSha256: sim.trace_sha256,
          timelineSha256: sim.timeline_sha256,
          mapClosureDigest: sim.map_closure_digest,
          resolvedInputDigest: sim.resolved_input_digest,
          engineBuild: parseJsonObject(sim.engine_build as string | Record<string, unknown> | null) ?? {},
          producer: sim.producer,
        },
      })),
      matchesDraft: row.content_sha256 === draft.content_sha256 && row.map_version_id === draft.map_version_id,
    })),
  };
}

async function requireDocumentRevision(context: AppContext, documentId: string, revisionId: string) {
  const row = await queryOne<{ id: string; canonical_content: unknown; content_sha256: string; map_version_id: string | null }>(
    `SELECT rv.id, rv.canonical_content, rv.content_sha256, rv.map_version_id
       FROM simforge.revisions rv
       JOIN simforge.documents d ON d.id = rv.document_id AND d.workspace_id = rv.workspace_id AND d.deleted_at IS NULL
      WHERE rv.workspace_id = :workspace_id AND rv.document_id = :document_id AND rv.id = :revision_id`,
    { workspace_id: context.workspaceId, document_id: documentId, revision_id: revisionId },
  );
  if (!row) throw new SimulationHistoryError("revision_not_found", `version ${revisionId} does not belong to this scenario`, 404);
  return row;
}

/**
 * "Re-simulate with the current engine": the revision's content on its pinned map under this
 * host's engine. The result joins the history with its diff against the active result; the active
 * pointer does not move ("Use this simulation" is separate).
 */
export async function resimulateVersion(
  context: AppContext,
  documentId: string,
  revisionId: string,
  options: { waitMs?: number } = {},
): Promise<{ status: ScenarioSimulationStatusDto; appended: boolean; motionDiff: SimulationMotionDiffDto | null }> {
  const revision = await requireDocumentRevision(context, documentId, revisionId);
  if (!revision.map_version_id) {
    throw new SimulationHistoryError("scenario_map_absent", "this version is not pinned to a map version and cannot be simulated", 422);
  }
  const status = await resolveSimulation({
    workspaceId: context.workspaceId,
    userId: context.userId,
    canonicalContent: parseJsonObject(revision.canonical_content as string | Record<string, unknown>),
    contentSha256: revision.content_sha256,
    mapVersionId: revision.map_version_id,
  }, { waitMs: options.waitMs ?? 0 });
  if (status.state !== "succeeded") return { status, appended: false, motionDiff: null };
  const active = await readActiveSimKey(context.workspaceId, revisionId);
  const motionDiff = active && active !== status.result.simKey
    ? await simulationMotionDiff(context.workspaceId, active, status.result.simKey)
    : null;
  const appended = await appendRevisionSimulation(null, {
    workspaceId: context.workspaceId,
    revisionId,
    simKey: status.result.simKey,
    engineSemVer: status.result.engineSemVer,
    reason: "resimulate",
    userId: context.userId,
    previousSimKey: active,
    motionDiff,
  });
  return { status, appended, motionDiff };
}

/** "Use this simulation": move the revision's active pointer (rollback or roll forward). */
export async function useVersionSimulation(
  context: AppContext,
  documentId: string,
  revisionId: string,
  simKey: string,
): Promise<void> {
  await requireDocumentRevision(context, documentId, revisionId);
  await setRevisionActiveSimulation(null, { workspaceId: context.workspaceId, revisionId, simKey, reason: "user", userId: context.userId });
}

/** A version's content, for "Restore this version to the draft" (applied by the editor as one undoable edit). */
export async function readVersionContent(context: AppContext, documentId: string, revisionId: string) {
  const revision = await requireDocumentRevision(context, documentId, revisionId);
  return {
    revisionId: revision.id,
    contentSha256: revision.content_sha256,
    mapVersionId: revision.map_version_id,
    content: parseJsonObject(revision.canonical_content as string | Record<string, unknown>),
  };
}

/** Backfilled history rows have no diff yet: compute it once and fill it (the one allowed update). */
export async function fillMissingMotionDiffs(context: AppContext, documentId: string, limit = 20): Promise<number> {
  const rows = await queryRows<{ revision_id: string; sim_key: string; previous_sim_key: string }>(
    `SELECT rs.revision_id, rs.sim_key, rs.previous_sim_key
       FROM simforge.revision_simulations rs
       JOIN simforge.revisions rv ON rv.id = rs.revision_id AND rv.workspace_id = rs.workspace_id
      WHERE rs.workspace_id = :workspace_id AND rv.document_id = :document_id
        AND rs.previous_sim_key IS NOT NULL AND rs.motion_diff IS NULL
      LIMIT ${Math.max(1, Math.min(100, limit))}`,
    { workspace_id: context.workspaceId, document_id: documentId },
  );
  let filled = 0;
  for (const row of rows) {
    const diff = await simulationMotionDiff(context.workspaceId, row.previous_sim_key, row.sim_key);
    const updated = await queryRows(
      `UPDATE simforge.revision_simulations SET motion_diff = CAST(:diff AS jsonb)
        WHERE workspace_id = :workspace_id AND revision_id = :revision_id AND sim_key = :sim_key AND motion_diff IS NULL
        RETURNING sim_key`,
      { workspace_id: context.workspaceId, revision_id: row.revision_id, sim_key: row.sim_key, diff },
    );
    filled += updated.length;
  }
  return filled;
}
