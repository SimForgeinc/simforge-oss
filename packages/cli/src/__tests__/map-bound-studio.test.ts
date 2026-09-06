/**
 * Map-bound (`scene_absolute`) Studio documents compile without site matching
 * and execute in the native runtime. Requires installed map assets and the
 * built N-API addon.
 */

import { compileTemplate, loadMap } from '@simforge-oss/compiler/node';
import { runSimulation } from '@simforge-oss/engine/node';
import { parseTemplate, TemplateDocument } from '@simforge-oss/scenario';
import { describe, expect, it } from 'vitest';

import { localMapAssetRequirement } from './asset-test-utils.js';

const studioMapAssets = localMapAssetRequirement(['yale-st-palo-alto-ca', 'belmont-office-park-belmont-ca']);

function xy(point: { x: number; y: number } | readonly [number, number]): { x: number; y: number } {
  return Array.isArray(point) ? { x: point[0]!, y: point[1]! } : point as { x: number; y: number };
}

describe.skipIf(!studioMapAssets.available)(`map-bound Studio materialization${studioMapAssets.missingReason}`, () => {
  it('materializes a browser-created fresh scenario with no actors', async () => {
    const bundle = await loadMap('belmont-office-park-belmont-ca');
    const document = TemplateDocument.create({
      name: 'Fresh Belmont scenario',
      sourceMap: { mapId: bundle.mapId, mapName: 'Belmont Research Center' },
      anchor: { features: [], pin: { mapId: bundle.mapId } },
    });
    document.setClip(undefined, 0);

    const product = compileTemplate(parseTemplate(document.toJSON()), bundle, null);

    expect(product.manifest.feasible).toBe(true);
    expect(product.manifest.replayKey.siteId).toBe(`studio:${bundle.mapId}`);
    expect(product.input.actors).toEqual([]);
    expect(product.input.clipSeconds).toBe(20);
  }, 30_000);

  it('materializes a freshly placed v2 vehicle and simulates the exact clip duration', async () => {
    const bundle = await loadMap('yale-st-palo-alto-ca');
    const lane = Object.values(bundle.topology.lanes)
      .filter((candidate) => candidate.laneType === 'driving' && candidate.polyline.length >= 2)
      .sort((a, b) => a.rsl.localeCompare(b.rsl))[0]!;
    const point = xy(lane.polyline[0]!);
    const next = xy(lane.polyline[1]!);
    const headingRad = Math.atan2(next.y - point.y, next.x - point.x);
    const doc = TemplateDocument.create({
      name: 'fresh Studio placement',
      sourceMap: { mapId: bundle.mapId, mapName: bundle.mapId },
      anchor: { features: [], pin: { mapId: bundle.mapId } },
    });
    doc.addRole({
      id: 'vehicle-1',
      kind: 'scene_absolute',
      actor: { class: 'car', catalogId: 'vehicle.sedan', static: false, sensors: [] },
      pose: { position: { x: point.x, y: 0, z: -point.y }, headingRad },
      laneRef: { roadId: String(lane.roadId), section: lane.section, laneId: lane.laneId, s: 0, t: 0, headingOffsetRad: 0 },
      essentiality: 'required',
    });
    const product = compileTemplate(parseTemplate(doc.toJSON()), bundle, null);
    expect(product.manifest.notes).toEqual([]);
    expect(product.input.actors.map((actor) => actor.id)).toEqual(['vehicle-1']);
    const result = runSimulation(product.scenario, { graph: bundle.graph });
    expect(result.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(result.trace.ticks.t.at(-1)).toBe(product.input.clipSeconds);
    expect(result.trace.header.inputHash).toBe(product.manifest.inputHash);
  }, 30_000);

  it('uses the full choreography and prop compiler for authored map-bound actors', async () => {
    const bundle = await loadMap('yale-st-palo-alto-ca');
    const lane = Object.values(bundle.topology.lanes)
      .filter((candidate) => candidate.laneType === 'driving' && candidate.polyline.length >= 2 && candidate.polyline.length >= 2)
      .sort((a, b) => b.polyline.length - a.polyline.length || a.rsl.localeCompare(b.rsl))[0]!;
    const point = xy(lane.polyline[0]!);
    const next = xy(lane.polyline[1]!);
    const headingRad = Math.atan2(next.y - point.y, next.x - point.x);
    const doc = TemplateDocument.create({
      name: 'Studio choreography',
      sourceMap: { mapId: bundle.mapId, mapName: bundle.mapId },
      anchor: { features: [], pin: { mapId: bundle.mapId } },
    });
    const role = (id: string, s: number) => ({
      id,
      kind: 'scene_absolute' as const,
      actor: { class: 'car' as const, catalogId: 'vehicle.sedan', static: false, sensors: [] },
      pose: { position: { x: point.x, y: 0, z: -point.y }, headingRad },
      laneRef: { roadId: String(lane.roadId), section: lane.section, laneId: lane.laneId, s, t: 0, headingOffsetRad: 0 },
      essentiality: 'required' as const,
    });
    doc.addRole(role('vehicle-1', 0));
    doc.addRole(role('vehicle-2', Math.min(20, bundle.graph.laneLengthM(lane.rsl) / 2)));
    doc.addInteraction({
      id: 'accelerate', actor: 'vehicle-1', verb: 'speed', trigger: { kind: 'at', t: 1 },
      target: { mode: 'absolute', valueKph: 8 }, dynamics: { shape: 'linear', constraint: 'time', value: 1 },
      until: { kind: 'when', condition: { kind: 'speed', of: 'vehicle-1', op: '>=', valueKph: 7 }, byLatest: 4, ifNever: 'fire' },
    });
    doc.addInteraction({
      id: 'indicator', actor: 'vehicle-1', verb: 'set',
      trigger: { kind: 'after', of: 'accelerate', event: 'start', delayS: 0.2 },
      target: { key: 'lights.indicator', value: 'left' },
    });
    doc.addInteraction({
      id: 'despawn', actor: 'vehicle-2', verb: 'exist',
      trigger: { kind: 'when', condition: { kind: 'distance', from: 'vehicle-1', to: { role: 'vehicle-2' }, measure: 'euclidean', op: '<=', valueM: 100 }, byLatest: 2, ifNever: 'fire' },
      target: { state: 'absent' },
    });
    doc.addInteraction({
      id: 'offset', actor: 'vehicle-1', verb: 'laneOffset', trigger: { kind: 'at', t: 3 },
      target: { tFrac: 0.2, reference: 'lane_center' }, dynamics: { shape: 'sinusoidal', constraint: 'time', value: 1 },
    });
    doc.addInteraction({
      id: 'reroute', actor: 'vehicle-1', verb: 'route', trigger: { kind: 'at', t: 5 },
      target: { mode: 'polyline', points: [
        { laneOffset: 0, s: 10, tFrac: 0, headingOffsetRad: 0 },
        { laneOffset: 0, s: 40, tFrac: 0, headingOffsetRad: 0 },
      ] },
    });
    const template = parseTemplate({
      ...doc.toJSON(),
      props: [{ id: 'box-1', catalogId: 'hazard.cardboard_box', pose: { laneOffset: 0, s: 30, tFrac: 0, headingOffsetRad: 0 }, essentiality: 'required' }],
    });
    const product = compileTemplate(template, bundle, null);
    expect(product.input.interactions.map((interaction) => interaction.id).sort()).toEqual(
      ['accelerate', 'despawn', 'indicator', 'offset', 'reroute'].sort(),
    );
    expect(product.input.props.map((prop) => prop.id)).toEqual(['box-1']);
    const result = runSimulation(product.scenario, { graph: bundle.graph });
    expect(result.trace.events.some((event) => event.kind === 'state_set' && event.actorId === 'vehicle-1')).toBe(true);
    expect(result.trace.ticks.actors['vehicle-2']!.present.at(-1)).toBe(0);
    expect(result.trace.ticks.t.at(-1)).toBe(product.input.clipSeconds);
  }, 30_000);

  it('resolves arrival triggers and compiles lane changes on authored lane actors', async () => {
    const bundle = await loadMap('yale-st-palo-alto-ca');
    const lane = Object.values(bundle.topology.lanes)
      .filter((candidate) => candidate.laneType === 'driving' && candidate.polyline.length >= 2)
      .find((candidate) => candidate.adjacentLanes?.left?.sameDirection || candidate.adjacentLanes?.right?.sameDirection)!;
    const point = xy(lane.polyline[0]!);
    const next = xy(lane.polyline[1]!);
    const headingRad = Math.atan2(next.y - point.y, next.x - point.x);
    const doc = TemplateDocument.create({
      name: 'Studio arrival and lane change',
      sourceMap: { mapId: bundle.mapId, mapName: bundle.mapId },
      anchor: { features: [], pin: { mapId: bundle.mapId } },
    });
    for (const [id, s] of [['vehicle-1', 0], ['vehicle-2', 20]] as const) {
      doc.addRole({
        id, kind: 'scene_absolute', actor: { class: 'car', catalogId: 'vehicle.sedan', static: false, sensors: [] }, initialSpeedKph: 12,
        pose: { position: { x: point.x, y: 0, z: -point.y }, headingRad },
        laneRef: { roadId: String(lane.roadId), section: lane.section, laneId: lane.laneId, s, t: 0, headingOffsetRad: 0 },
        essentiality: 'required',
      });
    }
    doc.addInteraction({
      id: 'arrival-brake', actor: 'vehicle-1', verb: 'speed',
      trigger: {
        kind: 'arrival', of: 'vehicle-1',
        at: { pose: { laneOffset: 0, s: 60, tFrac: 0, headingOffsetRad: 0 } },
        syncWith: 'vehicle-2', deltaT: 1,
      },
      target: { mode: 'stop' }, dynamics: { shape: 'linear', constraint: 'time', value: 2 },
    });
    doc.addInteraction({
      id: 'change-lane', actor: 'vehicle-1', verb: 'changeLane', trigger: { kind: 'at', t: 4 },
      target: { mode: 'relative', dk: lane.adjacentLanes?.left?.sameDirection ? 1 : -1 },
      dynamics: { shape: 'sinusoidal', constraint: 'time', value: 2 },
    });
    const product = compileTemplate(parseTemplate(doc.toJSON()), bundle, null);
    expect(product.manifest.arrival.some((solution) => solution.interactionId === 'arrival-brake')).toBe(true);
    expect(product.input.interactions.find((interaction) => interaction.id === 'arrival-brake')?.trigger.kind).toBe('at');
    expect(product.input.interactions.find((interaction) => interaction.id === 'change-lane')).toMatchObject({ verb: 'changeLane' });
  }, 30_000);

});
