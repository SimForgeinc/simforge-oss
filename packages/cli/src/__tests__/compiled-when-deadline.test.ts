/**
 * A Studio `when` trigger's `byLatest` is the trigger's own deadline: with
 * `ifNever: 'fire'` the interaction fires at that time when the condition
 * never held (docs/engineering/openscenario-conformance.md F-03). The compiler
 * used to lower `byLatest` into a clip window end, whose gate skipped the
 * trigger first, so compiled documents never fired. Runs on the committed
 * Richmond Field Station closure; needs the built N-API addon.
 */

import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { compileTemplate, createSimulationMapBundle, readInstalledMapClosureFiles } from '@simforge-oss/compiler/node';
import { runSimulation } from '@simforge-oss/engine/node';
import { parseTemplate, TemplateDocument } from '@simforge-oss/scenario';
import { describe, expect, it } from 'vitest';

import { GOLDEN_ROOT } from '../determinism/golden-traces.js';

const ADDON_DIR = path.join(GOLDEN_ROOT, '..', '..', 'packages', 'native-runtime', 'native');
const haveAddon = existsSync(ADDON_DIR) && readdirSync(ADDON_DIR).some((file) => file.endsWith('.node'));

function xy(point: { x: number; y: number } | readonly [number, number]): { x: number; y: number } {
  return Array.isArray(point) ? { x: point[0]!, y: point[1]! } : point as { x: number; y: number };
}

describe.skipIf(!haveAddon)('compiled when-trigger deadline', () => {
  it('fires at byLatest when the condition never holds (ifNever: fire)', async () => {
    const mapId = 'richmond-field-station';
    const bundle = await createSimulationMapBundle(await readInstalledMapClosureFiles(path.join(GOLDEN_ROOT, 'maps', mapId), mapId));
    const lane = Object.values(bundle.topology.lanes)
      .filter((candidate) => candidate.laneType === 'driving' && candidate.polyline.length >= 2)
      .sort((a, b) => b.polyline.length - a.polyline.length || a.rsl.localeCompare(b.rsl))[0]!;
    const point = xy(lane.polyline[0]!);
    const next = xy(lane.polyline[1]!);
    const doc = TemplateDocument.create({
      name: 'deadline fire',
      sourceMap: { mapId, mapName: mapId },
      anchor: { features: [], pin: { mapId } },
    });
    doc.addRole({
      id: 'vehicle-1',
      kind: 'scene_absolute',
      actor: { class: 'car', catalogId: 'vehicle.sedan', static: false, sensors: [] },
      pose: { position: { x: point.x, y: 0, z: -point.y }, headingRad: Math.atan2(next.y - point.y, next.x - point.x) },
      laneRef: { roadId: String(lane.roadId), section: lane.section, laneId: lane.laneId, s: 0, t: 0, headingOffsetRad: 0 },
      essentiality: 'required',
    });
    doc.addInteraction({
      id: 'deadline', actor: 'vehicle-1', verb: 'set',
      trigger: { kind: 'when', condition: { kind: 'speed', of: 'vehicle-1', op: '>=', valueKph: 500 }, byLatest: 2, ifNever: 'fire' },
      target: { key: 'lights.brake', value: true },
    });
    const product = compileTemplate(parseTemplate(doc.toJSON()), bundle, null);
    expect(product.input.interactions.find((interaction) => interaction.id === 'deadline')).not.toHaveProperty('window');
    const result = runSimulation(product.scenario, { graph: bundle.graph });
    expect(result.trace.events.filter((event) => event.kind === 'trigger_fired' && event.interactionId === 'deadline'))
      .toEqual([expect.objectContaining({ t: 2, forced: true })]);
  }, 60_000);
});
