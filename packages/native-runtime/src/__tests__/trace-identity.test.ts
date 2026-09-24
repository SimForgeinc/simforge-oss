/**
 * Native (N-API) and WASM builds produce byte-identical traces.
 *
 * The editor simulates in the browser on the WASM build; workers, the CLI and
 * the compiler simulate on the N-API addon. A trace digest is a cache key
 * (`simforge.sim-key/v1`) and the editor shows "Verified" only when its local
 * digest equals the authoritative one, so the two builds must be one engine at
 * the byte level, not just "close". `build-agreement.test.ts` covers input
 * identity; this covers the whole pipeline on the golden-trace corpus
 * (`fixtures/golden-traces/`):
 *
 * 1. the map closure: both builds assemble the same bundle from the same files
 *    (same `closureDigest`), equal to the one the golden manifest recorded
 *    through the editor's own loader (`buildSimulationMapClosure`);
 * 2. input resolution: `materializeAmbientTraffic` and `compileTemplate` (at a
 *    pinned site: catalog resolution, seeding, materialization) return the same
 *    input in both builds;
 * 3. simulation: the canonical trace JSON is byte-identical, and its digest is
 *    the manifest's `traceSha256`.
 *
 * CI runs the `ci` tier (committed Richmond closure, including a case that
 * drives into a building's static collider). Set SIMFORGE_GOLDEN_TIERS=all to
 * also run the `local` tier on installed private maps.
 *
 * Requires both artifacts (`pnpm --filter @simforge-oss/native-runtime build`).
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { native } from '../index.js';
import { loadNative } from '../browser.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
const GOLDEN = join(REPO, 'fixtures', 'golden-traces');
const WASM = join(HERE, '..', '..', 'wasm', 'simforge_native_runtime_bg.wasm');

interface GoldenCase {
  id: string;
  tier: 'ci' | 'local';
  map: string;
  source:
    | { kind: 'input'; path: string }
    | { kind: 'template'; path: string; siteId: string; drawIndex: number }
    | { kind: 'ambient'; preset: string; seed: string; clipSeconds: number; maxActors?: number; radiusM?: number };
}
interface GoldenResult { mapClosureDigest: string; traceSha256: string; inputHash: string }

/** The slice of either build this test drives. */
interface Build {
  engineSemVer?(): string;
  engineVersion(): string;
  MapBundle: { fromSources(sources: string, topology: Uint8Array): Bundle };
  ScenarioInput: { parse(document: string): Scenario };
  Trace: { parse(bytes: Uint8Array): { digest(): string; toJson(): string } };
  runSimulation(input: Scenario, graph: unknown, options?: string | null): string;
  materializeAmbientTraffic(input: Scenario, graph: unknown, profile: string, options?: string | null): [Scenario, string] | unknown[];
  compileTemplate(template: string, bundle: Bundle, site?: string | null, seed?: number | string | null, options?: string | null): { input: Scenario; manifestJson: string };
  ambientTurnVerdictsJson?(graph: unknown): string;
  studioConcreteInput?(input: Scenario, templateJson: string): Scenario;
  executionRefinements?(input: Scenario): Scenario;
}
interface Bundle { closureDigest?: string; graph: unknown; controlPlanJson(): string; attachGround?(groundMesh: Uint8Array): string }
interface Scenario { toJson(): string }

const corpus = existsSync(join(GOLDEN, 'corpus.json'))
  ? (JSON.parse(readFileSync(join(GOLDEN, 'corpus.json'), 'utf8')) as { cases: GoldenCase[] }).cases
  : [];
const manifest = existsSync(join(GOLDEN, 'manifest.json'))
  ? (JSON.parse(readFileSync(join(GOLDEN, 'manifest.json'), 'utf8')) as { engineSemVer: string; cases: Record<string, GoldenResult> })
  : null;
const tiers = process.env['SIMFORGE_GOLDEN_TIERS'] === 'all' ? new Set(['ci', 'local']) : new Set(['ci']);

/** The map directory carries the static-collider artifact its variants manifest names (v1 or v2). */
function collidersInstalled(dir: string): boolean {
  const variants = join(dir, '3d', 'variants');
  if (!existsSync(join(variants, 'manifest.json'))) return false;
  const file = (JSON.parse(readFileSync(join(variants, 'manifest.json'), 'utf8')) as { variants?: Record<string, { file?: unknown }> })
    .variants?.['static-colliders']?.file;
  return typeof file === 'string' && existsSync(join(variants, file));
}

function plain(file: string): Uint8Array {
  for (const candidate of [file, `${file}.gz`]) {
    if (!existsSync(candidate)) continue;
    const bytes = readFileSync(candidate);
    return new Uint8Array(bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes);
  }
  throw new Error(`missing ${file}`);
}

function mapDir(testCase: GoldenCase): string | null {
  if (testCase.tier === 'ci') return join(GOLDEN, 'maps', testCase.map);
  const data = process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share');
  const roots = process.env['SIMFORGE_GOLDEN_MAPS_ROOT']
    ? [process.env['SIMFORGE_GOLDEN_MAPS_ROOT']]
    : [join(process.env['SIMFORGE_MAPS_CACHE_ROOT'] ?? join(data, 'simforge', 'maps'), 'dev-assets'), join(process.env['SIMFORGE_MAPS_CACHE_ROOT'] ?? join(data, 'simforge', 'maps'), 'map-bundles')];
  return roots.map((root) => join(root, testCase.map)).find((dir) => collidersInstalled(dir)) ?? null;
}

/**
 * The same sources the editor hands `MapBundle.fromSources`. Colliders go in
 * unfiltered: the native bundle applies the road-boundary rule itself, so this
 * also proves that rule lives in one place.
 */
function closureSources(dir: string, mapId: string): { sources: string; topology: Uint8Array } {
  const text = (relative: string) => new TextDecoder().decode(plain(join(dir, relative)));
  const variants = JSON.parse(text(join('3d', 'variants', 'manifest.json'))) as { variants: Record<string, { file: string }> };
  const artifact = JSON.parse(text(join('3d', 'variants', variants.variants['static-colliders']!.file))) as { colliders: unknown[] };
  return {
    sources: JSON.stringify({
      mapId,
      derived: JSON.parse(text(join('derived', 'topology-derived.json'))),
      locations: JSON.parse(text(join('derived', 'locations.json'))),
      xodr: text('map.xodr'),
      signalsGeojson: JSON.parse(text('signals.geojson')),
      staticColliders: artifact.colliders,
    }),
    topology: plain(join(dir, 'topology-index.json')),
  };
}

function inputPath(testCase: GoldenCase): string {
  return testCase.source.kind === 'input'
    ? join(REPO, testCase.source.path)
    : join(GOLDEN, 'inputs', `${testCase.id}.input.json`);
}

function inputDocument(testCase: GoldenCase): string {
  const value = JSON.parse(new TextDecoder().decode(plain(inputPath(testCase)))) as Record<string, unknown>;
  return JSON.stringify('input' in value && 'manifest' in value ? value['input'] : value);
}

function simulate(build: Build, bundle: Bundle, document: string): { canonical: string; digest: string } {
  const input = build.ScenarioInput.parse(document);
  const result = JSON.parse(build.runSimulation(input, bundle.graph, null)) as { trace: unknown };
  const trace = build.Trace.parse(new TextEncoder().encode(JSON.stringify(result.trace)));
  return { canonical: trace.toJson(), digest: trace.digest() };
}

const selected = corpus.filter((testCase) => tiers.has(testCase.tier) && mapDir(testCase) !== null);

describe.skipIf(!existsSync(WASM) || selected.length === 0)('N-API and WASM builds produce byte-identical traces on the golden corpus', async () => {
  const addon = native() as unknown as Build;
  const wasm = (await loadNative(readFileSync(WASM))) as unknown as Build;
  const bundles = new Map<string, { addon: Bundle; wasm: Bundle }>();
  const bundlesFor = (testCase: GoldenCase) => {
    const dir = mapDir(testCase)!;
    let pair = bundles.get(dir);
    if (!pair) {
      const { sources, topology } = closureSources(dir, testCase.map);
      pair = { addon: addon.MapBundle.fromSources(sources, topology), wasm: wasm.MapBundle.fromSources(sources, topology) };
      // The ground derivative is a simulation member when the version carries
      // it (compiler SIMULATION_MAP_MEMBERS, GROUND_MESH_MEMBER): attach it
      // before the graph is read, as the editor loader does
      // (playback mapRuntime), so the closure digest includes it.
      const groundPath = join(dir, 'derived', 'ground', 'ground-mesh.bin');
      if (existsSync(groundPath)) {
        const ground = new Uint8Array(readFileSync(groundPath));
        for (const bundle of [pair.addon, pair.wasm]) {
          if (!bundle.attachGround) throw new Error('This native runtime predates ground contact (engine 0.11.0); rebuild @simforge-oss/native-runtime');
          bundle.attachGround(ground);
        }
      }
      bundles.set(dir, pair);
    }
    return pair;
  };

  it('both builds apply the Studio refinements to the same input', () => {
    if (!addon.studioConcreteInput || !wasm.studioConcreteInput || !addon.executionRefinements || !wasm.executionRefinements) return;
    const route = { kind: 'polyline', points: [{ x: 0, z: 0 }, { x: 200, z: 0 }] };
    const document = JSON.stringify({
      mapId: 'refinements', clipSeconds: 10, warmupSeconds: 0, dt: 0.02, seed: 'refinements',
      actors: [
        { id: 'ego', kind: 'car', initial: { pose: { x: 0, z: 0, headingRad: 0 }, speedMps: 30 }, behavior: { cruiseSpeedMps: 30, route }, tags: ['role:ego', 'studio:body-color:#000000'] },
        { id: 'lead', kind: 'car', initial: { pose: { x: 40, z: 0, headingRad: 0 }, speedMps: 9 }, behavior: { cruiseSpeedMps: 9, route }, tags: ['role:lead'] },
      ],
      interactions: [
        { id: 'r', actorId: 'ego', trigger: { kind: 'at', t: 1 }, verb: 'route', target: { kind: 'polyline', points: [{ x: 10, z: 0 }, { x: 120, z: 30 }] }, joinFromCurrentPose: true, bestEffortWorldPath: true },
        { id: 's', actorId: 'lead', trigger: { kind: 'at', t: 1 }, window: { startS: 1, endS: 4 }, verb: 'speed', target: { mode: 'absolute', value: 3 }, dynamics: { shape: 'linear', constraint: 'rate', value: 2 } },
      ],
    });
    const car = (id: string, x: number, h: number) => ({ id, stallId: id, catalogId: 'vehicle.sedan', x, y: 0, z: 12, headingRad: h, lengthM: 4.6, widthM: 1.85, heightM: 1.5 });
    const template = JSON.stringify({
      roles: [{ id: 'ego', extensions: { 'studio.presentation.bodyColor': 'rgb(12, 200, 7)' } }, { id: 'lead', extensions: { 'studio.presentation.bodyColor': '#AbC' } }],
      extensions: { 'studio.ambientTraffic.parkedCars.v1': { baked: [car('parked:b', 30, 0.7), car('parked:a', 60, 2.1)] } },
    });
    const refine = (build: Build) => build.executionRefinements!(build.studioConcreteInput!(build.ScenarioInput.parse(document), template)).toJson();
    const fromAddon = refine(addon);
    expect(refine(wasm)).toBe(fromAddon);
    expect(fromAddon).toContain('restore-cruise-s');
    expect(fromAddon).toContain('parked:a');
    expect(fromAddon).toContain('studio:body-color:#0cc807');
  });

  it('both builds report one engine semantics version, the manifest\'s', () => {
    const semver = (build: Build) => build.engineSemVer?.() ?? build.engineVersion();
    expect(semver(wasm)).toBe(semver(addon));
    if (manifest) expect(semver(addon)).toBe(manifest.engineSemVer);
  });

  // One describe per case, split into steps: a long synchronous WASM run in a
  // single test starves vitest's worker RPC, and steps also say which stage broke.
  for (const testCase of selected) {
    describe(testCase.id, () => {
      const expected = manifest?.cases[testCase.id];
      let fromAddon: { canonical: string; digest: string } | null = null;

      it('builds one map closure in both builds, equal to the editor loader\'s', () => {
        const pair = bundlesFor(testCase);
        expect(pair.wasm.closureDigest).toBeTruthy();
        expect(pair.wasm.closureDigest).toBe(pair.addon.closureDigest);
        if (expected) expect(pair.addon.closureDigest).toBe(expected.mapClosureDigest);
      });

      it.skipIf(testCase.source.kind !== 'ambient')('generates the same ambient traffic in both builds', () => {
        if (testCase.source.kind !== 'ambient') return;
        const pair = bundlesFor(testCase);
        const { source } = testCase;
        const controls = JSON.parse(pair.addon.controlPlanJson()) as { signalPrograms: unknown[]; roadControls: unknown[] };
        const base = JSON.stringify({
          mapId: testCase.map,
          clipSeconds: source.clipSeconds,
          warmupSeconds: 0,
          dt: 0.02,
          seed: `ambient-world:${testCase.map}`,
          actors: [{
            id: 'ambient-world-seed', kind: 'static_object', static: true,
            initial: { pose: { x: 0, z: 0, headingRad: 0 }, speedMps: 0 },
            behavior: { route: { kind: 'polyline', points: [{ x: 0, z: 0 }, { x: 1, z: 0 }] } },
            tags: ['ambient:internal-clock'],
          }],
          physics: { mode: 'dynamic-v1' },
          signalPrograms: controls.signalPrograms,
          roadControls: controls.roadControls,
        });
        const profile = JSON.stringify({ version: 1, preset: source.preset, seed: source.seed, maxActors: source.maxActors ?? 128, radiusM: source.radiusM ?? 2000 });
        const generated = (build: Build, bundle: Bundle) => {
          const [scenario, provenance] = build.materializeAmbientTraffic(build.ScenarioInput.parse(base), bundle.graph, profile, null) as [Scenario, string];
          return `${scenario.toJson()}\n${provenance}`;
        };
        expect(generated(wasm, pair.wasm)).toBe(generated(addon, pair.addon));
        // The persisted turn-verdict table (a cross-session cache) is one table
        // whichever build wrote it, so either build may load the other's.
        if (addon.ambientTurnVerdictsJson && wasm.ambientTurnVerdictsJson) {
          const table = addon.ambientTurnVerdictsJson(pair.addon.graph);
          expect(JSON.parse(table).verdicts.length).toBeGreaterThan(0);
          expect(wasm.ambientTurnVerdictsJson(pair.wasm.graph)).toBe(table);
        }
      }, 300_000);

      it.skipIf(testCase.source.kind !== 'template')('compiles the template to the same input in both builds', () => {
        if (testCase.source.kind !== 'template') return;
        const { source } = testCase;
        const pair = bundlesFor(testCase);
        const text = readFileSync(join(REPO, source.path), 'utf8');
        const compiled = (build: Build, bundle: Bundle) => {
          const result = build.compileTemplate(text, bundle, source.siteId, source.drawIndex, null);
          return `${result.input.toJson()}\n${result.manifestJson}`;
        };
        const fromAddon = compiled(addon, pair.addon);
        expect(compiled(wasm, pair.wasm)).toBe(fromAddon);
        // The committed resolved input is what this build compiles today.
        expect(JSON.parse(fromAddon.split('\n')[0]!)).toEqual(JSON.parse(inputDocument(testCase)));
      }, 300_000);

      it('applies the execution refinements identically in both builds', () => {
        if (!addon.executionRefinements || !wasm.executionRefinements) return;
        const refined = (build: Build) => build.executionRefinements!(build.ScenarioInput.parse(inputDocument(testCase))).toJson();
        expect(refined(wasm)).toBe(refined(addon));
      });

      it('simulates on the N-API addon to the manifest digest', () => {
        fromAddon = simulate(addon, bundlesFor(testCase).addon, inputDocument(testCase));
        if (expected) expect(fromAddon.digest).toBe(expected.traceSha256);
      }, 300_000);

      it('simulates on WASM to the same bytes', () => {
        const fromWasm = simulate(wasm, bundlesFor(testCase).wasm, inputDocument(testCase));
        expect(fromAddon).not.toBeNull();
        expect(fromWasm.digest).toBe(fromAddon!.digest);
        expect(fromWasm.canonical === fromAddon!.canonical).toBe(true);
      }, 300_000);
    });
  }
});
