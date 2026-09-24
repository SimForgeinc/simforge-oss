/**
 * The simulate step with server-side SUMO (WS-E) on an installed map: the
 * authored actors are simulated with ambient traffic off, SUMO runs one-way
 * against that trace, and its vehicles are merged into the authoritative
 * trace. The key covers the SUMO step, the authored trace is unchanged by it,
 * and fresh SUMO modules reproduce the same bytes.
 *
 * Requires the built N-API addon, the pinned SUMO runtime
 * (`SIMFORGE_SUMO_RUNTIME_DIR` or `dev-assets/sumo-runtime`) and the Richmond
 * Field Station dev assets with their SUMO derivative
 * (`pnpm maps:sumo -- --map richmond-field-station`).
 */

import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { traceCarriesSumoTraffic } from '@simforge-oss/engine';
import { loadSumoRuntime, sumoTrafficNetworkFromMembers } from '@simforge-oss/engine/node';

import { DEV_ASSETS, readInstalledMapClosureFiles } from './maps.js';
import { prepareSumoTrafficStep, simulateAuthoritative, simulationMapClosureFromFiles } from './simulation.js';

const MAP_ID = 'richmond-field-station';
/** An installed map directory with its collider and SUMO derivatives (override with `SIMFORGE_SIM_TEST_MAP_DIR`). */
const mapDir = path.resolve(process.env['SIMFORGE_SIM_TEST_MAP_DIR'] ?? path.join(DEV_ASSETS, MAP_ID));
const runtimeDir = path.resolve(process.env['SIMFORGE_SUMO_RUNTIME_DIR'] ?? path.join(DEV_ASSETS, 'sumo-runtime'));
/** The map directory carries the static-collider artifact its variants manifest names (v1 or v2). */
function collidersInstalled(dir: string): boolean {
  const variants = path.join(dir, '3d', 'variants');
  if (!existsSync(path.join(variants, 'manifest.json'))) return false;
  const file = (JSON.parse(readFileSync(path.join(variants, 'manifest.json'), 'utf8')) as { variants?: Record<string, { file?: unknown }> })
    .variants?.['static-colliders']?.file;
  return typeof file === 'string' && existsSync(path.join(variants, file));
}

const available = existsSync(path.join(runtimeDir, 'sumo.wasm'))
  && existsSync(path.join(mapDir, 'derived', 'sumo', 'sumo-network-manifest.json'))
  && collidersInstalled(mapDir);

async function sumoDocument() {
  const template = JSON.parse(await readFile(new URL('./__fixtures__/richmond-map-bound.template.json', import.meta.url), 'utf8'));
  return {
    ...template,
    extensions: {
      ...template.extensions,
      'studio.ambientTraffic.provider.v1': 'sumo',
      // SUMO demand is vehicles only: no pedestrian or cyclist share.
      'studio.ambientTraffic.profile.v1': { version: 1, preset: 'city', seed: 'ambient-1', maxActors: 24, pedestrianShare: 0, cyclistShare: 0 },
    },
  };
}

async function network() {
  const manifestBytes = await readFile(path.join(mapDir, 'derived', 'sumo', 'sumo-network-manifest.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as { networkFile: string; sha256: string };
  return sumoTrafficNetworkFromMembers({
    manifest: manifestBytes,
    network: new Uint8Array(await readFile(path.join(mapDir, 'derived', 'sumo', manifest.networkFile))),
    expectedSha256: manifest.sha256,
  });
}

describe.skipIf(!available)('authoritative simulation with worker SUMO traffic', () => {
  it('merges SUMO vehicles into the trace, keys the step and reproduces it from fresh modules', async () => {
    const closure = await simulationMapClosureFromFiles(await readInstalledMapClosureFiles(mapDir, MAP_ID), {
      mapVersionId: 'usmapv_test', mapAssetId: MAP_ID, browserClosureSha256: 'f'.repeat(64),
    });
    const document = await sumoDocument();
    const sumoNetwork = await network();

    const authoredOnly = simulateAuthoritative({ canonicalContent: document, closure });
    expect(authoredOnly.provider).toBe('sumo');
    expect(authoredOnly.trafficStepKey).toBeNull();
    expect(authoredOnly.traffic).toBeNull();

    const run = async () => simulateAuthoritative({
      canonicalContent: document,
      closure,
      trafficStep: await prepareSumoTrafficStep(document, await loadSumoRuntime(runtimeDir), sumoNetwork),
    });
    const first = await run();
    const second = await run();

    expect(traceCarriesSumoTraffic(first.trace)).toBe(true);
    expect(first.trace.header.actorIds.length).toBeGreaterThan(authoredOnly.trace.header.actorIds.length);
    // One-way coupling: the authored trace is exactly the ambient-off run.
    expect(first.authoredTraceSha256).toBe(authoredOnly.traceSha256);
    expect(first.traceSha256).not.toBe(first.authoredTraceSha256);
    // The key covers the SUMO step; the evidence is the SUMO artifact.
    expect(first.trafficStepKey).toMatch(/^[a-f0-9]{64}$/);
    expect(first.simKey).not.toBe(authoredOnly.simKey);
    expect(first.traffic?.ambient.mode).toBe('sumo');
    expect(first.traffic?.ambient.resultSha256).toBe(first.traffic?.envelope.sha256);
    // Fresh SUMO modules: the same bytes.
    expect(second.traceSha256).toBe(first.traceSha256);
    expect(second.trafficStepKey).toBe(first.trafficStepKey);
    expect(second.simKey).toBe(first.simKey);
  }, 240_000);
});
