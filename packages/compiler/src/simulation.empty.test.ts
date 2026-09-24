/**
 * A scenario with no authored actors (a map, optionally with background
 * traffic) simulates authoritatively: it resolves to the blank world the
 * editor's scenario worker previews (`emptyScenarioBaseInput`), instead of
 * failing `unsupported_portable_semantics`.
 *
 * Requires the built N-API addon and the Richmond Field Station dev assets
 * (plus the pinned SUMO runtime and SUMO derivative for the SUMO case).
 */

import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { contentHash, traceCarriesSumoTraffic } from '@simforge-oss/engine';
import { engine, loadSumoRuntime, sumoTrafficNetworkFromMembers } from '@simforge-oss/engine/node';

import {
  EMPTY_SCENARIO_CLOCK_ACTOR_ID,
  EMPTY_SCENARIO_SITE_ID,
  emptyScenarioBaseInput,
  emptyScenarioManifest,
  withoutRedundantEmptyScenarioClock,
} from './empty-scenario.js';
import { executionSourceInputDigest, resolveExecutionInput } from './execution-package.js';
import { DEV_ASSETS, readInstalledMapClosureFiles } from './maps.js';
import { prepareSumoTrafficStep, simulateAuthoritative, simulationMapClosureFromFiles } from './simulation.js';

const MAP_ID = 'richmond-field-station';
const mapDir = path.resolve(process.env['SIMFORGE_SIM_TEST_MAP_DIR'] ?? path.join(DEV_ASSETS, MAP_ID));
/** The map directory carries the static-collider artifact its variants manifest names (v1 or v2). */
function collidersInstalled(dir: string): boolean {
  const variants = path.join(dir, '3d', 'variants');
  if (!existsSync(path.join(variants, 'manifest.json'))) return false;
  const file = (JSON.parse(readFileSync(path.join(variants, 'manifest.json'), 'utf8')) as { variants?: Record<string, { file?: unknown }> })
    .variants?.['static-colliders']?.file;
  return typeof file === 'string' && existsSync(path.join(variants, file));
}

const runtimeDir = path.resolve(process.env['SIMFORGE_SUMO_RUNTIME_DIR'] ?? path.join(DEV_ASSETS, 'sumo-runtime'));
const mapAvailable = collidersInstalled(mapDir);
const sumoAvailable = mapAvailable
  && existsSync(path.join(runtimeDir, 'sumo.wasm'))
  && existsSync(path.join(mapDir, 'derived', 'sumo', 'sumo-network-manifest.json'));

async function emptyDocument(extensions: Record<string, unknown> = {}) {
  const template = JSON.parse(await readFile(new URL('./__fixtures__/richmond-map-bound.template.json', import.meta.url), 'utf8'));
  // A blank document names no metric subject (there is no role to name).
  const { metricSubject: _unused, ...rest } = template;
  return {
    ...rest,
    roles: [],
    choreography: { ...template.choreography, interactions: [] },
    extensions: { ...template.extensions, ...extensions },
  };
}

async function closure() {
  return simulationMapClosureFromFiles(await readInstalledMapClosureFiles(mapDir, MAP_ID), {
    mapVersionId: 'usmapv_test', mapAssetId: MAP_ID, browserClosureSha256: 'f'.repeat(64),
  });
}

describe.skipIf(!mapAvailable)('authoritative simulation of an empty scenario', () => {
  it('simulates the blank world when the document has no actors and no traffic', async () => {
    const mapClosure = await closure();
    const document = await emptyDocument();
    const simulation = simulateAuthoritative({ canonicalContent: document, closure: mapClosure });
    expect(simulation.provider).toBe('off');
    expect(simulation.trace.header.actorIds).toEqual([EMPTY_SCENARIO_CLOCK_ACTOR_ID]);
    expect(simulation.resolved.concrete.siteId).toBe(EMPTY_SCENARIO_SITE_ID);
    expect(simulation.trace.header.inputHash).toBe(simulation.resolvedInputDigest);
    expect(simulation.traceSha256).toMatch(/^[a-f0-9]{64}$/);
    // Deterministic: a second resolution is the same trace.
    expect(simulateAuthoritative({ canonicalContent: document, closure: mapClosure }).traceSha256).toBe(simulation.traceSha256);
  }, 120_000);

  it('resolves exactly the input the editor worker builds for a blank world', async () => {
    const mapClosure = await closure();
    const document = await emptyDocument();
    const bundle = mapClosure.bundle;
    // The editor worker's recipe (scenario-worker.ts), with the N-API runtime.
    const runtime = engine();
    const controls = bundle.controlPlan();
    const empty = emptyScenarioBaseInput(bundle.mapId);
    const base = JSON.parse(runtime.studioConcreteInput({
      ...empty,
      signalPrograms: [...empty.signalPrograms, ...controls.signalPrograms],
      roadControls: [...empty.roadControls, ...controls.roadControls],
    }, document).toJson());
    const generated = runtime.materializeAmbientTraffic(base, bundle.graph, { version: 1, preset: 'off', seed: 'execution-provider-off' });
    const editor = withoutRedundantEmptyScenarioClock({ input: JSON.parse(generated.scenario.toJson()), provenance: generated.provenance });
    const resolved = resolveExecutionInput(document, bundle, 'disabled');
    expect(contentHash(resolved.concrete.input)).toBe(contentHash(editor.input));
    expect(resolved.concrete.materialization).toEqual(emptyScenarioManifest(bundle.mapId, bundle.graph.digest, base));
    expect(executionSourceInputDigest(resolved.resolvedInput)).toMatch(/^[a-f0-9]{64}$/);
  }, 120_000);

  it('populates native City traffic and drops the clock body', async () => {
    const document = await emptyDocument({
      'studio.ambientTraffic.provider.v1': 'native',
      'studio.ambientTraffic.profile.v1': { version: 1, preset: 'city', seed: 'ambient-1' },
    });
    const simulation = simulateAuthoritative({ canonicalContent: document, closure: await closure() });
    expect(simulation.provider).toBe('native');
    expect(simulation.trace.header.actorIds).not.toContain(EMPTY_SCENARIO_CLOCK_ACTOR_ID);
    expect(simulation.trace.header.actorIds.length).toBeGreaterThan(0);
    expect(simulation.traffic?.ambient.mode).toBe('native');
  }, 120_000);

  it.skipIf(!sumoAvailable)('adds worker SUMO traffic to a map-only scenario', async () => {
    const document = await emptyDocument({
      'studio.ambientTraffic.provider.v1': 'sumo',
      'studio.ambientTraffic.profile.v1': { version: 1, preset: 'city', seed: 'ambient-1' },
    });
    const manifestBytes = await readFile(path.join(mapDir, 'derived', 'sumo', 'sumo-network-manifest.json'));
    const manifest = JSON.parse(manifestBytes.toString('utf8')) as { networkFile: string; sha256: string };
    const network = sumoTrafficNetworkFromMembers({
      manifest: manifestBytes,
      network: new Uint8Array(await readFile(path.join(mapDir, 'derived', 'sumo', manifest.networkFile))),
      expectedSha256: manifest.sha256,
    });
    const simulation = simulateAuthoritative({
      canonicalContent: document,
      closure: await closure(),
      trafficStep: await prepareSumoTrafficStep(document, await loadSumoRuntime(runtimeDir), network),
    });
    expect(simulation.provider).toBe('sumo');
    expect(traceCarriesSumoTraffic(simulation.trace)).toBe(true);
    const sumoIds = simulation.trace.header.actorIds.filter((id) => id.startsWith('sumo-'));
    expect(sumoIds.length).toBeGreaterThan(5);
    // The authored half is the blank world: the clock body only.
    expect(simulation.trace.header.actorIds.filter((id) => !id.startsWith('sumo-'))).toEqual([EMPTY_SCENARIO_CLOCK_ACTOR_ID]);
  }, 240_000);
});
