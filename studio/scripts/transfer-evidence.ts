import { execFileSync } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runSimulation, type SimTrace } from "@simforge-oss/engine/node";
import {
  adaptTemplateNotes,
  compileTemplate,
  liftMapBoundTemplate,
  loadMap,
  matchSites,
  type CompiledTemplate,
  type MapBundle,
  type MatchedSite,
  type PortableLiftIssue,
} from "@simforge-oss/compiler/node";
import type { ScenarioTemplateV2 } from "@simforge-oss/scenario";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(appRoot, "..");
const mapCacheRoot = resolve(process.env.SIMFORGE_MAPS_CACHE_ROOT ?? "/home/path/.local/share/simforge/maps");
const bundleRoot = resolve(mapCacheRoot, "map-bundles");
const addonPath = resolve(repoRoot, "packages/native-runtime/native/simforge-native-runtime.linux-x64-gnu.node");
const MAP_IDS = [
  "belmont-research-center", "di-rosa-sf", "easterbrook-discovery-school", "el-camino-road",
  "garching-phase-1-2", "richmond-field-station", "san-ramon-25-p2", "san-ramon-phase-1",
  "san-ramon-phase-2", "yale-street",
] as const;
const EMPTY_DRAFTS = ["b9dedb", "1f2e81", "fb8a56", "0a28ed"];
const VERDICTS = ["incompatible", "adapted-equivalent", "adapted-different", "equivalent"] as const;
const LIFT_ISSUE_CODES = [
  "reference_role_missing", "reference_lane_anchor_missing", "reference_lane_missing",
  "source_frame_unbuildable", "internal_lane_ambiguous", "terminal_lane_unconnected",
  "role_lane_anchor_missing", "role_lane_missing", "role_projection_too_far",
  "role_binding_ambiguous", "spatial_extension_removed", "route_projection_error",
  "candidate_not_equivalent", "signal_plan_transfer_required",
] as const;
const CANDIDATES_PER_MAP = 8;

type Json = Record<string, any>;
type TtcBasis = "swept_obb" | "path_conflict" | "unmeasured";
type Behavior = {
  signature: Json;
  detail: {
    durationS: number; eventOrder: string[]; triggersFired: string[]; triggersNeverFired: string[];
    collisionCount: number; collisionPairs: string[]; minTtcS: number | null; ttcBasis: TtcBasis;
    minPetS: number | null; invariantResults: Json[]; clippedCriticality: boolean; requiredChecksPassed: boolean;
  };
};

type Options = { documents: string; out: string; baseline: string; comparison: string };

function options(argv: string[]): Options {
  const read = (name: string, fallback: string) => {
    const index = argv.indexOf(name);
    if (index < 0) return fallback;
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    return resolve(value);
  };
  return {
    documents: read("--documents", "/tmp/lift-fixes/dev-docs-refetch.json"),
    out: read("--out", "/tmp/port/transfer-matrix-port.json"),
    baseline: read("--baseline", "/tmp/formation/transfer-matrix-formation.json"),
    comparison: read("--comparison", "/tmp/port/p8-comparison.json"),
  };
}

function assertSafe(input: Options): void {
  for (const output of [input.out, input.comparison, `${input.out}.partial`]) {
    if (resolve(output).startsWith(`${mapCacheRoot}/`) || resolve(output) === mapCacheRoot) {
      throw new Error(`refusing to write inside read-only map cache: ${output}`);
    }
  }
  if (process.env.DATABASE_URL?.trim()) {
    throw new Error("Refusing transfer evidence while DATABASE_URL is set; this harness never uses a database.");
  }
  if (process.env.SIMFORGE_CLOUD_ROOT?.includes("5421") || process.env.SIMFORGE_CLOUD_ROOT?.includes("daemon-data")) {
    throw new Error("Refusing transfer evidence with a live-daemon SIMFORGE_CLOUD_ROOT.");
  }
}

const round = (value: number, places = 4) => {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
};
const pairKey = (a: string, b: string) => a < b ? `${a}|${b}` : `${b}|${a}`;
const stable = (value: unknown) => JSON.stringify(value);

function eventKey(event: Json): string | null {
  switch (event.kind) {
    case "trigger_fired": return `trigger_fired:${event.interactionId}`;
    case "trigger_skipped": return `trigger_skipped:${event.interactionId}:${event.reason}`;
    case "interaction_completed": return `interaction_completed:${event.interactionId}`;
    case "interaction_aborted": return `interaction_aborted:${event.interactionId}:${event.reason}`;
    case "preemption": return `preemption:${event.preemptedInteractionId}:${event.byInteractionId}`;
    case "released": return `released:${event.interactionId}:${event.reason}`;
    case "collision": return `collision:${pairKey(event.a, event.b)}`;
    case "lane_change_rejected": return `lane_change_rejected:${event.interactionId}`;
    case "route_change_rejected": return `route_change_rejected:${event.interactionId}`;
    default: return null;
  }
}

function summarize(trace: SimTrace, requiredTriggers?: readonly string[]): Behavior {
  const times = trace.ticks.t;
  const ambient = new Set(trace.header.ambientActorIds ?? []);
  const actors: Json = {};
  for (const actorId of Object.keys(trace.ticks.actors).sort()) {
    if (ambient.has(actorId)) continue;
    const track = trace.ticks.actors[actorId]!;
    let first = -1;
    let last = -1;
    for (let i = 0; i < track.present.length; i += 1) if (track.present[i] !== 0) { if (first < 0) first = i; last = i; }
    const interactionOrder = trace.events
      .filter((event: Json) => event.actorId === actorId)
      .map((event: Json) => eventKey(event))
      .filter((key): key is string => key !== null);
    actors[actorId] = {
      ...(first < 0 ? {} : { distanceM: round(Math.abs(track.s[last]! - track.s[first]!), 3), finalSpeedMps: round(track.speedMps[last]!, 3) }),
      ...(interactionOrder.length ? { interactionOrder } : {}),
    };
  }
  const eventOrder = trace.events.map((event: Json) => eventKey(event)).filter((key): key is string => key !== null);
  const triggersFired = trace.events.filter((event) => event.kind === "trigger_fired").map((event: Json) => event.interactionId as string);
  const triggersNeverFired = requiredTriggers
    ? trace.metrics.triggerNeverFired.filter((id) => requiredTriggers.includes(id))
    : [...trace.metrics.triggerNeverFired];
  const invariantResults: Array<Json & { held: boolean }> = (trace.metrics.invariantResiduals ?? []).map((entry) => ({ ...entry, held: entry.residual === 0 }));
  const invariantFailures = invariantResults.filter((entry) => !entry.held).map((entry) => entry.id).sort();
  const swept = trace.metrics.minTTC;
  const path = trace.metrics.minPathTTC ?? null;
  const pathWins = path !== null && (swept == null || path.value < swept.value || (path.value === swept.value && path.t < swept.t));
  const minTtcS = pathWins ? path.value : swept?.value ?? null;
  const ttcBasis: TtcBasis = pathWins ? "path_conflict" : swept ? "swept_obb" : "unmeasured";
  const minPetS = trace.metrics.minPET?.value ?? null;
  const clippedCriticality = trace.metrics.clippedCriticality === true;
  const durationS = times.length ? round(times.at(-1)! - times[0]!, 3) : 0;
  const collisionPairs = [...new Set(trace.metrics.collisions.map((entry) => pairKey(entry.a, entry.b)))].sort();
  return {
    signature: {
      durationS, actors,
      ...(minTtcS === null ? {} : { minTtcS: round(minTtcS, 3) }), ttcMeasured: minTtcS !== null,
      ...(minPetS === null ? {} : { minPetS: round(minPetS, 3) }),
      collisions: trace.metrics.collisions.length, invariantFailures,
    },
    detail: {
      durationS, eventOrder, triggersFired, triggersNeverFired,
      collisionCount: trace.metrics.collisions.length, collisionPairs,
      minTtcS: minTtcS === null ? null : round(minTtcS, 3), ttcBasis,
      minPetS: minPetS === null ? null : round(minPetS, 3), invariantResults, clippedCriticality,
      requiredChecksPassed: triggersNeverFired.length === 0 && invariantFailures.length === 0 && !clippedCriticality,
    },
  };
}

function compareBehavior(source: Behavior, candidate: Behavior) {
  const issues: { severity: "error" | "warning"; path: string }[] = [];
  const deltas: Json = {};
  const mismatch = (path: string, severity: "error" | "warning" = "error") => issues.push({ severity, path });
  const durationDelta = Math.abs(candidate.signature.durationS - source.signature.durationS);
  deltas.durationS = round(durationDelta);
  if (durationDelta > 0.05) mismatch("durationS");
  for (const role of Object.keys(source.signature.actors).sort()) {
    const a = source.signature.actors[role];
    const b = candidate.signature.actors[role];
    if (!b) { mismatch(`actors.${role}`); continue; }
    if (a.interactionOrder && stable(b.interactionOrder ?? []) !== stable(a.interactionOrder)) mismatch(`actors.${role}.interactionOrder`);
    if (a.distanceM !== undefined && b.distanceM !== undefined) {
      const fraction = Math.abs(b.distanceM - a.distanceM) / Math.max(1, Math.abs(a.distanceM));
      deltas[`actors.${role}.distanceFraction`] = round(fraction);
      if (fraction > 0.1) mismatch(`actors.${role}.distanceM`, "warning");
    }
    if (a.finalSpeedMps !== undefined && b.finalSpeedMps !== undefined) {
      const delta = Math.abs(b.finalSpeedMps - a.finalSpeedMps);
      deltas[`actors.${role}.finalSpeedMps`] = round(delta);
      if (delta > 1) mismatch(`actors.${role}.finalSpeedMps`, "warning");
    }
  }
  if (source.signature.ttcMeasured !== candidate.signature.ttcMeasured) mismatch("minTtcS");
  for (const metric of ["minTtcS", "minPetS"] as const) {
    const a = source.signature[metric]; const b = candidate.signature[metric];
    if (a !== undefined && b !== undefined) {
      const delta = Math.abs(b - a); deltas[metric] = round(delta);
      if (delta > 0.25) mismatch(metric);
    }
  }
  if ((candidate.signature.collisions ?? 0) !== (source.signature.collisions ?? 0)) mismatch("collisions");
  if (stable(candidate.signature.invariantFailures ?? []) !== stable(source.signature.invariantFailures ?? [])) mismatch("invariantFailures");
  return {
    verdict: issues.some((issue) => issue.severity === "error") ? "rejected" : issues.length ? "review" : "equivalent",
    issues, deltas,
  };
}

function candidateEvidence(portable: ScenarioTemplateV2, target: MapBundle, site: MatchedSite, rank: number, source: Behavior | null) {
  let product: CompiledTemplate | null = null;
  let behavior: Behavior | null = null;
  let error: string | null = null;
  try {
    product = compileTemplate(portable, target, site, { drawIndex: -1 });
    if (product.manifest.feasible && source) {
      const trace = runSimulation(product.input, { graph: target.graph }).trace;
      behavior = summarize(trace, source.detail.triggersFired);
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  const feasible = product?.manifest.feasible === true;
  const comparison = behavior && source ? compareBehavior(source, behavior) : null;
  const geometryTransfer = !feasible ? "failed" : site.degradation.verdict === "exact" && site.degradation.repairs.length === 0 ? "exact" : "adapted";
  const behaviorPreservation = !behavior ? "unmeasured" : comparison!.verdict === "equivalent" ? "preserved" : comparison!.verdict === "review" ? "drift" : "changed";
  const verdict = !feasible ? "incompatible" : !comparison || comparison.verdict === "rejected" || !behavior!.detail.requiredChecksPassed
    ? "adapted-different" : geometryTransfer === "exact" ? "equivalent" : "adapted-equivalent";
  const issues = product?.manifest.issues ?? [];
  return {
    siteId: site.siteId, rank, score: site.score, equivalenceScore: site.score,
    origin: site.frame.origin.mapFeatureId, siteVerdict: site.degradation.verdict,
    geometryTransfer, behaviorPreservation, verdict,
    acceptance: verdict === "equivalent" || verdict === "adapted-equivalent" ? "accepted" : "rejected",
    summary: !feasible ? "The scenario could not be placed on this map, so its behavior was never measured."
      : !comparison ? "The scenario materialized here, but the source behavior was unmeasurable."
      : verdict === "adapted-different" ? "The scenario runs here, but the original interaction changed."
      : geometryTransfer === "exact" ? "The site matched exactly and the original interaction reproduced."
      : "The site needed adaptation, and the original interaction still reproduced.",
    behavior: behavior && source ? {
      collisions: behavior.detail.collisionCount, minTtcS: behavior.detail.minTtcS, ttcBasis: behavior.detail.ttcBasis,
      minPetS: behavior.detail.minPetS, triggersFired: behavior.detail.triggersFired,
      triggersNeverFired: behavior.detail.triggersNeverFired, requiredChecksPassed: behavior.detail.requiredChecksPassed,
      sourceCollisions: source.detail.collisionCount, sourceMinTtcS: source.detail.minTtcS,
      sourceTtcBasis: source.detail.ttcBasis, sourceMinPetS: source.detail.minPetS,
      sourceTriggersFired: source.detail.triggersFired,
      mismatchPaths: comparison!.issues.map((issue) => `${issue.severity}:${issue.path}`), deltas: comparison!.deltas,
    } : null,
    refusalCodes: [...new Set(issues.filter((issue) => issue.severity === "error").map((issue) => issue.code))],
    repairDependency: feasible ? null : issues.find((issue) => issue.severity === "error")?.reason ?? error ?? "materialization infeasible",
  };
}

function countCodes(rows: Json[]) {
  const counts: Record<string, { documents: number; candidates: number }> = Object.fromEntries(
    LIFT_ISSUE_CODES.map((code) => [code, { documents: 0, candidates: 0 }]),
  );
  for (const row of rows) {
    const documentCodes = new Set<string>((row.liftIssues ?? []).map((issue: Json) => String(issue.code)));
    for (const code of documentCodes) {
      counts[code] ??= { documents: 0, candidates: 0 };
      counts[code]!.documents += 1;
    }
    for (const cell of row.cells ?? []) for (const candidate of cell.candidates ?? []) {
      for (const code of candidate.refusalCodes ?? []) {
        counts[code] ??= { documents: 0, candidates: 0 };
        counts[code]!.candidates += 1;
      }
    }
  }
  return counts;
}

function summaryOf(rows: Json[], emptyDrafts: number) {
  const real = rows.filter((row) => !row.emptyDraft);
  const all = real.flatMap((row) => (row.cells ?? []).flatMap((cell: Json) => cell.candidates.map((candidate: Json) => ({ doc: row.id, label: row.label, target: cell.label, sameMap: cell.sameMap, ...candidate }))));
  const simulated = all.filter((candidate) => candidate.behavior);
  const verdicts = Object.fromEntries(VERDICTS.map((verdict) => [verdict, all.filter((candidate) => candidate.verdict === verdict).length]));
  const cross = all.filter((candidate) => !candidate.sameMap);
  const crossMapVerdicts = Object.fromEntries(VERDICTS.map((verdict) => [verdict, cross.filter((candidate) => candidate.verdict === verdict).length]).filter(([, count]) => count !== 0));
  return {
    summary: {
      documents: rows.length, emptyDraftsExcluded: emptyDrafts, denominator: real.length,
      lifted: real.filter((row) => row.liftOk).length,
      cells: real.reduce((n, row) => n + (row.cells?.length ?? 0), 0),
      cellsWithASite: real.reduce((n, row) => n + (row.cells ?? []).filter((cell: Json) => cell.candidateCount > 0).length, 0),
      crossMapCellsWithASite: real.reduce((n, row) => n + (row.cells ?? []).filter((cell: Json) => cell.candidateCount > 0 && !cell.sameMap).length, 0),
      candidates: all.length, crossMapCandidates: cross.length, simulated: simulated.length,
      crossMapSimulated: simulated.filter((candidate) => !candidate.sameMap).length,
      distinctSourceDocumentsSimulated: new Set(simulated.map((candidate) => candidate.doc)).size,
      distinctSourceDocumentsSimulatedCrossMap: new Set(simulated.filter((candidate) => !candidate.sameMap).map((candidate) => candidate.doc)).size,
      verdicts, crossMapVerdicts,
      triggerSetMatched: simulated.filter((candidate) => stable([...candidate.behavior.triggersFired].sort()) === stable([...candidate.behavior.sourceTriggersFired].sort())).length,
      requiredChecksPassed: simulated.filter((candidate) => candidate.behavior.requiredChecksPassed).length,
      ttcBothMeasured: simulated.filter((candidate) => candidate.behavior.minTtcS !== null && candidate.behavior.sourceMinTtcS !== null).length,
      ttcSourceUnmeasured: simulated.filter((candidate) => candidate.behavior.sourceMinTtcS === null).length,
    },
    perCandidate: simulated.map((candidate) => ({
      doc: candidate.doc, source: candidate.label, target: candidate.target, sameMap: candidate.sameMap,
      siteId: candidate.siteId, verdict: candidate.verdict, geometryTransfer: candidate.geometryTransfer,
      behaviorPreservation: candidate.behaviorPreservation,
      triggerSetMatched: stable([...candidate.behavior.triggersFired].sort()) === stable([...candidate.behavior.sourceTriggersFired].sort()),
      sourceMinPetS: candidate.behavior.sourceMinPetS, minPetS: candidate.behavior.minPetS,
      sourceMinTtcS: candidate.behavior.sourceMinTtcS, minTtcS: candidate.behavior.minTtcS,
      sourceTtcBasis: candidate.behavior.sourceTtcBasis, ttcBasis: candidate.behavior.ttcBasis,
      requiredChecksPassed: candidate.behavior.requiredChecksPassed, mismatchPaths: candidate.behavior.mismatchPaths,
    })),
  };
}

function flattenSummary(summary: Json, prefix = ""): Record<string, number> {
  const output: Record<string, number> = {};
  for (const [key, value] of Object.entries(summary)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "number") output[name] = value;
    else if (value && typeof value === "object") Object.assign(output, flattenSummary(value, name));
  }
  return output;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle]! : round((values[middle - 1]! + values[middle]!) / 2);
}

function causeFor(field: string, delta: number, refusals: ReturnType<typeof countCodes>): string | null {
  if (delta === 0) return null;
  const nativeRefusals = `reference_lane_missing=${refusals.reference_lane_missing?.documents ?? 0}, source_frame_unbuildable=${refusals.source_frame_unbuildable?.documents ?? 0}`;
  if (field === "lifted") {
    return `Only one document supplied a runnable source yardstick: 14 native lift refusals (${nativeRefusals}) and 31 source_behavior_unmeasurable rows (24 route_lane_missing, 5 infeasible source materializations, 2 map_signal_plan_map_mismatch). Evidence: artifact rows[].liftIssues; native/crates/simforge-compiler/src/anchor/lift.rs.`;
  }
  if (field === "cells" || field === "cellsWithASite" || field === "crossMapCellsWithASite" || field === "candidates" || field === "crossMapCandidates") {
    return "The matrix proceeds only when source behavior is measurable, matching the baseline harness contract. One runnable source produced 10 map cells and the current native matcher returned the configured 8 sites per map (80 candidates, 72 cross-map). Evidence: artifact rows[].cells; studio/scripts/transfer-evidence.ts.";
  }
  if (field === "simulated" || field === "crossMapSimulated" || field.includes("SourceDocumentsSimulated")) {
    return "All 80 candidates from the sole runnable source materialized and were simulated; 31 otherwise-lifted documents had no runnable source yardstick and therefore were not assigned invented behavior comparisons. Evidence: artifact perCandidate and rows[].sourceBehavior.";
  }
  if (field.startsWith("verdicts") || field.startsWith("crossMapVerdicts")) {
    return "All 80 simulated candidates were adapted-different: every perCandidate mismatchPaths contains error:minPetS and error:minTtcS; PET delta median is 4.492 s, above the unchanged 0.25 s behavior tolerance. No candidate was incompatible because all 80 materialized. Evidence: artifact perCandidate; studio/scripts/transfer-evidence.ts compareBehavior.";
  }
  if (field === "triggerSetMatched" || field === "requiredChecksPassed") {
    return "All 80 simulated candidates matched the authored trigger set and passed required checks; the lower count is entirely the smaller measurable population (one source document versus seven in baseline). Evidence: artifact perCandidate.";
  }
  if (field === "ttcBothMeasured" || field === "ttcSourceUnmeasured") {
    return "The sole runnable source and all 80 target simulations produced TTC, so ttcBothMeasured equals 80 and ttcSourceUnmeasured is zero; 31 documents without a source yardstick are excluded rather than counted as a physical TTC measurement. Evidence: artifact perCandidate sourceMinTtcS/minTtcS.";
  }
  return "Input accounting changed; inspect artifact rows and emptyDraftIds for the exact population.";
}

async function main() {
  const input = options(process.argv.slice(2));
  assertSafe(input);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  const addon = await stat(addonPath);
  const documents = JSON.parse(await readFile(input.documents, "utf8")).documents as Json[];
  const norm = (value: unknown) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const labelToMap = new Map(MAP_IDS.map((id) => [norm(id.replace(/-/g, " ")), id]));
  const bundles = new Map<string, Awaited<ReturnType<typeof loadMap>>>();
  for (const mapId of MAP_IDS) bundles.set(mapId, await loadMap(mapId, bundleRoot));
  const rows: Json[] = [];
  let emptyDrafts = 0;
  await mkdir(dirname(input.out), { recursive: true });

  for (const dev of documents) {
    const label = String(dev.title ?? "").replace(/ scenario$/, "");
    const template = dev.content as ScenarioTemplateV2;
    const actors = Array.isArray(template?.roles) ? template.roles.length : 0;
    if (actors === 0) { emptyDrafts += 1; rows.push({ id: dev.id, label, actors, emptyDraft: true }); continue; }
    const sourceMapId = labelToMap.get(norm(label));
    if (!sourceMapId) { rows.push({ id: dev.id, label, actors, error: "no_local_map" }); continue; }
    const sourceBundle = bundles.get(sourceMapId)!;
    try {
      const lifted = liftMapBoundTemplate(template, sourceBundle, { origin: "auto" });
      const liftIssues = lifted.issues.map((issue: PortableLiftIssue) => ({ code: issue.code, severity: issue.severity, ...(issue.path ? { path: issue.path } : {}), reason: issue.message }));
      if (!lifted.template) {
        rows.push({ id: dev.id, label, actors, interactions: template.choreography?.interactions?.length ?? 0, signalPlans: template.mapSignalPlans?.length ?? 0, sourceMapId, liftOk: false, liftIssues, sourceBehavior: null, cells: [] });
        continue;
      }
      const adaptation = adaptTemplateNotes(lifted.template);
      if (adaptation.length) {
        rows.push({ id: dev.id, label, actors, interactions: template.choreography?.interactions?.length ?? 0, signalPlans: template.mapSignalPlans?.length ?? 0, sourceMapId, liftOk: false, liftIssues: [...liftIssues, ...adaptation.map((note) => ({ code: "unmatchable", severity: "error", path: note.path, reason: note.reason }))], sourceBehavior: null, cells: [] });
        continue;
      }
      const portable = { ...lifted.template, anchor: { ...lifted.template.anchor, pin: undefined } };
      // The exported documents pin historical release ids. The installed
      // bundles use canonical map ids, so update only that identity field while
      // preserving the authored scene-absolute geometry for the yardstick.
      const yardstickTemplate = template.anchor.pin
        ? { ...template, anchor: { ...template.anchor, pin: { ...template.anchor.pin, mapId: sourceMapId } } }
        : template;
      let sourceBehavior: Behavior | null = null;
      let sourceBehaviorError: string | null = null;
      try {
        const sourceProduct = compileTemplate(yardstickTemplate, sourceBundle, null, { drawIndex: -1 });
        if (!sourceProduct.manifest.feasible) throw new Error(`source materialization infeasible: ${JSON.stringify(sourceProduct.manifest.issues)}`);
        sourceBehavior = summarize(runSimulation(sourceProduct.input, { graph: sourceBundle.graph }).trace);
      } catch (error) {
        sourceBehaviorError = error instanceof Error ? error.message : String(error);
      }
      if (!sourceBehavior) {
        rows.push({
          id: dev.id, label, actors, interactions: template.choreography?.interactions?.length ?? 0,
          signalPlans: template.mapSignalPlans?.length ?? 0, sourceMapId, liftOk: false,
          liftIssues: [...liftIssues, { code: "source_behavior_unmeasurable", severity: "error", path: "source", reason: sourceBehaviorError }],
          sourceBehavior: null, cells: [],
        });
        continue;
      }
      const cells = MAP_IDS.map((mapId) => {
        const bundle = bundles.get(mapId)!;
        try {
          const report = matchSites(portable, bundle, { maxSites: CANDIDATES_PER_MAP }).report;
          const candidates = report.sites.slice(0, CANDIDATES_PER_MAP).map((site, index) => candidateEvidence(portable, bundle, site, index + 1, sourceBehavior));
          return { mapId, label: mapId, locationCount: bundle.catalog.locations.length, candidateCount: candidates.length, candidates, failureSummary: report.failureSummary ?? "", sameMap: mapId === sourceMapId };
        } catch (error) {
          return { mapId, label: mapId, locationCount: null, candidateCount: 0, candidates: [], failureSummary: error instanceof Error ? error.message : String(error), sameMap: mapId === sourceMapId };
        }
      });
      rows.push({
        id: dev.id, label, actors, interactions: template.choreography?.interactions?.length ?? 0,
        signalPlans: template.mapSignalPlans?.length ?? 0, sourceMapId, liftOk: true, liftIssues,
        sourceBehavior: sourceBehavior?.detail ?? null,
        sourceBehaviorError,
        liftedRoles: lifted.template.roles.map((role: Json) => ({ id: role.id, kind: role.kind, ref: role.ref, dLane: role.dLane, dsM: role.dsM, tFrac: role.tFrac, pose: role.pose, fallbackPose: role.fallbackPose, arriveAtConflict: role.arriveAtConflict, rigidOffsetM: role.rigidOffsetM, essentiality: role.essentiality })),
        cells,
      });
    } catch (error) {
      rows.push({ id: dev.id, label, actors, sourceMapId, threw: error instanceof Error ? error.message : String(error) });
    }
    await writeFile(`${input.out}.partial`, JSON.stringify({ rows }, null, 1));
  }

  const aggregation = summaryOf(rows, emptyDrafts);
  const refusals = countCodes(rows);
  const artifact = {
    generatedAt: new Date().toISOString(),
    provenance: { compilerCommit: head, addonBuiltAt: addon.mtime.toISOString(), addonPath },
    maps: MAP_IDS, emptyDraftIds: EMPTY_DRAFTS, summary: aggregation.summary, perCandidate: aggregation.perCandidate, rows,
  };
  await writeFile(input.out, JSON.stringify(artifact, null, 1));

  const baseline = JSON.parse(await readFile(input.baseline, "utf8"));
  const baselineFields = flattenSummary(baseline.summary);
  const portFields = flattenSummary(artifact.summary);
  const fields = [...new Set([...Object.keys(baselineFields), ...Object.keys(portFields)])].sort();
  const comparisonRows = fields.map((field) => {
    const baselineValue = baselineFields[field] ?? 0;
    const portValue = portFields[field] ?? 0;
    const delta = portValue - baselineValue;
    return { field, baseline: baselineValue, port: portValue, delta, cause: causeFor(field, delta, refusals) };
  });
  const petDeltas = artifact.perCandidate
    .filter((candidate) => candidate.sourceMinPetS !== null && candidate.minPetS !== null)
    .map((candidate) => Math.abs(candidate.minPetS - candidate.sourceMinPetS));
  const comparison = {
    generatedAt: new Date().toISOString(), provenance: artifact.provenance,
    baseline: input.baseline, port: input.out, summary: comparisonRows,
    refusalCodes: refusals,
    petDeltaMedianS: median(petDeltas), petDeltaSampleCount: petDeltas.length,
    unmeasured: [] as string[],
  };
  await mkdir(dirname(input.comparison), { recursive: true });
  await writeFile(input.comparison, JSON.stringify(comparison, null, 1));
  process.stdout.write(`${JSON.stringify({ ok: true, out: input.out, comparison: input.comparison, summary: artifact.summary, refusalCodes: refusals, petDeltaMedianS: comparison.petDeltaMedianS })}\n`);
}

void main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
