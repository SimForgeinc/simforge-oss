import "server-only";

import {
  buildSimulationDualPlayback,
  describeSimulationMotionDiff,
  diffSimulationTraces,
  SIMULATION_MOTION_DIFF_FORMAT,
  type SimulationMotionDiff,
} from "@simforge-oss/openscenario/trace-diff";
import type { SimTrace } from "@simforge-oss/engine";
import { parseTrace } from "@simforge-oss/engine/node";
import type { SimulationComparisonDto, SimulationMotionDiffDto } from "@simforge-oss/studio-host";

import { queryOne, queryRows } from "@/app/lib/db/data-api";
import { parseJsonObject } from "@/app/lib/db/json-helpers";
import { getS3ObjectBytes } from "@/app/lib/s3/s3-get-object";

import { sha256 } from "./core";
import { readSimulationRecord, SimulationFailedError } from "./sim-result-store";

/**
 * Comparisons between two authoritative simulations of one scenario
 * (`simforge.simulation-diff/v1`): the diff a revision's history row stores, the engine-change
 * banner and the Compare view. Memoized in `sim_motion_diffs`.
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

export function parseDiff(value: unknown): SimulationMotionDiffDto | null {
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
