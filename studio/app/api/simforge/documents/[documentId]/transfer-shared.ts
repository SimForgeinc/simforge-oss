import "server-only";

import {
  adaptTemplateNotes,
  compileTemplate,
  liftMapBoundTemplate,
  matchSites,
  materializationSemanticLosses,
  type MapBundle,
  type MatchedSite,
  type PortableLiftIssue,
} from "@simforge-oss/compiler/node";
import { parseTemplate, ScenarioValidationError, type ScenarioTemplateV2 } from "@simforge-oss/scenario";
import type {
  PortableLiftIssueDto,
  ScenarioTransferCandidateDto,
  ScenarioTransferMapOptionDto,
  ScenarioTransferOptionsDto,
  TransferDocumentRequest,
} from "@simforge-oss/studio-host";
import type { AppContext } from "@/app/lib/db/app-context";
import { canonicalJsonSha256 } from "@/app/lib/scenario/core";
import {
  type CrossMapVariationTransferReceiptInput,
  listScenarioMapDescriptors,
} from "@/app/lib/scenario/document-store";
import { loadCollisionDraftMap } from "@/app/lib/scenario/collision-draft-map.server";
import type { ScenarioDocumentDto, ScenarioMapDescriptorDto } from "@/app/lib/scenario/contracts";
import {
  boundRigidPairLateralFractions,
  chainLanePath,
  rankCandidates,
} from "@/app/lib/scenario/transfer-rules";
import {
  buildTransferPreview,
  isRoadActorKind,
  laneClass,
  type PreviewActor,
} from "@/app/lib/scenario/transfer-preview";

/**
 * Cross-map transfer: lift a map-bound scenario into its portable form, find
 * the places on other maps where it holds, and pin a copy to one of them.
 *
 * A candidate is only offered once it has passed the checks the editor's
 * playback worker will apply to the saved document — the matcher keeps its
 * intent, the native compiler materializes it feasibly with no semantic loss —
 * so every card the user can pick opens and plays. The compiled start poses
 * that proved it are also what its preview is drawn from.
 */

/** Cards per map. Enough to choose between; few enough to take in at once. */
const MAX_CANDIDATES_PER_MAP = 6;
/** Sites asked of the matcher: the first ones can fail the compile check. */
const MATCH_POOL = 24;
/** Sites compiled per map at most: a map whose first dozen all fail has nothing to offer. */
const MAX_VET_ATTEMPTS = 12;
/** Sites that must fail to compile with one identical error before the map stops trying. */
const UNIFORM_FAILURE_ATTEMPTS = 3;
/** Once a map has one vetted placement, stop compiling more after this long. */
const VET_BUDGET_MS = 12_000;
/** A road actor further than this from every drivable centreline is off the road. */
const OFF_ROAD_M = 3;

function issueDto(issue: PortableLiftIssue): PortableLiftIssueDto {
  return {
    code: issue.code,
    severity: issue.severity,
    ...(issue.path === undefined ? {} : { path: issue.path }),
    message: issue.message,
  };
}

/** A small insertion-ordered LRU of promises; a rejected entry is dropped so it can be retried. */
class PromiseCache<T> {
  private readonly entries = new Map<string, Promise<T>>();
  constructor(private readonly capacity: number) {}

  get(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit) {
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit;
    }
    const loading = load();
    this.entries.set(key, loading);
    while (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!);
    loading.catch(() => {
      if (this.entries.get(key) === loading) this.entries.delete(key);
    });
    return loading;
  }

  /** The entry for `key` if one is cached or loading, without starting a load. */
  peek(key: string): Promise<T> | undefined {
    return this.entries.get(key);
  }
}

type LiftedSource = {
  descriptor: ScenarioMapDescriptorDto;
  sourceTopologyDigest: string;
  sourceSiteId: string | null;
  issues: PortableLiftIssueDto[];
  /** The validated portable template; `null` when the lift was refused. */
  template: ScenarioTemplateV2 | null;
  patternSha256: string | null;
};

type VettedCandidate = ScenarioTransferCandidateDto & {
  intentPreserved: boolean;
  matchSemanticsVersion: string;
  replayKey: Record<string, unknown> | null;
};

type TargetCandidates = {
  targetTopologyDigest: string;
  candidates: VettedCandidate[];
};

const liftCache = new PromiseCache<LiftedSource | null>(16);
const candidateCache = new PromiseCache<TargetCandidates>(96);

function validationIssues(error: unknown): PortableLiftIssueDto[] {
  if (error instanceof ScenarioValidationError) {
    return error.issues.slice(0, 8).map((issue) => ({
      code: "portable_template_invalid",
      severity: "error" as const,
      path: issue.path,
      message: issue.message,
    }));
  }
  return [{
    code: "portable_template_invalid",
    severity: "error",
    message: error instanceof Error ? error.message : String(error),
  }];
}

/** The native error's first line, without the source excerpt the dev overlay appends. */
function compileFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0]!.slice(0, 400);
}

async function liftSource(
  context: AppContext,
  source: ScenarioDocumentDto,
  descriptors: readonly ScenarioMapDescriptorDto[],
): Promise<LiftedSource | null> {
  const descriptor = descriptors.find((candidate) => candidate.mapVersionId === source.mapVersionId);
  if (!descriptor) return null;
  const key = `${source.id}:${source.mapVersionId}:${canonicalJsonSha256(source.content)}`;
  return liftCache.get(key, async () => {
    const binding = await loadCollisionDraftMap(context, descriptor.sourceMapId);
    if (binding.mapVersionId !== descriptor.mapVersionId) return null;
    const result = liftMapBoundTemplate(source.content, binding.bundle);
    const issues = result.issues.map(issueDto);
    const lifted: LiftedSource = {
      descriptor,
      sourceTopologyDigest: binding.bundle.digest,
      sourceSiteId: result.sourceSiteId,
      issues,
      template: null,
      patternSha256: null,
    };
    if (!result.template || !result.sourceSiteId) return lifted;
    let template: ScenarioTemplateV2;
    try {
      template = parseTemplate(boundRigidPairLateralFractions(result.template));
    } catch (error) {
      return { ...lifted, issues: [...issues, ...validationIssues(error)] };
    }
    // The editor refuses any portable template the matcher would have to
    // rewrite; refuse it here too rather than create a document that won't open.
    const notes = adaptTemplateNotes(template);
    if (notes.length > 0) {
      return {
        ...lifted,
        issues: [
          ...issues,
          ...notes.map((note) => ({
            code: note.code ?? "matcher_rewrite_required",
            severity: "error" as const,
            path: note.path,
            message: note.reason,
          })),
        ],
      };
    }
    return { ...lifted, template, patternSha256: canonicalJsonSha256(template.anchor) };
  });
}

/** The portable template pinned to one site of the target map: the content a variation is saved with. */
function pinnedContent(
  portable: ScenarioTemplateV2,
  target: ScenarioMapDescriptorDto,
  siteId: string,
  topologyDigest: string,
): ScenarioTemplateV2 {
  return parseTemplate({
    ...portable,
    sourceMap: { mapId: target.sourceMapId, mapName: target.label },
    anchor: {
      ...portable.anchor,
      pin: { mapId: target.sourceMapId, siteId, topologyDigest },
    },
  });
}

type Segment = { ax: number; ay: number; bx: number; by: number };
const driveSegmentsByBundle = new WeakMap<MapBundle, Segment[]>();

/** Every drivable lane centreline segment on the map, xodr-local; built once per loaded map. */
function driveSegments(bundle: MapBundle): Segment[] {
  const cached = driveSegmentsByBundle.get(bundle);
  if (cached) return cached;
  const segments: Segment[] = [];
  for (const lane of Object.values(bundle.topology.lanes)) {
    if (laneClass(lane.laneType) !== "drive") continue;
    const points = lane.polyline.map((point) => (Array.isArray(point) ? { x: point[0], y: point[1] } : point));
    for (let index = 1; index < points.length; index += 1) {
      segments.push({ ax: points[index - 1]!.x, ay: points[index - 1]!.y, bx: points[index]!.x, by: points[index]!.y });
    }
  }
  driveSegmentsByBundle.set(bundle, segments);
  return segments;
}

function distanceToRoad(segments: readonly Segment[], x: number, y: number): number {
  let best = Infinity;
  for (const segment of segments) {
    const dx = segment.bx - segment.ax;
    const dy = segment.by - segment.ay;
    const length2 = dx * dx + dy * dy;
    const t = length2 > 0 ? Math.max(0, Math.min(1, ((x - segment.ax) * dx + (y - segment.ay) * dy) / length2)) : 0;
    const distance = Math.hypot(x - (segment.ax + t * dx), y - (segment.ay + t * dy));
    if (distance < best) best = distance;
  }
  return best;
}

type CompiledActor = {
  id: string;
  kind: string;
  dims?: { l: number; w: number };
  initial: { pose: { x: number; z: number; headingRad: number } };
  behavior?: { route?: { kind: string; points?: Array<{ x: number; z: number }>; lanes?: string[] } };
};

/** The subject's route start as scene points, from whichever route form the compiler emitted. */
function routePoints(bundle: MapBundle, actor: CompiledActor | undefined): Array<{ x: number; z: number }> | null {
  const route = actor?.behavior?.route;
  if (!actor || !route) return null;
  if ((route.kind === "polyline" || route.kind === "timedPolyline") && route.points) {
    return route.points.map((point) => ({ x: point.x, z: point.z }));
  }
  if (route.kind === "lanePath" && route.lanes) {
    return chainLanePath(
      route.lanes.map((rsl) => (bundle.topology.lanes[rsl]?.polyline ?? []).map((point) => {
        const local = Array.isArray(point) ? { x: point[0], y: point[1] } : point;
        return { x: local.x, z: -local.y };
      })),
      actor.initial.pose,
    );
  }
  return null;
}

type Rejection = "intent_relaxed" | "compile_failed" | "infeasible" | "semantic_loss" | "subject_off_road";

/**
 * Thrown when a map has sites but none of them compiles, for one reason: the
 * compiler's, reported as the scenario's rather than the map's.
 */
class TransferMapError extends Error {}

function vetSite(
  portable: ScenarioTemplateV2,
  target: ScenarioMapDescriptorDto,
  bundle: MapBundle,
  site: MatchedSite,
  onCompileError: (message: string) => void,
): VettedCandidate | Rejection {
  if (!site.degradation.intentPreserved) return "intent_relaxed";
  let compiled: ReturnType<typeof compileTemplate>;
  try {
    compiled = compileTemplate(pinnedContent(portable, target, site.siteId, bundle.digest), bundle, site.siteId, { drawIndex: -1 });
  } catch (error) {
    onCompileError(compileFailureMessage(error));
    return "compile_failed";
  }
  if (!compiled.manifest.feasible) return "infeasible";
  if (materializationSemanticLosses(compiled.manifest.notes).length > 0) return "semantic_loss";

  const actors = (compiled.input.actors as unknown as CompiledActor[]).filter((actor) => actor.initial?.pose);
  const subjectId = compiled.manifest.metricSubject ?? portable.metricSubject ?? portable.roles[0]?.id ?? null;
  const segments = driveSegments(bundle);
  let offRoadActors = 0;
  for (const actor of actors) {
    if (!isRoadActorKind(actor.kind)) continue;
    const offRoad = distanceToRoad(segments, actor.initial.pose.x, -actor.initial.pose.z) > OFF_ROAD_M;
    // A subject off the road is not a scenario anyone asked for.
    if (offRoad && actor.id === subjectId) return "subject_off_road";
    if (offRoad) offRoadActors += 1;
  }

  const previewActors: PreviewActor[] = actors.map((actor) => ({
    id: actor.id,
    kind: actor.kind,
    x: actor.initial.pose.x,
    z: actor.initial.pose.z,
    headingRad: actor.initial.pose.headingRad,
    ...(actor.dims ? { length: actor.dims.l, width: actor.dims.w } : {}),
  }));
  let preview: VettedCandidate["preview"] = null;
  try {
    preview = buildTransferPreview({
      lanes: Object.values(bundle.topology.lanes),
      actors: previewActors,
      subjectId,
      route: routePoints(bundle, actors.find((actor) => actor.id === subjectId)),
    });
  } catch {
    preview = null;
  }
  return {
    siteId: site.siteId,
    rank: 0,
    score: Math.round(site.score * 1000) / 1000,
    verdict: site.degradation.verdict === "exact" ? "exact" : "degraded",
    summary: site.degradation.verdict === "exact" ? "" : site.degradation.summary,
    offRoadActors,
    preview,
    intentPreserved: site.degradation.intentPreserved,
    matchSemanticsVersion: site.matchSemanticsVersion,
    replayKey: (compiled.manifest.replayKey as unknown as Record<string, unknown>) ?? null,
  };
}

type ReadyLift = LiftedSource & { template: ScenarioTemplateV2; patternSha256: string };

function candidateKey(lifted: ReadyLift, target: ScenarioMapDescriptorDto): string {
  return `${lifted.patternSha256}:${canonicalJsonSha256(lifted.template)}:${target.mapVersionId}`;
}

/**
 * The one candidate a create names. Normally it is still in the cache from the
 * listing the user picked it from; after a restart (or on another instance) it
 * is re-vetted on its own rather than by re-running the whole map's budgeted
 * search, which might stop before reaching it.
 */
async function vettedCandidate(
  context: AppContext,
  lifted: ReadyLift,
  target: ScenarioMapDescriptorDto,
  siteId: string,
): Promise<{ candidate: VettedCandidate; targetTopologyDigest: string } | null> {
  const cached = await candidateCache.peek(candidateKey(lifted, target))?.catch(() => undefined);
  const hit = cached?.candidates.find((candidate) => candidate.siteId === siteId);
  if (cached && hit) return { candidate: hit, targetTopologyDigest: cached.targetTopologyDigest };
  const binding = await loadCollisionDraftMap(context, target.sourceMapId);
  const match = matchSites(lifted.template, binding.bundle, { maxSites: MATCH_POOL });
  const site = match.report.sites.find((entry) => entry.siteId === siteId);
  if (!site) return null;
  const candidate = vetSite(lifted.template, target, binding.bundle, site, () => {});
  return typeof candidate === "string" ? null : { candidate, targetTopologyDigest: binding.bundle.digest };
}

async function targetCandidates(
  context: AppContext,
  lifted: ReadyLift,
  target: ScenarioMapDescriptorDto,
): Promise<TargetCandidates> {
  return candidateCache.get(candidateKey(lifted, target), async () => {
    const startedAt = performance.now();
    const binding = await loadCollisionDraftMap(context, target.sourceMapId);
    const loadedAt = performance.now();
    const bundle = binding.bundle;
    const match = matchSites(lifted.template, bundle, { maxSites: MATCH_POOL });
    const vetted: VettedCandidate[] = [];
    const rejected = new Map<Rejection, number>();
    const compileErrors = new Set<string>();
    const vettingStartedAt = performance.now();
    let attempts = 0;
    const uniformCompileFailure = () =>
      attempts > 0 && compileErrors.size === 1 && rejected.get("compile_failed") === attempts;
    for (const site of match.report.sites) {
      if (vetted.length >= MAX_CANDIDATES_PER_MAP || attempts >= MAX_VET_ATTEMPTS) break;
      // Each compile re-runs the matcher natively (tens of seconds on a large
      // map), so a map stops at its budget once it has something to offer.
      if (vetted.length > 0 && performance.now() - vettingStartedAt > VET_BUDGET_MS) break;
      attempts += 1;
      const candidate = vetSite(lifted.template, target, bundle, site, (message) => compileErrors.add(message));
      if (typeof candidate === "string") rejected.set(candidate, (rejected.get(candidate) ?? 0) + 1);
      else vetted.push(candidate);
      // The same compile error on the first sites is the scenario's, not the site's.
      if (vetted.length === 0 && attempts >= UNIFORM_FAILURE_ATTEMPTS && uniformCompileFailure()) break;
      // The compile is synchronous; let other requests through between sites.
      await new Promise((resolve) => setImmediate(resolve));
    }
    console.info(
      `[transfer] ${target.label}: ${match.report.sites.length} matched, ${vetted.length} vetted`
      + (rejected.size > 0 ? `, rejected ${JSON.stringify(Object.fromEntries(rejected))}` : "")
      + (match.report.sites.length === 0 && match.report.failureSummary ? ` (${match.report.failureSummary})` : "")
      + ` in ${Math.round(performance.now() - startedAt)} ms (map ${Math.round(loadedAt - startedAt)} ms)`,
    );
    // Every site failing to compile for one reason is the scenario's problem,
    // not the map's: say what the compiler said rather than "no placements".
    if (vetted.length === 0 && uniformCompileFailure()) {
      throw new TransferMapError([...compileErrors][0]!);
    }
    return {
      targetTopologyDigest: bundle.digest,
      candidates: rankCandidates(vetted, MAX_CANDIDATES_PER_MAP),
    };
  });
}

function mapUnavailableMessage(error: unknown): string {
  if (error instanceof TransferMapError) return error.message;
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("artifacts the native compiler needs") || message.includes("no published map version")
    ? "This map's data is not fully published yet."
    : "This map could not be searched. Try again.";
}

function publicCandidate(candidate: VettedCandidate): ScenarioTransferCandidateDto {
  return {
    siteId: candidate.siteId,
    rank: candidate.rank,
    score: candidate.score,
    verdict: candidate.verdict,
    summary: candidate.summary,
    offRoadActors: candidate.offRoadActors,
    preview: candidate.preview,
  };
}

export async function transferOptions(
  context: AppContext,
  source: ScenarioDocumentDto,
  request: { targetMapVersionIds?: readonly string[]; candidates?: boolean } = {},
): Promise<ScenarioTransferOptionsDto> {
  const descriptors = await listScenarioMapDescriptors(context);
  const lifted = await liftSource(context, source, descriptors);
  if (!lifted) {
    return {
      sourceMapVersionId: source.mapVersionId,
      sourceSiteId: null,
      lift: {
        ok: false,
        issues: [{
          code: "source_map_unavailable",
          severity: "error",
          message: "The source map version is not available in the published map catalog.",
        }],
      },
      maps: [],
    };
  }
  if (!lifted.template || !lifted.patternSha256) {
    return {
      sourceMapVersionId: source.mapVersionId,
      sourceSiteId: lifted.sourceSiteId,
      lift: { ok: false, issues: lifted.issues },
      maps: [],
    };
  }
  const ready = lifted as ReadyLift;

  const requested = request.targetMapVersionIds ? new Set(request.targetMapVersionIds) : null;
  const targets = descriptors
    .filter((descriptor) =>
      descriptor.mapVersionId !== source.mapVersionId
      && (!requested || requested.has(descriptor.mapVersionId)))
    .sort((a, b) => a.label.localeCompare(b.label));

  const listing = (descriptor: ScenarioMapDescriptorDto): ScenarioTransferMapOptionDto => ({
    mapVersionId: descriptor.mapVersionId,
    sourceMapId: descriptor.sourceMapId,
    label: descriptor.label,
    locality: descriptor.locality,
    siteIds: [],
  });

  const maps: ScenarioTransferMapOptionDto[] = [];
  if (request.candidates === false) {
    maps.push(...targets.map(listing));
  } else {
    // One map at a time: each holds a whole map bundle in memory while it is
    // matched, and a client that wants them in parallel asks per map.
    for (const descriptor of targets) {
      try {
        const found = await targetCandidates(context, ready, descriptor);
        maps.push({
          ...listing(descriptor),
          siteIds: found.candidates.map((candidate) => candidate.siteId),
          candidates: found.candidates.map(publicCandidate),
          error: null,
          errorScope: null,
        });
      } catch (error) {
        if (!(error instanceof TransferMapError)) console.error(`[transfer] matching ${descriptor.mapVersionId} failed`, error);
        maps.push({
          ...listing(descriptor),
          candidates: [],
          error: mapUnavailableMessage(error),
          errorScope: error instanceof TransferMapError ? "scenario" : "map",
        });
      }
    }
  }
  return {
    sourceMapVersionId: source.mapVersionId,
    sourceSiteId: lifted.sourceSiteId,
    lift: { ok: true, issues: lifted.issues },
    maps,
  };
}

export type PreparedTransfer =
  | { kind: "ready"; title: string; content: ScenarioTemplateV2; receipt: CrossMapVariationTransferReceiptInput }
  | { kind: "refused"; message: string };

export async function prepareTransfer(
  context: AppContext,
  source: ScenarioDocumentDto,
  input: TransferDocumentRequest,
): Promise<PreparedTransfer> {
  const descriptors = await listScenarioMapDescriptors(context);
  const target = descriptors.find((candidate) => candidate.mapVersionId === input.targetMapVersionId);
  if (!target || target.mapVersionId === source.mapVersionId) {
    return { kind: "refused", message: "The target map is not available." };
  }
  const lifted = await liftSource(context, source, descriptors);
  if (!lifted?.template || !lifted.patternSha256 || !lifted.sourceSiteId) {
    return { kind: "refused", message: "This scenario cannot be transferred to another map." };
  }
  const ready = lifted as ReadyLift;
  const found = await vettedCandidate(context, ready, target, input.siteId);
  if (!found) {
    return { kind: "refused", message: `That placement is no longer offered on ${target.label}.` };
  }
  const { candidate } = found;

  // The editor writes the document title from the template's name, so the two
  // are set together: otherwise opening the variation renames it back to its source.
  const title = (input.title ?? `${source.title} Variation`).slice(0, 200);
  const pinned = pinnedContent(ready.template, target, candidate.siteId, found.targetTopologyDigest);
  const content = parseTemplate({
    ...pinned,
    meta: { ...pinned.meta, name: title },
    ...(input.signalPlanDecision === "remove" ? { mapSignalPlans: [] } : {}),
  });
  return {
    kind: "ready",
    title,
    content,
    receipt: {
      patternId: `portable:${ready.patternSha256.slice(0, 55)}`,
      patternSha256: ready.patternSha256,
      sourceSiteId: lifted.sourceSiteId,
      targetSiteId: candidate.siteId,
      permutationKey: null,
      verdict: candidate.verdict === "exact" ? "equivalent" : "review",
      // Matched with intent preserved and compiled feasibly at this site;
      // what remains is a simulation of the saved document.
      acceptance: "pending_simulation",
      equivalenceScore: candidate.score,
      topologyScore: null,
      roleBindingScore: null,
      intentPreserved: candidate.intentPreserved,
      issues: lifted.issues,
      resumeToken: null,
      sourceTopologyDigest: lifted.sourceTopologyDigest,
      targetTopologyDigest: found.targetTopologyDigest,
      sourceClosureDigest: lifted.descriptor.browserClosureSha256,
      targetClosureDigest: target.browserClosureSha256,
      compilerVersion: null,
      matcherVersion: candidate.matchSemanticsVersion,
      solverVersion: null,
      paramSeed: null,
      drawIndex: -1,
      inputHash: null,
      replayKey: candidate.replayKey,
      replayToken: null,
      transferVerdict: null,
      geometryTransfer: null,
      behaviorPreservation: "unmeasured",
      behaviorMetrics: null,
      requiredChecksPassed: null,
      identityProvenance: "portable-lift:vetted-site",
    },
  };
}
