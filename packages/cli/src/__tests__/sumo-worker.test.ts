/**
 * The worker SUMO step on real maps: byte identity across fresh WASM modules,
 * SUMO obeying the SimForge signal book at every step, and no SUMO vehicle
 * crossing a stop line while the rendered head for its movement is red.
 *
 * Requires the pinned SUMO runtime, the Richmond Field Station and Yale Street
 * SUMO derivatives (`pnpm maps:sumo -- --map richmond-field-station,yale-street`)
 * and the built N-API addon.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

import { compileTemplate, DEV_ASSETS, findSite, loadMap, readTemplate, REPO_ROOT } from '@simforge-oss/compiler/node';
import { resolveAmbientTrafficProfile, type SimScenarioInput } from '@simforge-oss/engine';
import { describe, expect, it } from 'vitest';

import {
  loadInstalledSumoNetwork,
  loadInstalledSumoRuntime,
  runWorkerSumo,
  sumoExecutionInput,
  sumoRuntimeDirectory,
} from '../sumo-headless.js';

const CASES = [
  { mapId: 'richmond-field-station', template: 'ltap-opposing', site: '3dd7bb59d80de7ee' },
  { mapId: 'yale-street', template: 'cpnco-dartout', site: '76ccc9f31af219de' },
] as const;

const available = existsSync(path.join(sumoRuntimeDirectory(), 'sumo.wasm'))
  && CASES.every(({ mapId }) => existsSync(path.join(DEV_ASSETS, mapId, 'derived', 'sumo', 'sumo-network-manifest.json')));

async function scenario(mapId: string, template: string, siteId: string, clipSeconds: number) {
  const bundle = await loadMap(mapId);
  const document = await readTemplate(path.join(REPO_ROOT, 'examples', `${template}.template.json`));
  const { site } = await findSite(document, mapId, siteId);
  const product = compileTemplate(document, bundle, site, { drawIndex: 0 });
  const input: SimScenarioInput = { ...sumoExecutionInput(product.input, bundle), clipSeconds };
  return { bundle, input };
}

const profile = resolveAmbientTrafficProfile({ version: 1, preset: 'city', seed: 'ambient-1', maxActors: 48 });

describe.skipIf(!available)('worker SUMO traffic on installed maps', () => {
  for (const { mapId, template, site } of CASES) {
    it(`${mapId}: identical bytes from fresh modules, signal book obeyed, no red-light crossings`, async () => {
      const { bundle, input } = await scenario(mapId, template, site, 40);
      const runtime = await loadInstalledSumoRuntime();
      const network = await loadInstalledSumoNetwork(mapId);
      const map = { assetId: mapId, versionId: 'test' };
      const first = await runWorkerSumo({ input, bundle, profile, map, runtime, network });
      const second = await runWorkerSumo({ input, bundle, profile, map, runtime, network });

      expect(second.traffic.artifact.sha256).toBe(first.traffic.artifact.sha256);
      expect(Buffer.from(second.traffic.artifact.bytes).equals(Buffer.from(first.traffic.artifact.bytes))).toBe(true);
      expect(second.traffic.key).toBe(first.traffic.key);
      expect(second.traceSha256).toBe(first.traceSha256);
      expect(first.traffic.artifact.artifact.actors.length).toBeGreaterThan(10);

      const diagnostics = first.traffic.diagnostics;
      expect(diagnostics.runtime.version).toBe('1.27.1-7717f237');
      expect(diagnostics.float32UlpM).toBeLessThanOrEqual(1.25e-4);
      // SUMO's live link states equal the book at every clip step.
      expect(diagnostics.signalAgreement.samples).toBeGreaterThan(0);
      expect(diagnostics.signalAgreement.mismatches).toBe(0);
      expect(diagnostics.teleports).toBe(0);

      // Every SUMO stop-line crossing of a governed movement happens off red.
      expect(first.signalAudit.redViolations).toEqual([]);

      // Authored tracks are untouched by the merge (one-way coupling).
      for (const id of Object.keys(first.authoredTrace.ticks.actors)) {
        expect(first.trace.ticks.actors[id]).toBe(first.authoredTrace.ticks.actors[id]);
      }
      expect(first.trace.ticks.signals).toBe(first.authoredTrace.ticks.signals);
    }, 240_000);
  }

  it('netconvert\'s own programs, by contrast, send SUMO through rendered reds on Yale', async () => {
    const { mapId, template, site } = CASES[1];
    const { bundle, input } = await scenario(mapId, template, site, 60);
    const run = await runWorkerSumo({ input, bundle, profile, map: { assetId: mapId, versionId: 'test' }, signalAuthority: 'netconvert' });
    expect(run.traffic.diagnostics.signalAgreement.mismatches).toBeGreaterThan(0);
    expect(run.signalAudit.redViolations.length).toBeGreaterThan(0);
  }, 240_000);
});
