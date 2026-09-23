import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..', '..', '..');
const read = <T>(path: string): T => JSON.parse(readFileSync(resolve(repo, path), 'utf8')) as T;

const native = read<{ entries: Record<string, { model: { glbPath: string } }> }>('catalog/vehicles-carla/catalog-models.json').entries;
const blueprints = read<{ models: Record<string, { blueprintId: string }> }>('catalog/vehicles-carla/carla-blueprints.json').models;
const substitutions = read<{ substitutions: Record<string, { native: string; carla: string | null; reason: string }> }>(
  'catalog/vehicles-carla/carla-substitutions.json',
).substitutions;
const carla = read<{ equivalents: { catalogId: string; blueprintId: string }[] }>('studio/app/generated/carla-object-catalog.json');
const carlaById = new Map(carla.equivalents.map((equivalent) => [equivalent.catalogId, equivalent.blueprintId]));

const modelKey = (glbPath: string): string => glbPath.replace(/^.*\//, '').replace(/\.glb$/, '');

describe('native and CARLA renderers draw the same source model', () => {
  const ids = [...new Set([
    ...Object.keys(native),
    ...carla.equivalents.map((equivalent) => equivalent.catalogId).filter((id) => id.startsWith('vehicle.')),
  ])].sort();

  for (const id of ids) {
    it(id, () => {
      const nativeKey = native[id] ? modelKey(native[id]!.model.glbPath) : null;
      const nativeBlueprint = nativeKey ? blueprints[nativeKey]?.blueprintId ?? null : null;
      const carlaBlueprint = carlaById.get(id) ?? null;
      const recorded = substitutions[id];
      if (nativeKey !== null && nativeBlueprint === carlaBlueprint) {
        expect(recorded, `${id} renders the same model in both; drop its substitution record`).toBeUndefined();
        return;
      }
      expect(recorded, `${id}: native ${nativeKey} (${nativeBlueprint}) vs CARLA ${carlaBlueprint}; align or record`).toBeDefined();
      expect(recorded!.native).toBe(nativeKey);
      expect(recorded!.carla).toBe(carlaBlueprint);
      expect(recorded!.reason.length).toBeGreaterThan(20);
    });
  }

  it('two-wheelers are never substituted', () => {
    for (const id of ['vehicle.bicycle', 'vehicle.motorcycle']) {
      expect(substitutions[id]).toBeUndefined();
      expect(blueprints[modelKey(native[id]!.model.glbPath)]?.blueprintId).toBe(carlaById.get(id));
    }
  });

  it('records no stale substitutions', () => {
    for (const id of Object.keys(substitutions)) expect(ids).toContain(id);
  });
});
