#!/usr/bin/env node
/**
 * Arm (ii) tag-strip promotion (supersedes prior worldgen M4 recast-as-primary).
 *
 * For each selected ego-involved mined event: take the cell's instance input,
 * remove 'ambient' from the counterpart actor's tags (nothing else changes),
 * re-simulate, evaluate, and write a promoted artifact set the frozen gate can
 * read. The counterpart's emerged trajectory was produced by the ambient engine,
 * not authored; promotion merely makes it metric-visible. The promoted run is a
 * NEW deterministic world: the pair becomes mutually visible to conflict logic
 * (engine.ts crossing-priority skips authored->ambient), so the conflict may
 * dissolve — that dissolution is measured, not hidden, and yield is counted on
 * the promoted cell's own gate verdict.
 *
 *   node promote_tagstrip.mjs --out <harvest-dir> [--max 60] [--tier T1|any]
 *
 * Reads <out>/mining/events.jsonl; writes <out>/cells/<cellId>/promoted-<actor>/
 *   {instance.json, trace.json.gz, result.json}
 * plus <out>/mining/promotions.jsonl.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const CLI = await import(path.join(ROOT, 'packages/cli/dist/index.js'));
const SE = await import(path.join(ROOT, 'packages/sim-engine/dist/index.js'));

const has = (name) => process.argv.includes(`--${name}`);
function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

const out = arg('out');
const maxN = Number(arg('max', 60));
const tierWant = arg('tier', 'any');

const events = readFileSync(path.join(out, 'mining/events.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));
// Collision blacklist: (cellDir, actorId) pairs seen colliding in the RAW world.
// A promoted counterpart's collisions with ANYONE count against frozen C5 (the
// pair is no longer ambient-ambient once one side is promoted), so events whose
// counterpart already crashes in the raw world are structurally dead. Measured:
// early batch died C5 exactly this way (promoted-gate.json round 1).
const collBlack = new Set();
try {
  for (const line of readFileSync(path.join(out, 'mining/collisions.jsonl'), 'utf8')
    .split('\n').filter(Boolean)) {
    const c = JSON.parse(line);
    for (const id of c.pair) collBlack.add(`${c.cell.out}|${id}`);
  }
} catch { /* no collisions file */ }

// Gate-aware selection (round-2 refinement, reasons measured in round 1):
// - ego-involved, non-collision, tier filter, counterpart not in collision blacklist;
// - t* comfortably inside the clip (>= 4 s: round-1 C2 deaths clustered at 2.44-2.58 s
//   from standing-queue neighbours adjacent at clip start);
// - initial separation check happens lazily below (raw trace read) — >= 15 m at the
//   pair's first common tick, again to dodge C2 queue-adjacency;
// - severity order: T1 first, then max pair decel desc (C4 wants real demand), then
//   TTC asc, then clearance asc; one promotion per cell.
const candidates = events
  .filter((e) => e.egoInvolved && !e.collision)
  .filter((e) => tierWant === 'any' || e.tier === tierWant)
  .filter((e) => e.tStar >= 4.0)
  .filter((e) => !collBlack.has(`${e.cell.out}|${e.pair.find((id) => id !== 'ego')}`))
  .sort((a, b) =>
    (a.tier === 'T1' ? 0 : 1) - (b.tier === 'T1' ? 0 : 1)
    || Math.max(...b.maxDecel) - Math.max(...a.maxDecel)
    || (a.ttcRrS ?? 99) - (b.ttcRrS ?? 99)
    || a.minClearanceM - b.minClearanceM);
const perCell = new Map();
for (const e of candidates) {
  const key = e.cell.out;
  if (!perCell.has(key)) perCell.set(key, e);
}
const preselected = [...perCell.values()];

// Lazy initial-separation filter over the raw trace, first common present tick.
import { gunzipSync } from 'node:zlib';
function initialSeparationM(cellDir, counterpart) {
  const tr = JSON.parse(gunzipSync(readFileSync(path.join(cellDir, 'trace.json.gz'))));
  const a = tr.ticks.actors.ego, b = tr.ticks.actors[counterpart];
  if (!a || !b) return 0;
  for (let i = 0; i < tr.ticks.t.length; i += 1) {
    if (a.present[i] && b.present[i]) {
      return Math.hypot(a.x[i] - b.x[i], a.y[i] - b.y[i]);
    }
  }
  return 0;
}
const MIN_SEP_M = 15;
const selected = [];
const sepRejected = [];
for (const e of preselected) {
  if (selected.length >= maxN) break;
  const counterpart = e.pair.find((id) => id !== 'ego');
  const dir = e.cell.out;
  if (existsSync(path.join(dir, `promoted-${counterpart.replace(/[^a-zA-Z0-9_.-]/g, '_')}`))) continue;
  const sep = initialSeparationM(dir, counterpart);
  if (sep < MIN_SEP_M) { sepRejected.push({ cellId: path.basename(dir), sep: Math.round(sep * 10) / 10 }); continue; }
  selected.push(e);
}
console.log(JSON.stringify({
  events: events.length, egoInvolvedEligible: candidates.length,
  cells: preselected.length, sepRejected: sepRejected.length, selected: selected.length,
}));

const promoLog = path.join(out, 'mining/promotions.jsonl');
if (!existsSync(promoLog) || has('fresh')) writeFileSync(promoLog, '');
const bundles = new Map();

for (const e of selected) {
  const cellDir = e.cell.out;
  const counterpart = e.pair.find((id) => id !== 'ego');
  const pdir = path.join(cellDir, `promoted-${counterpart.replace(/[^a-zA-Z0-9_.-]/g, '_')}`);
  const rec = {
    cellId: path.basename(cellDir), counterpart, tier: e.tier,
    ttcRrS: e.ttcRrS, minClearanceM: e.minClearanceM, category: e.category,
    signature: e.signature, window: e.window,
  };
  try {
    const inst = JSON.parse(readFileSync(path.join(cellDir, 'instance.json'), 'utf8'));
    const actor = inst.input.actors.find((a) => a.id === counterpart);
    if (!actor) throw new Error(`counterpart ${counterpart} not in instance`);
    actor.tags = (actor.tags ?? []).filter((t) => t !== 'ambient');
    const mapId = inst.manifest.replayKey?.mapId ?? inst.input.mapId;
    if (!bundles.has(mapId)) bundles.set(mapId, await CLI.loadMap(mapId));
    const bundle = bundles.get(mapId);
    const t0 = Date.now();
    const run = SE.runSimulation(inst.input, { graph: bundle.graph, guards: 'collect' });
    const wallMs = Date.now() - t0;
    const evaluation = SE.evaluateTrace(run.trace, CLI.filtersFor('critical', {}));
    const verdict = evaluation.verdict;
    const band = CLI.criticalityBand(verdict, evaluation.findings);
    const evidenceOk = SE.contentHash(SE.normalizeSimScenarioInput(inst.input))
      === run.trace.header.inputHash;
    mkdirSync(pdir, { recursive: true });
    const promotedManifest = {
      ...inst.manifest,
      inputHash: run.trace.header.inputHash,
      promotion: {
        kind: 'tag-strip', counterpart, sourceEvent: rec,
        note: 'ambient tag removed from counterpart; all other input bytes unchanged',
      },
    };
    writeFileSync(path.join(pdir, 'instance.json'),
      JSON.stringify({ kind: 'scenario-instance', version: 1, manifest: promotedManifest, input: inst.input }));
    await CLI.writeTraceFile(path.join(pdir, 'trace.json.gz'), run.trace);
    const result = {
      status: 'ok', promoted: true, counterpart,
      verdict, band, evidenceOk,
      findings: evaluation.findings.map((f) => ({ code: f.code, reason: f.reason })),
      metrics: CLI.metricsSummary ? CLI.metricsSummary(run.trace) : null,
      traceDigest: SE.traceDigest(run.trace), wallMs,
      ambientActorIds: run.trace.header.ambientActorIds?.length ?? 0,
    };
    writeFileSync(path.join(pdir, 'result.json'), JSON.stringify(result, null, 1));
    Object.assign(rec, {
      status: 'ok', verdict, band, evidenceOk, wallMs, dir: pdir,
      counterpartStillPresent: Boolean(run.trace.ticks.actors[counterpart]),
    });
  } catch (err) {
    Object.assign(rec, { status: 'error', error: String(err?.message ?? err) });
  }
  appendFileSync(promoLog, JSON.stringify(rec) + '\n');
  console.log(JSON.stringify({ cellId: rec.cellId, counterpart, status: rec.status, verdict: rec.verdict ?? null, band: rec.band ?? null }));
}
console.log(JSON.stringify({ promoted: selected.length, log: promoLog }));
