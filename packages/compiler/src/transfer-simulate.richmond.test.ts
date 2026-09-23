/**
 * A transferred scenario simulates. Transfer lifts a map-bound document into its portable form
 * (roles relative to the scenario's site: `on_reference` / `relative_to`) and pins it to a site on
 * the target map; the authoritative simulation must execute that pinned portable document exactly
 * as the editor's preview does (resolve the pinned site, compile there), instead of refusing it.
 *
 * Uses the committed Richmond Field Station closure (fixtures/golden-traces/maps) twice: as itself
 * and as a second map with its own identity.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseTemplate, type ScenarioTemplateV2 } from '@simforge-oss/scenario';

import { readInstalledMapClosureFiles } from './maps.js';
import { liftMapBoundTemplate } from './node.js';
import { matchSites } from './sites.js';
import { simulateAuthoritative, simulationMapClosureFromFiles, type SimulationMapClosure } from './simulation.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.resolve(HERE, '../../../fixtures/golden-traces/maps/richmond-field-station');
const SOURCE = 'richmond-field-station';
const TARGET = 'richmond-field-station-twin';

type Lane = { laneType?: string; length?: number; polyline: Array<[number, number] | { x: number; y: number }>; successors: string[] };

async function closure(mapId: string, versionId: string): Promise<SimulationMapClosure> {
  return simulationMapClosureFromFiles(await readInstalledMapClosureFiles(DIR, mapId), {
    mapVersionId: versionId, mapAssetId: mapId, browserClosureSha256: 'f'.repeat(64),
  });
}

function point(p: [number, number] | { x: number; y: number }) {
  return Array.isArray(p) ? { x: p[0], y: p[1] } : p;
}

/** Pose `s` metres along a lane centreline, `lateral` metres to its left. */
function poseAt(lane: Lane, s: number, lateral = 0) {
  const points = lane.polyline.map(point);
  let travelled = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!, b = points[i]!;
    const step = Math.hypot(b.x - a.x, b.y - a.y);
    if (travelled + step >= s || i === points.length - 1) {
      const t = step > 0 ? Math.min(1, (s - travelled) / step) : 0;
      const heading = Math.atan2(b.y - a.y, b.x - a.x);
      return {
        x: a.x + (b.x - a.x) * t - Math.sin(heading) * lateral,
        y: a.y + (b.y - a.y) * t + Math.cos(heading) * lateral,
        headingRad: heading,
      };
    }
    travelled += step;
  }
  throw new Error('empty lane');
}

function laneLength(lane: Lane): number {
  const points = lane.polyline.map(point);
  let length = 0;
  for (let i = 1; i < points.length; i += 1) length += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
  return length;
}

/** Ego and an NPC ahead of it in the same lane, and a pedestrian standing beside the road. */
function mapBound(lanes: Record<string, Lane>): ScenarioTemplateV2 {
  const [rsl, lane] = Object.entries(lanes)
    .filter(([, candidate]) => (candidate.laneType ?? 'driving') === 'driving' && laneLength(candidate) > 140)
    .sort(([a], [b]) => a.localeCompare(b))[0]!;
  const [roadId, section, laneId] = rsl.split(':');
  const laneActor = (id: string, label: string, s: number, speedKph: number) => {
    const p = poseAt(lane, s);
    return {
      id, kind: 'scene_absolute', label,
      actor: { class: 'car', catalogId: 'vehicle.sedan' },
      pose: { position: { x: p.x, y: 0, z: -p.y }, headingRad: p.headingRad },
      laneRef: { roadId, section: Number(section), laneId: Number(laneId), s, t: 0, headingOffsetRad: 0 },
      initialSpeedKph: speedKph,
    };
  };
  const walker = poseAt(lane, 90, 7);
  return parseTemplate({
    scenarioVersion: 2,
    meta: { name: 'Transfer me', createdAt: '2026-09-23T00:00:00.000Z', modifiedAt: '2026-09-23T00:00:00.000Z', appVersion: '0.1.0-editor', tags: [] },
    sourceMap: { mapId: SOURCE, mapName: 'Richmond Field Station' },
    anchor: { pin: { mapId: SOURCE }, features: [] },
    roles: [
      laneActor('ego', 'Ego', 40, 30),
      laneActor('lead', 'Lead car', 75, 20),
      {
        id: 'walker', kind: 'scene_absolute', label: 'Walker',
        actor: { class: 'pedestrian', catalogId: 'pedestrian.adult' },
        pose: { position: { x: walker.x, y: 0, z: -walker.y }, headingRad: walker.headingRad + Math.PI / 2 },
        initialSpeedKph: 0,
      },
    ],
    metricSubject: 'ego',
    choreography: { clipSeconds: 10, warmupSeconds: 0, interactions: [] },
  });
}

describe('a transferred scenario simulates', () => {
  it('lifts to relative roles, pins to a site on another map and runs the authoritative simulation there', async () => {
    const [source, target] = await Promise.all([closure(SOURCE, 'usmapv_src'), closure(TARGET, 'usmapv_tgt')]);
    const content = mapBound(source.bundle.topology.lanes as unknown as Record<string, Lane>);
    // The map-bound source itself simulates (the baseline this test transfers).
    expect(simulateAuthoritative({ canonicalContent: content, closure: source }).trace.header.actorIds).toEqual(expect.arrayContaining(['ego', 'lead', 'walker']));

    const lifted = liftMapBoundTemplate(content, source.bundle);
    expect(lifted.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    const portable = parseTemplate(lifted.template);
    expect(portable.roles.map((role) => role.kind)).not.toContain('scene_absolute');
    expect(portable.roles.map((role) => role.kind)).toEqual(expect.arrayContaining(['on_reference']));

    const { report } = matchSites(portable, target.bundle);
    const sites = report.sites;
    const site = sites.find((candidate) => candidate.degradation.intentPreserved);
    expect(site, 'an intent-preserving site on the target map').toBeTruthy();
    const pinned = parseTemplate({
      ...portable,
      sourceMap: { mapId: TARGET, mapName: 'Richmond twin' },
      anchor: { ...portable.anchor, pin: { mapId: TARGET, siteId: site!.siteId, topologyDigest: target.bundle.digest } },
    });

    const run = simulateAuthoritative({ canonicalContent: pinned, closure: target });
    expect(run.trace.header.actorIds).toEqual(expect.arrayContaining(['ego', 'lead', 'walker']));
    expect(run.trace.ticks.t.length).toBeGreaterThan(400);
    // Deterministic: the same pinned document resolves to the same key and trace.
    const again = simulateAuthoritative({ canonicalContent: pinned, closure: target });
    expect(again.simKey).toBe(run.simKey);
    expect(again.traceSha256).toBe(run.traceSha256);
  });
});
