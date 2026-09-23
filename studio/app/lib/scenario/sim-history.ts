import "server-only";

import { engineSemantics } from "@simforge-oss/compiler/node";
import { readScenarioDocument } from "@simforge-oss/scenario";
import {
  type RevisionSimulationReason,
  type ScenarioEngineChangeDto,
  type ScenarioMapDescriptorDto,
  type ScenarioMapPinStatusDto,
  type ScenarioMapRepinPreviewDto,
  type ScenarioMapTransitionPlanDto,
  type ScenarioDocumentDto,
  type ScenarioSimulationStatusDto,
  type ScenarioVersionActorDto,
  type ScenarioVersionCreatedFor,
  type ScenarioVersionDto,
  type ScenarioVersionsDto,
  type SimulationMotionDiffDto,
} from "@simforge-oss/studio-host";

import type { AppContext } from "@/app/lib/db/app-context";
import { queryOne, queryRows } from "@/app/lib/db/data-api";
import { parseJsonObject } from "@/app/lib/db/json-helpers";

import { parseDiff, SimulationHistoryError, simulationMotionDiff } from "./sim-diff";
import {
  createScenarioRevision,
  getScenarioDocument,
  readPinnedScenarioMapDescriptor,
  updateScenarioDocument,
} from "./document-store";
import { canonicalContentSha256 } from "./core";
import { planMapTransition } from "./map-transition";
import {
  linkRevisionSimulation,
  readSimulationRecord,
  resimulateRevision,
  resolveSimulation,
  setRevisionActiveSimulation,
} from "./sim-result-store";

export { compareSimulations, SimulationHistoryError, simulationMotionDiff } from "./sim-diff";

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

// ── Revision history ──────────────────────────────────────────────────────────────────

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
 * host's engine (`resimulateRevision`). The result joins the history with its diff against the
 * active result; the active pointer does not move ("Use this simulation" is separate).
 */
export async function resimulateVersion(
  context: AppContext,
  documentId: string,
  revisionId: string,
  options: { waitMs?: number } = {},
): Promise<{ status: ScenarioSimulationStatusDto; motionDiff: SimulationMotionDiffDto | null }> {
  await requireDocumentRevision(context, documentId, revisionId);
  const result = await resimulateRevision(context, revisionId, options);
  if (!result) throw new SimulationHistoryError("revision_not_found", `version ${revisionId} does not exist`, 404);
  const status = result.status;
  if (status.state !== "succeeded") return { status, motionDiff: null };
  const row = await queryOne<{ motion_diff: unknown; previous_sim_key: string | null }>(
    `SELECT motion_diff, previous_sim_key FROM simforge.revision_simulations
      WHERE workspace_id = :workspace_id AND revision_id = :revision_id AND sim_key = :sim_key`,
    { workspace_id: context.workspaceId, revision_id: revisionId, sim_key: status.result.simKey },
  );
  const active = await readActiveSimKey(context.workspaceId, revisionId);
  const stored = row ? parseDiff(row.motion_diff) : null;
  const motionDiff = stored
    ?? (active && active !== status.result.simKey ? await simulationMotionDiff(context.workspaceId, active, status.result.simKey) : null);
  return { status, motionDiff };
}

/** "Use this simulation": move the revision's active pointer (rollback or roll forward). */
export async function selectVersionSimulation(
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
    // Restored into the draft, which is written at the current version only.
    content: readScenarioDocument(parseJsonObject(revision.canonical_content as string | Record<string, unknown>)),
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

// ── Save version / keep the old motion / restore ──────────────────────────────────────────

/** "Save version": the draft simulated under the current engine, frozen as a (named) version. */
export async function saveDraftVersion(
  context: AppContext,
  documentId: string,
  input: { expectedVersion: number; label?: string | null },
) {
  return createScenarioRevision(context, documentId, {
    expectedVersion: input.expectedVersion,
    idempotencyKey: `save-version:${documentId}:${input.expectedVersion}`,
    createdFor: "save",
    label: input.label ?? null,
  });
}

/**
 * "Keep the old motion as a version": the draft's content frozen into a version bound to the
 * result it showed before the engine changed (replayed as stored, never re-simulated). The current
 * engine's result joins that version's history (with its diff) so it can be used later, and the
 * draft moves on with the current engine.
 */
export async function keepPreviousMotion(
  context: AppContext,
  documentId: string,
  input: { expectedVersion: number; previousSimKey: string; currentSimKey: string },
) {
  if (input.previousSimKey === input.currentSimKey) {
    throw new SimulationHistoryError("simulation_diff_same_key", "the previous and current simulations are the same", 400);
  }
  const current = await readSimulationRecord(context.workspaceId, input.currentSimKey);
  if (!current) throw new SimulationHistoryError("simulation_not_found", `simulation ${input.currentSimKey} does not exist`, 404);
  // For a version that already exists at this draft version, its active result is what the kept
  // motion is compared against in its history.
  const existing = await queryOne<{ id: string; active_sim_key: string | null }>(
    `SELECT rv.id, p.sim_key AS active_sim_key
       FROM simforge.revisions rv
       LEFT JOIN simforge.revision_active_simulation p ON p.workspace_id = rv.workspace_id AND p.revision_id = rv.id
      WHERE rv.workspace_id = :workspace_id AND rv.document_id = :document_id AND rv.source_draft_version = :draft_version`,
    { workspace_id: context.workspaceId, document_id: documentId, draft_version: input.expectedVersion },
  );
  const bindPrevious = existing?.active_sim_key && existing.active_sim_key !== input.previousSimKey
    ? { simKey: existing.active_sim_key, motionDiff: await simulationMotionDiff(context.workspaceId, existing.active_sim_key, input.previousSimKey) }
    : null;
  const result = await createScenarioRevision(context, documentId, {
    expectedVersion: input.expectedVersion,
    idempotencyKey: `keep-motion:${documentId}:${input.expectedVersion}:${input.previousSimKey}`,
    createdFor: "engine_upgrade",
    bindSimKey: input.previousSimKey,
    bindPrevious,
  });
  if (result.kind !== "created") return result;
  // The newer engine's result joins the kept version's history, compared against the kept motion.
  await linkRevisionSimulation(null, {
    workspaceId: context.workspaceId,
    revisionId: result.revision.id,
    simKey: input.currentSimKey,
    engineSemVer: current.engine_sem_ver,
    origin: "lazy",
    reason: "resimulate",
    userId: context.userId,
    previousSimKey: input.previousSimKey,
    motionDiff: await simulationMotionDiff(context.workspaceId, input.previousSimKey, input.currentSimKey),
  });
  await acceptDraftSimulation(context, documentId, { expectedVersion: input.expectedVersion, simKey: input.currentSimKey });
  return result;
}

/**
 * Restore a version onto the draft on the host: its content, and its map pin when it differs (an
 * explicit re-pin). The editor applies same-map restores itself as one undoable edit instead.
 */
export async function restoreVersionToDraft(
  context: AppContext,
  documentId: string,
  revisionId: string,
  input: { expectedVersion: number },
) {
  const revision = await readVersionContent(context, documentId, revisionId);
  return updateScenarioDocument(context, documentId, {
    expectedVersion: input.expectedVersion,
    content: revision.content,
    ...(revision.mapVersionId ? { mapVersionId: revision.mapVersionId } : {}),
  });
}

// ── Map pin: newer publications and the diffed re-pin ──────────────────────────────────────

const GEOMETRY_DIGEST = /^[a-f0-9]{64}$/;

/** Byte-identical OpenDRIVE, or equal published geometry digests (both present and well-formed). */
export function sameRoadGeometry(pair: {
  xodr_sha256: string; pinned_xodr_sha256: string; geometry_sha256: string | null; pinned_geometry_sha256: string | null;
}): boolean {
  if (pair.xodr_sha256 === pair.pinned_xodr_sha256) return true;
  return Boolean(
    pair.geometry_sha256 && pair.pinned_geometry_sha256
      && GEOMETRY_DIGEST.test(pair.geometry_sha256) && pair.geometry_sha256 === pair.pinned_geometry_sha256,
  );
}

export async function draftMapPinStatus(context: AppContext, documentId: string): Promise<(ScenarioMapPinStatusDto & { pinnedDescriptor: ScenarioMapDescriptorDto | null }) | null> {
  const document = await getScenarioDocument(context, documentId);
  if (!document) return null;
  if (!document.mapVersionId) {
    return { pinned: null, newer: null, newerUnavailable: null, pinnedDescriptor: null };
  }
  const pinnedRow = await queryOne<{ id: string; label: string; created_at: string; retired: boolean }>(
    `SELECT id, label, created_at::text AS created_at, retired_at IS NOT NULL AS retired
       FROM simforge.map_versions WHERE id = :map_version_id`,
    { map_version_id: document.mapVersionId },
  );
  const pinnedDescriptor = await readPinnedScenarioMapDescriptor(document.mapVersionId);
  // The newest unretired publication of the same source map with an available closure. Moving is
  // offered when its road geometry is the same: byte-identical OpenDRIVE, or equal
  // `descriptor.xodrGeometrySha256` (OpenDRIVE with only elevation/lateral profiles and lane
  // heights removed, published at import). Otherwise the reason is shown and nothing is offered.
  const newest = await queryOne<{
    id: string; label: string; created_at: string; xodr_sha256: string;
    geometry_sha256: string | null; pinned_xodr_sha256: string; pinned_geometry_sha256: string | null;
  }>(
    `SELECT mv.id, mv.label, mv.created_at::text AS created_at, mv.xodr_sha256,
            mv.descriptor->>'xodrGeometrySha256' AS geometry_sha256,
            pinned.xodr_sha256 AS pinned_xodr_sha256,
            pinned.descriptor->>'xodrGeometrySha256' AS pinned_geometry_sha256
       FROM simforge.map_versions mv
       JOIN simforge.map_versions pinned ON pinned.id = :pinned_id
       JOIN simforge.browser_asset_sets bs ON bs.id = mv.browser_asset_set_id AND bs.map_version_id = mv.id
        AND bs.asset_set_state = 'available'
      WHERE mv.source_map_asset_id = pinned.source_map_asset_id AND mv.retired_at IS NULL
      ORDER BY mv.created_at DESC, mv.id DESC
      LIMIT 1`,
    { pinned_id: document.mapVersionId },
  );
  let newer: ScenarioMapPinStatusDto["newer"] = null;
  let newerUnavailable: ScenarioMapPinStatusDto["newerUnavailable"] = null;
  if (newest && newest.id !== document.mapVersionId) {
    if (sameRoadGeometry(newest)) {
      newer = { mapVersionId: newest.id, name: newest.label, publishedAt: newest.created_at };
    } else {
      newerUnavailable = {
        code: "scenario_map_geometry_drift",
        message: `A newer version of this map (${newest.label}) changes its road geometry, so the scenario's anchors cannot move to it as they are. It stays on its pinned version.`,
      };
    }
  }
  return {
    pinned: pinnedRow
      ? { mapVersionId: pinnedRow.id, name: pinnedRow.label, publishedAt: pinnedRow.created_at, retired: Boolean(pinnedRow.retired) }
      : null,
    newer,
    newerUnavailable,
    pinnedDescriptor,
  };
}

/**
 * The transition view's data: the server's plan for moving the draft to `targetMapVersionId`
 * (`planMapTransition`: same road geometry keeps every placement; changed geometry places each
 * actor by world position and flags what it could not), the planned content simulated on the
 * target, and that motion compared with what the draft shows now. Nothing changes on the draft.
 */
export async function previewMapRepin(
  context: AppContext,
  documentId: string,
  input: { targetMapVersionId: string; waitMs?: number },
): Promise<ScenarioMapRepinPreviewDto | null> {
  const document = await getScenarioDocument(context, documentId);
  if (!document) return null;
  const plan = await planMapTransition(context, document, input.targetMapVersionId);
  if (!plan.content || plan.blocking) {
    return { target: plan.target, plan, status: null, motionDiff: null };
  }
  const status = await resolveSimulation({
    workspaceId: context.workspaceId,
    userId: context.userId,
    canonicalContent: plan.content,
    contentSha256: canonicalContentSha256(plan.content),
    mapVersionId: plan.target.mapVersionId,
  }, { waitMs: input.waitMs ?? 0 });
  const draft = await readDraftSim(context.workspaceId, documentId);
  const base = draft?.last_sim_key ?? null;
  const motionDiff = status.state === "succeeded" && base && base !== status.result.simKey
    ? await simulationMotionDiff(context.workspaceId, base, status.result.simKey)
    : null;
  return { target: plan.target, plan, status, motionDiff };
}

/**
 * "Move to new map version". The move is planned again here (the client's view is only a preview),
 * then the BEFORE is saved as a version with its map pin and simulation (`map_move`; a version
 * already cut from this exact draft counts), and only then does the draft move to the planned
 * content on the new version. If the before cannot be saved, nothing moves.
 */
export async function moveDraftToMapVersion(
  context: AppContext,
  documentId: string,
  input: { expectedVersion: number; targetMapVersionId: string },
): Promise<
  | { kind: "moved"; document: ScenarioDocumentDto; before: { revisionId: string; revisionNumber: number }; plan: ScenarioMapTransitionPlanDto }
  | { kind: "blocked"; plan: ScenarioMapTransitionPlanDto }
  | { kind: "not_found" }
  | { kind: "conflict"; current: ScenarioDocumentDto }
  | Exclude<Awaited<ReturnType<typeof createScenarioRevision>>, { kind: "created" } | { kind: "not_found" } | { kind: "conflict" }>
> {
  const document = await getScenarioDocument(context, documentId);
  if (!document) return { kind: "not_found" };
  if (document.draftVersion !== input.expectedVersion) return { kind: "conflict", current: document };
  const plan = await planMapTransition(context, document, input.targetMapVersionId);
  if (!plan.content || plan.blocking) return { kind: "blocked", plan };
  const before = await createScenarioRevision(context, documentId, {
    expectedVersion: input.expectedVersion,
    idempotencyKey: `map-move:${documentId}:${input.expectedVersion}:${input.targetMapVersionId}`,
    createdFor: "map_move",
    label: `Before moving to ${plan.target.name} · ${plan.target.publishedAt.slice(0, 10)}`,
  });
  if (before.kind === "not_found") return { kind: "not_found" };
  if (before.kind === "conflict") return { kind: "conflict", current: before.current };
  if (before.kind !== "created") return before;
  const moved = await updateScenarioDocument(context, documentId, {
    expectedVersion: input.expectedVersion,
    content: plan.content,
    mapVersionId: plan.target.mapVersionId,
  });
  if (moved.kind === "not_found") return { kind: "not_found" };
  if (moved.kind === "conflict") return { kind: "conflict", current: moved.current };
  return {
    kind: "moved",
    document: moved.document,
    before: { revisionId: before.revision.id, revisionNumber: before.revision.revisionNumber },
    plan,
  };
}
