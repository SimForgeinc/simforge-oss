import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { AppContext } from "../db/app-context";
import { comparability, rankMetric } from "./model-comparison";
import { listModelVersions } from "../models/model-registry-store";
import {
  EvalCampaignSpecSchema,
  EvalEventsSchema,
  EvalLedgerLineSchema,
  EvalProvenanceSchema,
  EvalScoreSchema,
  EvalTraceLineSchema,
  type EvalCampaignSummary,
  type EvalComparabilityVerdict,
  type EvalComparisonCell,
  type EvalEpisodeComparison,
  type EvalEpisodePayload,
  type EvalEvent,
  type EvalLedgerLine,
  type EvalPolicyDetail,
  type EvalPolicySummary,
  type EvalProvenance,
  type EvalRunComparison,
  type EvalScore,
  type EvalViewTick,
} from "./contracts";

/**
 * Filesystem reader for eval campaign artifacts (layout in ./contracts.ts).
 * Read-tolerant throughout: malformed lines are skipped, missing optional
 * artifacts degrade to `null`/empty instead of failing the page.
 */

/** Same resolution as worker/model-run.ts so runner and studio agree. */
export function runsRoot(): string {
  return process.env.SIMFORGE_RUNS_ROOT?.trim() || join(homedir(), "simforge-assets", "runs");
}

/** Ids double as directory names; reject anything path-like. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isSafeArtifactId(id: string): boolean {
  return SAFE_ID.test(id) && !id.includes("..");
}

async function readJsonFile(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

async function readLedgerLines(campaignId: string): Promise<EvalLedgerLine[]> {
  let text: string;
  try {
    text = await readFile(join(runsRoot(), campaignId, "ledger.jsonl"), "utf8");
  } catch {
    return [];
  }
  const lines: EvalLedgerLine[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const parsed = EvalLedgerLineSchema.safeParse(raw);
    if (parsed.success) lines.push(parsed.data);
  }
  return lines;
}

function summarizePolicies(
  lines: EvalLedgerLine[],
  versionIdByDigest: Record<string, string>,
  digestByPolicyId: Record<string, string>,
): EvalPolicySummary[] {
  const byPolicy = new Map<string, EvalLedgerLine[]>();
  for (const line of lines) {
    const bucket = byPolicy.get(line.policyId);
    if (bucket) bucket.push(line);
    else byPolicy.set(line.policyId, [line]);
  }
  const policies: EvalPolicySummary[] = [];
  for (const [policyId, episodes] of byPolicy) {
    const digest = digestByPolicyId[policyId];
    policies.push({
      policyId,
      episodes: episodes.length,
      meanScore: episodes.reduce((sum, e) => sum + e.drivingScore, 0) / episodes.length,
      meanRouteCompletion:
        episodes.reduce((sum, e) => sum + e.routeCompletion, 0) / episodes.length,
      infractionEpisodes: episodes.filter((e) => e.drivingScore < 1).length,
      lastCompletedAt:
        episodes.map((e) => e.completedAt).sort((a, b) => b.localeCompare(a))[0] ?? null,
      modelVersionId: digest ? (versionIdByDigest[digest] ?? null) : null,
    });
  }
  policies.sort((a, b) => a.policyId.localeCompare(b.policyId));
  return policies;
}

/**
 * checkpointDigest is the join key between eval provenance and the simforge.*
 * model registry: read one provenance.json per policy (first ledger episode).
 */
async function policyDigests(
  campaignId: string,
  lines: EvalLedgerLine[],
): Promise<Record<string, string>> {
  const digests: Record<string, string> = {};
  for (const line of lines) {
    if (digests[line.policyId] !== undefined) continue;
    if (!isSafeArtifactId(line.episodeId)) continue;
    const provenance = await readEpisodeProvenance(campaignId, line.episodeId);
    digests[line.policyId] = provenance?.policy.checkpointDigest ?? "";
  }
  return digests;
}

async function versionIdsByDigest(context: AppContext | null): Promise<Record<string, string>> {
  if (!context) return {};
  try {
    const versions = await listModelVersions(context);
    const byDigest: Record<string, string> = {};
    for (const version of versions) byDigest[version.checkpointDigest] = version.id;
    return byDigest;
  } catch {
    return {};
  }
}

async function campaignSummary(
  campaignId: string,
  versionIdByDigest: Record<string, string>,
): Promise<EvalCampaignSummary | null> {
  const [lines, specRaw] = await Promise.all([
    readLedgerLines(campaignId),
    readJsonFile(join(runsRoot(), campaignId, "campaign.json")),
  ]);
  const spec = EvalCampaignSpecSchema.safeParse(specRaw);
  if (lines.length === 0 && specRaw === null) return null;
  let hasReport = false;
  try {
    hasReport = (await stat(join(runsRoot(), campaignId, "report.json"))).isFile();
  } catch {
    hasReport = false;
  }
  const digests = await policyDigests(campaignId, lines);
  return {
    campaignId,
    name: (spec.success ? spec.data.name : null) ?? campaignId,
    createdAt: (spec.success ? spec.data.createdAt : null) ?? null,
    episodes: lines.length,
    hasReport,
    policies: summarizePolicies(lines, versionIdByDigest, digests),
  };
}

/** Campaign dirs are the runs-root children holding a ledger or campaign spec. */
export async function listCampaigns(context: AppContext | null): Promise<EvalCampaignSummary[]> {
  let entries: string[];
  try {
    entries = (await readdir(runsRoot(), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && isSafeArtifactId(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const versionIdByDigest = await versionIdsByDigest(context);
  const campaigns: EvalCampaignSummary[] = [];
  for (const campaignId of entries) {
    const summary = await campaignSummary(campaignId, versionIdByDigest);
    if (summary) campaigns.push(summary);
  }
  campaigns.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  return campaigns;
}

export async function getCampaign(
  context: AppContext | null,
  campaignId: string,
): Promise<EvalCampaignSummary | null> {
  if (!isSafeArtifactId(campaignId)) return null;
  return campaignSummary(campaignId, await versionIdsByDigest(context));
}

function episodeDir(campaignId: string, episodeId: string): string {
  return join(runsRoot(), campaignId, episodeId);
}

async function readEpisodeProvenance(
  campaignId: string,
  episodeId: string,
): Promise<EvalProvenance | null> {
  const raw = await readJsonFile(join(episodeDir(campaignId, episodeId), "provenance.json"));
  const parsed = EvalProvenanceSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

async function readEpisodeScore(
  campaignId: string,
  episodeId: string,
): Promise<EvalScore | null> {
  const raw = await readJsonFile(join(episodeDir(campaignId, episodeId), "score.json"));
  const parsed = EvalScoreSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export async function getPolicyDetail(
  context: AppContext | null,
  campaignId: string,
  policyId: string,
): Promise<EvalPolicyDetail | null> {
  if (!isSafeArtifactId(campaignId) || !isSafeArtifactId(policyId)) return null;
  const summary = await campaignSummary(campaignId, await versionIdsByDigest(context));
  const policy = summary?.policies.find((candidate) => candidate.policyId === policyId);
  if (!summary || !policy) return null;
  const lines = (await readLedgerLines(campaignId)).filter((line) => line.policyId === policyId);
  const episodes = [];
  let provenanceSample: EvalProvenance | null = null;
  for (const line of lines) {
    if (!isSafeArtifactId(line.episodeId)) continue;
    const score = await readEpisodeScore(campaignId, line.episodeId);
    if (!provenanceSample) {
      provenanceSample = await readEpisodeProvenance(campaignId, line.episodeId);
    }
    episodes.push({
      episodeId: line.episodeId,
      scenarioId: line.scenarioId,
      seed: line.seed,
      completedAt: line.completedAt,
      score,
      ledgerScore: line.drivingScore,
      ledgerRouteCompletion: line.routeCompletion,
    });
  }
  episodes.sort(
    (a, b) => a.scenarioId.localeCompare(b.scenarioId) || a.seed - b.seed,
  );
  return { campaignId, policy, provenanceSample, episodes };
}

/**
 * trace.jsonl → normalized playback ticks. Decision lines only: the leading
 * `{reset:...}` and trailing `{summary:...}` lines don't parse as decisions
 * and are dropped, as is any malformed line.
 */
async function readViewTicks(campaignId: string, episodeId: string): Promise<EvalViewTick[]> {
  let text: string;
  try {
    text = await readFile(join(episodeDir(campaignId, episodeId), "trace.jsonl"), "utf8");
  } catch {
    return [];
  }
  const ticks: EvalViewTick[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const parsed = EvalTraceLineSchema.safeParse(raw);
    if (!parsed.success) continue;
    const decision = parsed.data;
    const sv = decision.sv;
    ticks.push({
      step: decision.step,
      tS: decision.t,
      x: sv[0] ?? 0,
      y: sv[1] ?? 0,
      yawRad: Math.atan2(sv[3] ?? 0, sv[2] ?? 1),
      speedMps: sv[4] ?? 0,
      accelMps2: sv[5] ?? 0,
      latOffM: sv[6] ?? 0,
      miss: Boolean(decision.miss),
      rw: decision.rw ?? null,
      inferMs: decision.timing?.infer_ms ?? null,
      roundtripMs: decision.timing?.roundtrip_ms ?? null,
      reasoning: decision.reasoning ?? null,
      action: decision.a ?? null,
      thumbs: decision.frames?.thumbs ?? null,
    });
  }
  ticks.sort((a, b) => a.step - b.step);
  return ticks;
}

async function readEpisodeEvents(campaignId: string, episodeId: string): Promise<EvalEvent[]> {
  const raw = await readJsonFile(join(episodeDir(campaignId, episodeId), "events.json"));
  const parsed = EvalEventsSchema.safeParse(raw);
  return parsed.success ? parsed.data.events : [];
}

export async function getEpisodePayload(
  campaignId: string,
  episodeId: string,
): Promise<EvalEpisodePayload | null> {
  if (!isSafeArtifactId(campaignId) || !isSafeArtifactId(episodeId)) return null;
  const [ticks, events, score, provenance] = await Promise.all([
    readViewTicks(campaignId, episodeId),
    readEpisodeEvents(campaignId, episodeId),
    readEpisodeScore(campaignId, episodeId),
    readEpisodeProvenance(campaignId, episodeId),
  ]);
  if (ticks.length === 0 && !score && !provenance) return null;
  let complete = false;
  try {
    complete = (await stat(join(episodeDir(campaignId, episodeId), "COMPLETE"))).isFile();
  } catch {
    complete = false;
  }
  return { campaignId, episodeId, score, provenance, ticks, events, complete };
}

/**
 * Resolve a frame path relative to the episode's directory. Null for unsafe
 * ids, traversal outside the episode dir, or a missing/non-file target.
 */
export async function resolveEpisodeFramePath(
  campaignId: string,
  episodeId: string,
  relativePath: string,
): Promise<string | null> {
  if (!isSafeArtifactId(campaignId) || !isSafeArtifactId(episodeId)) return null;
  if (isAbsolute(relativePath) || relativePath.includes("\0")) return null;
  const base = resolve(episodeDir(campaignId, episodeId));
  const target = resolve(base, relativePath);
  if (target !== base && !target.startsWith(base + sep)) return null;
  try {
    const info = await stat(target);
    if (!info.isFile()) return null;
  } catch {
    return null;
  }
  return target;
}

export const DIVERGENCE_THRESHOLD_M = 0.5;

/** First step both traces cover where ego positions differ by more than the threshold. */
export function divergenceStep(
  a: EvalViewTick[],
  b: EvalViewTick[],
  thresholdM = DIVERGENCE_THRESHOLD_M,
): { step: number; tS: number } | null {
  const byStep = new Map<number, EvalViewTick>();
  for (const tick of a) byStep.set(tick.step, tick);
  const thresholdSq = thresholdM * thresholdM;
  for (const tick of b) {
    const other = byStep.get(tick.step);
    if (!other) continue;
    const dx = tick.x - other.x;
    const dy = tick.y - other.y;
    if (dx * dx + dy * dy > thresholdSq) return { step: tick.step, tS: tick.tS };
  }
  return null;
}

/**
 * Read one column's cell for a row: its result, its identity, its gaps.
 *
 * Identity comes from the episode's own artifacts, never from the request: a
 * comparison that trusted the caller's claim about which model produced a
 * column could rank a run against a label rather than against a run. Fields the
 * artifacts do not carry stay null and make the pair non-`matched`, which is the
 * conservative direction.
 */
async function comparisonCell(
  campaignId: string,
  line: EvalLedgerLine | undefined,
): Promise<EvalComparisonCell | null> {
  if (!line || !isSafeArtifactId(line.episodeId)) return null;
  const [provenance, score] = await Promise.all([
    readEpisodeProvenance(campaignId, line.episodeId),
    readEpisodeScore(campaignId, line.episodeId),
  ]);
  const extra = (provenance ?? {}) as Record<string, unknown>;
  const model = (extra["model"] ?? {}) as Record<string, unknown>;
  const rig = (extra["rig"] ?? {}) as Record<string, unknown>;
  const runtime = (extra["runtime"] ?? {}) as Record<string, unknown>;
  const timeBase = (extra["timeBase"] ?? {}) as Record<string, unknown>;
  const scoreDoc = (score ?? {}) as Record<string, unknown>;
  const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
  const num = (value: unknown): number | null => (typeof value === "number" ? value : null);
  const bool = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);

  // Metrics the comparison ranks. Driving score comes from the ledger line when
  // score.json is absent, which is the same fallback the campaign summary uses.
  const metrics: Record<string, number | null> = {
    drivingScore: num(scoreDoc["drivingScore"]) ?? line.drivingScore,
    routeCompletion: num(scoreDoc["routeCompletion"]) ?? line.routeCompletion,
  };
  const unavailable = Array.isArray(scoreDoc["unavailable"])
    ? (scoreDoc["unavailable"] as unknown[]).filter((entry): entry is string => typeof entry === "string")
    : [];

  return {
    episodeId: line.episodeId,
    status: line.status,
    scored: score !== null || line.status === "complete",
    truncation: text(scoreDoc["truncation"]),
    unscoredReason: text(extra["unscoredReason"]),
    metrics,
    unavailable,
    scenarioInputDigest:
      text((extra["scenario"] as Record<string, unknown> | undefined)?.["fixtureSha256"]) ??
      text(extra["inputDigest"]),
    identity: {
      family: text(model["family"]),
      familyLabel: text(model["familyLabel"]) ?? text(model["family"]),
      revision: text(model["revision"]),
      quant: text(model["quant"]),
      checkpointDigest:
        text(model["checkpointDigest"]) ??
        text((extra["policy"] as Record<string, unknown> | undefined)?.["checkpointDigest"]),
      policySeed: num(extra["policySeed"]),
      rig: {
        profile: text(rig["profile"]) ?? text(model["cameraProfile"]),
        profileVersion: text(rig["profileVersion"]),
        profileSha256: text(rig["profileSha256"]),
        cameraIds: Array.isArray(rig["cameraIds"])
          ? (rig["cameraIds"] as unknown[])
              .filter((id): id is number => typeof id === "number")
              .slice()
              .sort((x, y) => x - y)
          : [],
        resolution: {
          width: num(rig["renderWidth"]),
          height: num(rig["renderHeight"]),
        },
        intrinsicsSha256: text(rig["intrinsicsSha256"]),
        extrinsicsSha256: text(rig["extrinsicsSha256"]),
        historyFrames: num(rig["framesPerCamera"]),
        historyDtS: num(rig["historyDtS"]),
        cadenceHz: num(rig["cadenceHz"]),
        cadenceDividesExactly: bool(timeBase["cadence_divides_exactly"]),
        worstResampleErrorS: num(timeBase["worst_resample_error_s"]),
      },
      runtime: {
        engineVersion: text(runtime["engineVersion"]),
        abiVersion: num(runtime["abiVersion"]),
        addonSha256: text(runtime["addonSha256"]),
        decisionHz: num(extra["decisionHz"]),
      },
    },
  };
}

/** Metrics the comparison ranks, in the order a reader should see them. */
const COMPARED_METRICS = ["drivingScore", "routeCompletion"] as const;

/**
 * Compare N policy columns over one campaign.
 *
 * Column 0 is the baseline every verdict is taken against. There is no two-sided
 * form: a comparison of three models was previously three pages and a reader
 * holding the baseline in their head.
 */
export async function comparePolicies(
  context: AppContext | null,
  campaignId: string,
  policyIds: readonly string[],
): Promise<EvalRunComparison | null> {
  if (!isSafeArtifactId(campaignId)) return null;
  if (policyIds.length < 2) return null;
  const summary = await campaignSummary(campaignId, await versionIdsByDigest(context));
  if (!summary) return null;
  const columns = policyIds.map((policyId) =>
    summary.policies.find((policy) => policy.policyId === policyId),
  );
  if (columns.some((column) => column === undefined)) return null;

  const lines = await readLedgerLines(campaignId);
  const rows = new Map<string, (EvalLedgerLine | undefined)[]>();
  for (const line of lines) {
    const columnIndex = policyIds.indexOf(line.policyId);
    if (columnIndex < 0) continue;
    const key = `${line.scenarioId}\u0000${line.seed}`;
    const row = rows.get(key) ?? Array.from({ length: policyIds.length }, () => undefined);
    row[columnIndex] = line;
    rows.set(key, row);
  }

  const episodes: EvalEpisodeComparison[] = [];
  for (const [key, row] of rows) {
    const [scenarioId = "", seedText = ""] = key.split("\u0000");
    const cells = await Promise.all(row.map((line) => comparisonCell(campaignId, line)));
    const baseline = cells[0] ?? null;
    const baselineTicks =
      baseline?.episodeId && isSafeArtifactId(baseline.episodeId)
        ? await readViewTicks(campaignId, baseline.episodeId)
        : null;
    const verdicts: EvalComparabilityVerdict[] = [];
    const differing: string[][] = [];
    const divergenceSteps: (number | null)[] = [];
    const divergenceTimes: (number | null)[] = [];
    for (let index = 0; index < cells.length; index += 1) {
      const cell = cells[index] ?? null;
      const detail = index === 0 && cell ? { verdict: "matched" as const, differing: [] } : comparability(baseline, cell);
      verdicts.push(detail.verdict);
      differing.push([...detail.differing]);
      let divergence: { step: number; tS: number } | null = null;
      if (index > 0 && baselineTicks && cell?.episodeId && isSafeArtifactId(cell.episodeId)) {
        divergence = divergenceStep(baselineTicks, await readViewTicks(campaignId, cell.episodeId));
      }
      divergenceSteps.push(divergence?.step ?? null);
      divergenceTimes.push(divergence?.tS ?? null);
    }
    episodes.push({
      scenarioId,
      seed: Number(seedText),
      cells,
      verdicts,
      differing,
      divergenceStep: divergenceSteps,
      divergenceTS: divergenceTimes,
    });
  }
  episodes.sort((x, y) => x.scenarioId.localeCompare(y.scenarioId) || x.seed - y.seed);

  const rankRows = episodes.map((episode) => ({
    scenarioId: episode.scenarioId,
    seed: episode.seed,
    cells: episode.cells,
  }));
  const rankings = COMPARED_METRICS.map((metricId) => {
    const ranking = rankMetric(rankRows, policyIds.length, metricId);
    return {
      metricId: ranking.metricId,
      columns: ranking.columns.map((column) => ({ ...column })),
      // The reason union is the rule module's; on the wire it is a string the
      // page maps to a sentence, so it widens here rather than the type.
      excluded: ranking.excluded.map((entry) => ({
        scenarioId: entry.scenarioId,
        seed: entry.seed,
        reason: String(entry.reason),
      })),
      orderable: ranking.orderable,
    };
  });

  return {
    campaignId,
    divergenceThresholdM: DIVERGENCE_THRESHOLD_M,
    columns: columns as EvalPolicySummary[],
    episodes,
    rankings,
  };
}
