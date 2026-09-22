/**
 * The golden-trace corpus: the CI lock on engine semantics.
 *
 * Every case is a simulation input on a pinned map closure. The manifest
 * (`fixtures/golden-traces/manifest.json`) records, per case, the digest of the
 * resolved input and of the canonical trace (`traceSha256`, the native
 * `sha256(canonicalJson(quantize(trace)))`), together with the
 * `engineSemVer` they were produced under. The rule it enforces
 * (docs/engineering/engine-semver.md):
 *
 * - same `ENGINE_SEM_VER`  ⇒ byte-identical traces, so any digest change fails;
 * - a digest change must come with a manual `ENGINE_SEM_VER` bump, and
 *   `update` refuses to rewrite a changed digest under an unchanged version.
 *
 * Tiers: `ci` cases run on committed closures (Richmond Field Station, the one
 * public map, under `fixtures/golden-traces/maps/`) and run in CI. `local`
 * cases run on installed private maps (`SIMFORGE_MAPS_CACHE_ROOT`) and are
 * skipped where those maps are absent.
 *
 * Input sources:
 * - `input`: a committed `SimScenarioInput` (or instance document) run as is;
 * - `ambient`: the editor's blank-world pipeline, i.e. map controls, native
 *   ambient materialization and the Studio runtime refinements. The resolved
 *   input is written to `fixtures/golden-traces/inputs/<id>.input.json.gz`, so
 *   the native-vs-WASM identity test can replay the exact same input without
 *   the TypeScript pipeline.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

import { canonicalJsonPretty } from '@simforge-oss/scenario/canonical-json';
import { parseSimScenarioInput, type SimScenarioInput } from '@simforge-oss/engine';
import { engine } from '@simforge-oss/engine/node';
import {
  createSimulationMapBundle,
  DEV_ASSETS,
  readInstalledMapClosureFiles,
  REPO_ROOT,
  type MapBundle,
} from '@simforge-oss/compiler/node';
import {
  withBoundedSpeedCruiseRestoration,
  withEditablePhysicsDefault,
  withStableHighSpeedWorldRoutes,
} from '@simforge-oss/playback';

export const GOLDEN_ROOT = path.join(REPO_ROOT, 'fixtures', 'golden-traces');
export const GOLDEN_MANIFEST = path.join(GOLDEN_ROOT, 'manifest.json');
export const GOLDEN_CORPUS = path.join(GOLDEN_ROOT, 'corpus.json');
export const GOLDEN_MANIFEST_SCHEMA = 'simforge.golden-traces/v1';

export type GoldenTier = 'ci' | 'local';

export type GoldenSource =
  | { readonly kind: 'input'; readonly path: string }
  /** A v2 template compiled natively at a pinned site (catalog resolution, seeding, materialization). */
  | { readonly kind: 'template'; readonly path: string; readonly siteId: string; readonly drawIndex: number }
  | {
      readonly kind: 'ambient';
      readonly preset: 'light' | 'city' | 'heavy';
      readonly seed: string;
      readonly clipSeconds: number;
      readonly maxActors?: number;
      readonly radiusM?: number;
    };

export interface GoldenCase {
  readonly id: string;
  readonly tier: GoldenTier;
  readonly map: string;
  /** What the case exercises (stop, u-turn, walker, heavy-ambient, colliders, …); documentation and coverage checks. */
  readonly covers: readonly string[];
  readonly source: GoldenSource;
}

export interface GoldenCorpus {
  readonly schema: 'simforge.golden-corpus/v1';
  readonly cases: readonly GoldenCase[];
}

export interface GoldenResult {
  readonly mapClosureDigest: string;
  readonly inputHash: string;
  readonly traceSha256: string;
  readonly ticks: number;
  readonly actors: number;
}

export interface GoldenManifest {
  readonly schema: typeof GOLDEN_MANIFEST_SCHEMA;
  readonly engineSemVer: string;
  readonly cases: Readonly<Record<string, GoldenResult>>;
}

export function readCorpus(file = GOLDEN_CORPUS): GoldenCorpus {
  return JSON.parse(readFileSync(file, 'utf8')) as GoldenCorpus;
}

export function readManifest(file = GOLDEN_MANIFEST): GoldenManifest | null {
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as GoldenManifest;
}

/** Where a case's map closure lives, or `null` when it is not available here. */
export function closureDir(testCase: GoldenCase): string | null {
  const committed = path.join(GOLDEN_ROOT, 'maps', testCase.map);
  if (testCase.tier === 'ci') return committed;
  const roots = process.env['SIMFORGE_GOLDEN_MAPS_ROOT']
    ? [process.env['SIMFORGE_GOLDEN_MAPS_ROOT']]
    : [DEV_ASSETS, path.join(path.dirname(DEV_ASSETS), 'map-bundles')];
  return roots.map((root) => path.join(root, testCase.map)).find(hasSimulationClosure) ?? null;
}

/** An installed map with every file its simulation closure needs, colliders included. */
function hasSimulationClosure(dir: string): boolean {
  const variants = path.join(dir, '3d', 'variants', 'manifest.json');
  if (!existsSync(path.join(dir, 'topology-index.json.gz')) || !existsSync(variants)) return false;
  try {
    const file = (JSON.parse(readFileSync(variants, 'utf8')) as { variants?: Record<string, { file?: unknown }> }).variants?.['static-colliders']?.file;
    return typeof file === 'string' && existsSync(path.join(dir, '3d', 'variants', file));
  } catch {
    return false;
  }
}

export function resolvedInputPath(testCase: GoldenCase): string {
  return testCase.source.kind === 'input'
    ? path.resolve(REPO_ROOT, testCase.source.path)
    : path.join(GOLDEN_ROOT, 'inputs', `${testCase.id}.input.json.gz`);
}

const bundles = new Map<string, Promise<MapBundle>>();

/** The simulation closure of a case's map, built the same way the editor builds it. */
export function loadCaseBundle(testCase: GoldenCase): Promise<MapBundle> {
  const dir = closureDir(testCase);
  if (!dir) throw new Error(`golden case ${testCase.id}: map ${testCase.map} is not installed`);
  let pending = bundles.get(dir);
  if (!pending) {
    pending = readInstalledMapClosureFiles(dir, testCase.map).then(createSimulationMapBundle);
    bundles.set(dir, pending);
  }
  return pending;
}

function readJsonMaybeGz(file: string): unknown {
  const bytes = readFileSync(file);
  const plain = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
  return JSON.parse(plain.toString('utf8'));
}

/** Blank-world base input, as the editor's scenario worker builds it (20 ms step). */
function blankWorldInput(mapId: string, clipSeconds: number): SimScenarioInput {
  return parseSimScenarioInput({
    mapId,
    clipSeconds,
    warmupSeconds: 0,
    dt: 0.02,
    seed: `ambient-world:${mapId}`,
    actors: [{
      id: 'ambient-world-seed',
      kind: 'static_object',
      static: true,
      initial: { pose: { x: 0, z: 0, headingRad: 0 }, speedMps: 0 },
      behavior: { route: { kind: 'polyline', points: [{ x: 0, z: 0 }, { x: 1, z: 0 }] } },
      tags: ['ambient:internal-clock'],
    }],
    physics: { mode: 'dynamic-v1' },
  });
}

/** Resolve a case to the exact input the engine runs. */
export async function resolveCaseInput(testCase: GoldenCase, bundle: MapBundle): Promise<SimScenarioInput> {
  const { source } = testCase;
  if (source.kind === 'input') {
    // Handed to the native parser as authored, exactly as the identity test does:
    // the TS schema's defaults are not part of what is being locked here.
    const document = readJsonMaybeGz(path.resolve(REPO_ROOT, source.path)) as Record<string, unknown>;
    return ('input' in document && 'manifest' in document ? document['input'] : document) as SimScenarioInput;
  }
  if (source.kind === 'template') {
    // Raw template text straight to the native compiler, as the identity test does.
    const text = readFileSync(path.resolve(REPO_ROOT, source.path), 'utf8');
    const compiled = engine().module.compileTemplate(text, bundle.native, source.siteId, source.drawIndex, null);
    const manifest = JSON.parse(compiled.manifestJson) as { feasible: boolean };
    if (!manifest.feasible) throw new Error(`golden case ${testCase.id}: template is infeasible at site ${source.siteId}`);
    return JSON.parse(compiled.input.toJson()) as SimScenarioInput;
  }
  const controls = bundle.controlPlan();
  const base = withEditablePhysicsDefault(blankWorldInput(testCase.map, source.clipSeconds));
  const withControls: SimScenarioInput = {
    ...base,
    signalPrograms: [...base.signalPrograms, ...controls.signalPrograms],
    roadControls: [...base.roadControls, ...controls.roadControls],
  };
  const generated = engine().materializeAmbientTraffic(withControls, bundle.graph, {
    version: 1,
    preset: source.preset,
    seed: source.seed,
    maxActors: source.maxActors ?? 128,
    radiusM: source.radiusM ?? 2000,
  } as never);
  const populated = JSON.parse(generated.scenario.toJson()) as SimScenarioInput;
  const actors = populated.actors.filter((actor) => actor.id !== 'ambient-world-seed');
  const input = { ...populated, actors: actors.length > 0 ? actors : populated.actors };
  return withBoundedSpeedCruiseRestoration(withStableHighSpeedWorldRoutes(input));
}

/** Run one case: resolve, simulate on the native addon, digest. */
export async function runCase(testCase: GoldenCase): Promise<{ result: GoldenResult; input: SimScenarioInput }> {
  const bundle = await loadCaseBundle(testCase);
  const input = await resolveCaseInput(testCase, bundle);
  const runtime = engine();
  const simulated = runtime.runSimulation(input, { graph: bundle.graph });
  const trace = runtime.trace(simulated.trace);
  const canonical = trace.toTrace();
  return {
    input,
    result: {
      mapClosureDigest: bundle.closureDigest,
      // The native input identity the trace header carries.
      inputHash: canonical.header.inputHash,
      traceSha256: trace.digest(),
      ticks: canonical.ticks.t.length,
      actors: Object.keys(canonical.ticks.actors).length,
    },
  };
}

export interface GoldenRun {
  readonly engineSemVer: string;
  readonly results: Readonly<Record<string, GoldenResult>>;
  readonly inputs: Readonly<Record<string, SimScenarioInput>>;
  readonly skipped: readonly string[];
}

export async function runCorpus(options: { readonly tiers?: readonly GoldenTier[]; readonly corpus?: GoldenCorpus } = {}): Promise<GoldenRun> {
  const corpus = options.corpus ?? readCorpus();
  const tiers = new Set(options.tiers ?? ['ci', 'local']);
  const results: Record<string, GoldenResult> = {};
  const inputs: Record<string, SimScenarioInput> = {};
  const skipped: string[] = [];
  for (const testCase of corpus.cases) {
    if (!tiers.has(testCase.tier) || !closureDir(testCase)) {
      skipped.push(testCase.id);
      continue;
    }
    const { result, input } = await runCase(testCase);
    results[testCase.id] = result;
    inputs[testCase.id] = input;
  }
  return { engineSemVer: engine().version().engineSemVer, results, inputs, skipped };
}

export interface GoldenFinding {
  readonly id: string;
  readonly field: keyof GoldenResult | 'missing';
  readonly expected: string | number | null;
  readonly actual: string | number | null;
}

export interface GoldenVerdict {
  readonly ok: boolean;
  /** The runtime's semver differs from the manifest's: goldens must be regenerated. */
  readonly semverChanged: boolean;
  /** Digests changed under an unchanged semver: the forbidden case. */
  readonly changedWithoutBump: readonly GoldenFinding[];
  readonly messages: readonly string[];
}

/** Compare a run with the committed manifest under the semver rule. */
export function judge(run: GoldenRun, manifest: GoldenManifest | null): GoldenVerdict {
  if (!manifest) {
    return { ok: false, semverChanged: false, changedWithoutBump: [], messages: ['no golden manifest: run `pnpm golden-traces:update`'] };
  }
  const findings: GoldenFinding[] = [];
  for (const [id, actual] of Object.entries(run.results)) {
    const expected = manifest.cases[id];
    if (!expected) {
      findings.push({ id, field: 'missing', expected: null, actual: actual.traceSha256 });
      continue;
    }
    for (const field of ['mapClosureDigest', 'inputHash', 'traceSha256', 'ticks', 'actors'] as const) {
      if (expected[field] !== actual[field]) findings.push({ id, field, expected: expected[field], actual: actual[field] });
    }
  }
  const semverChanged = manifest.engineSemVer !== run.engineSemVer;
  const messages: string[] = [];
  if (semverChanged) {
    messages.push(`ENGINE_SEM_VER is ${run.engineSemVer} but the golden manifest was produced under ${manifest.engineSemVer}: run \`pnpm golden-traces:update\` and commit fixtures/golden-traces/.`);
  }
  // A case whose map closure changed is a fixture change, not an engine change.
  const changedWithoutBump = semverChanged ? [] : findings.filter((f) => f.field !== 'missing' && f.field !== 'mapClosureDigest');
  for (const finding of changedWithoutBump) {
    messages.push(`${finding.id}: ${finding.field} changed (${String(finding.expected)} → ${String(finding.actual)}) without an ENGINE_SEM_VER bump (native/crates/simforge-core/src/lib.rs).`);
  }
  for (const finding of findings.filter((f) => f.field === 'missing' || f.field === 'mapClosureDigest')) {
    messages.push(`${finding.id}: ${finding.field === 'missing' ? 'not in the manifest' : 'map closure changed'}; run \`pnpm golden-traces:update\`.`);
  }
  return { ok: messages.length === 0, semverChanged, changedWithoutBump, messages };
}

/**
 * Write the manifest and the resolved ambient inputs. Refuses when a
 * trace or input digest changed but `ENGINE_SEM_VER` did not: bump it first.
 * Cases that were skipped (map not installed here) keep their previous entry.
 */
export function writeManifest(run: GoldenRun, previous: GoldenManifest | null, corpus: GoldenCorpus = readCorpus()): GoldenManifest {
  if (previous && previous.engineSemVer === run.engineSemVer) {
    const verdict = judge(run, previous);
    if (verdict.changedWithoutBump.length > 0) {
      throw new Error(`refusing to rewrite golden digests under unchanged ENGINE_SEM_VER ${run.engineSemVer}:\n${verdict.messages.join('\n')}`);
    }
  }
  const ids = new Set(corpus.cases.map((c) => c.id));
  const cases: Record<string, GoldenResult> = {};
  for (const id of [...ids].sort()) {
    const fresh = run.results[id];
    const kept = previous && previous.engineSemVer === run.engineSemVer ? previous.cases[id] : undefined;
    if (fresh) cases[id] = fresh;
    else if (kept) cases[id] = kept;
  }
  const manifest: GoldenManifest = { schema: GOLDEN_MANIFEST_SCHEMA, engineSemVer: run.engineSemVer, cases };
  writeFileSync(GOLDEN_MANIFEST, `${canonicalJsonPretty(manifest)}\n`);
  mkdirSync(path.join(GOLDEN_ROOT, 'inputs'), { recursive: true });
  for (const testCase of corpus.cases) {
    const input = run.inputs[testCase.id];
    // Only the public-map tier: a resolved input on a private map carries its
    // lane ids and coordinates, and private maps never enter the repository.
    if (testCase.tier !== 'ci' || testCase.source.kind === 'input' || !input) continue;
    // gzip with no name/mtime: the same input always writes the same bytes.
    writeFileSync(resolvedInputPath(testCase), gzipSync(Buffer.from(`${JSON.stringify(input)}\n`), { level: 9 }));
  }
  return manifest;
}
