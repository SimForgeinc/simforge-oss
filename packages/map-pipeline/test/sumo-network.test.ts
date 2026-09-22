import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildMapTopologyIndex, TOPOLOGY_CONTENT_EPOCH } from '@simforge-oss/maps/topology';
import {
  bindSignalHeads,
  buildSumoDerivative,
  generateRouteCandidates,
  inspectSumoDerivative,
  parseSumoNetwork,
  phantomTrafficLights,
  registerLaneShapes,
  resolveSumoToolchain,
  SumoBuildError,
  sumoBuildKey,
} from '../scripts/sumo-network.mjs';

const fixture = fileURLToPath(new URL('../../../studio/app/lib/studio-shared/__tests__/fixtures/xodr/signalized-4way.xodr', import.meta.url));

/** A two-edge network whose lane sits 3 m off its OpenDRIVE lane. */
const offsetNetwork = `<?xml version="1.0" encoding="UTF-8"?>

<net version="1.20">
    <location netOffset="10.00,20.00" convBoundary="0,0,100,10" origBoundary="0,0,0,0" projParameter="!"/>
    <edge id="-1" from="a" to="b" priority="1" type="driving" shape="10.00,20.00 110.00,20.00">
        <lane id="-1_0" index="0" speed="13.89" length="100.00" width="3.20" shape="10.00,17.00,1.00 110.00,17.00,2.00">
            <param key="origId" value="1_-1"/>
        </lane>
    </edge>
    <edge id="-2" from="b" to="c" priority="1" type="driving" shape="110.00,20.00 210.00,20.00">
        <lane id="-2_0" index="0" speed="13.89" length="100.00" width="3.20" shape="110.00,18.40 210.00,18.40">
            <param key="origId" value="2_-1"/>
        </lane>
    </edge>
    <junction id="b" type="priority" x="110.00" y="20.00" incLanes="-1_0" intLanes="" shape=""/>
    <connection from="-1" to="-2" fromLane="0" toLane="0" dir="s" state="M"/>
</net>
`;

const topology = {
  lanes: {
    '1:0:-1': { laneType: 'driving', isJunction: false, polyline: [{ x: 0, y: -1.6 }, { x: 50, y: -1.6 }, { x: 100, y: -1.6 }] },
    '2:0:-1': { laneType: 'driving', isJunction: false, polyline: [{ x: 100, y: -1.6 }, { x: 200, y: -1.6 }] },
  },
};

describe('SUMO derivative building blocks', () => {
  it('registers netconvert lanes onto the OpenDRIVE lane centerlines', () => {
    const { xml, stats } = registerLaneShapes(offsetNetwork, topology, [10, 20]);
    expect(stats).toMatchObject({ lanes: 2, registered: 2, rejected: 0, unmatched: 0 });
    const network = parseSumoNetwork(xml);
    const lane = network.edges.get('-1')!.lanes[0]!;
    // Registered in network coordinates (OpenDRIVE + netOffset), heights kept.
    expect(lane.shape[0]).toEqual([10, 18.4, 1]);
    expect(lane.shape.at(-1)).toEqual([110, 18.4, 2]);
    expect(stats.maxShiftM).toBeCloseTo(1.4, 1);
    // Idempotent: a registered network registers onto itself.
    expect(registerLaneShapes(xml, topology, [10, 20]).xml).toBe(xml);
  });

  it('generates the same seeded routes every time', () => {
    const network = parseSumoNetwork(offsetNetwork);
    const first = generateRouteCandidates(network);
    expect(first.routes).toEqual([['-1', '-2']]);
    expect(generateRouteCandidates(network)).toEqual(first);
    expect(first.reachableFringePairs).toBe(1);
  });

  it('binds controlled links to the heads on their connecting road and flags invisible lights', () => {
    const xodr = `<OpenDRIVE>
      <road id="1" junction="-1" length="10"><link><successor elementType="junction" elementId="9"/></link></road>
      <road id="5" junction="9" length="12"><link><predecessor elementType="road" elementId="1"/><successor elementType="road" elementId="2"/></link>
        <signals><signal id="77" s="1" dynamic="no" type="1000001"><validity fromLane="0" toLane="0"/></signal></signals>
      </road>
      <road id="2" junction="-1" length="10"><link><predecessor elementType="junction" elementId="9"/></link></road>
      <junction id="9"><connection incomingRoad="1" connectingRoad="5"><laneLink from="-1" to="-1"/></connection></junction>
    </OpenDRIVE>`;
    const net = `<net>
    <edge id=":9_0" function="internal">
        <lane id=":9_0_0" index="0" speed="10" length="12" shape="0,0 12,0">
            <param key="origId" value="5_-1"/>
        </lane>
    </edge>
    <tlLogic id="9" type="static" programID="0" offset="0">
        <phase duration="30" state="G"/>
        <phase duration="30" state="r"/>
    </tlLogic>
    <tlLogic id="4" type="static" programID="0" offset="0">
        <phase duration="30" state="G"/>
    </tlLogic>
    <connection from="-1" to="-2" fromLane="0" toLane="0" via=":9_0_0" tl="9" linkIndex="0" dir="s" state="O"/>
</net>`;
    const { xml, inferredLinks } = bindSignalHeads(net, xodr);
    expect(inferredLinks).toBe(1);
    const network = parseSumoNetwork(xml);
    expect(network.trafficLights.find((tls) => tls.id === '9')!.linkSignals.get(0)).toEqual(['77']);
    expect(phantomTrafficLights(network)).toEqual(['4']);
  });

  it('keys builds on the OpenDRIVE bytes and map identity', () => {
    const key = sumoBuildKey({ xodrSha256: 'a'.repeat(64), mapId: 'yale-street' });
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(sumoBuildKey({ xodrSha256: 'a'.repeat(64), mapId: 'yale-street', sourceMapId: 'yale-street' })).toBe(key);
    expect(sumoBuildKey({ xodrSha256: 'b'.repeat(64), mapId: 'yale-street' })).not.toBe(key);
  });
});

// Needs the pinned netconvert (`pnpm maps:sumo:toolchain`). The headless gate
// needs the browser runtime outside the repository, so `pnpm maps:sumo:smoke`
// covers it; here the structural gates and determinism are exercised.
const toolchain = await resolveSumoToolchain().catch(() => null);
describe.skipIf(!toolchain)('SUMO derivative build (pinned netconvert)', () => {
  let work: string;
  let topologyPath: string;

  beforeAll(async () => {
    work = await mkdtemp(path.join(os.tmpdir(), 'sumo-derivative-test-'));
    const xodr = await readFile(fixture);
    const index = buildMapTopologyIndex({
      mapName: 'signalized-4way', xodr: xodr.toString('utf8').replace(/>\s*</g, '>\n<'),
      xodrSha256: createHash('sha256').update(xodr).digest('hex'), now: () => TOPOLOGY_CONTENT_EPOCH,
    });
    topologyPath = path.join(work, 'topology-index.json.gz');
    await writeFile(topologyPath, gzipSync(JSON.stringify(index)));
  });
  afterAll(async () => { await rm(work, { recursive: true, force: true }); });

  it('builds a validated, byte-deterministic derivative', async () => {
    const build = (outputDir: string) => buildSumoDerivative({
      xodrPath: fixture, topologyPath, mapId: 'signalized-4way', outputDir, toolchain: toolchain!, simulate: false,
    });
    const first = await build(path.join(work, 'a'));
    const second = await build(path.join(work, 'b'));
    expect(first.report.status).toBe('passed');
    expect(first.report.failures).toEqual([]);
    expect(first.manifest.trafficLights).toBe(1);
    expect(first.files).toEqual(second.files);
    expect(first.manifest.worldFromNetwork.invertY).toBe(true);
    expect(await inspectSumoDerivative({ outputDir: path.join(work, 'a'), xodrPath: fixture, mapId: 'signalized-4way' }))
      .toMatchObject({ state: 'current', expectedKey: first.buildKey });
  }, 120_000);

  it('fails the build, writing nothing but the report, when lanes do not match the scene', async () => {
    const shifted = path.join(work, 'shifted-topology.json.gz');
    const index = JSON.parse((await import('node:zlib')).gunzipSync(await readFile(topologyPath)).toString('utf8'));
    for (const lane of Object.values(index.lanes) as Array<{ polyline: Array<{ x: number; y: number }> }>) {
      for (const point of lane.polyline) { point.x += 25; point.y += 25; }
    }
    await writeFile(shifted, gzipSync(JSON.stringify(index)));
    const outputDir = path.join(work, 'rejected');
    const failure = await buildSumoDerivative({
      xodrPath: fixture, topologyPath: shifted, mapId: 'signalized-4way', outputDir, toolchain: toolchain!, simulate: false, writeFailedReport: true,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SumoBuildError);
    expect((failure as SumoBuildError).code).toBe('sumo_validation_failed');
    expect((failure as SumoBuildError).report?.failures.some((entry) => entry.gate === 'alignment')).toBe(true);
    expect(await inspectSumoDerivative({ outputDir, xodrPath: fixture, mapId: 'signalized-4way' })).toMatchObject({ state: 'missing' });
  }, 120_000);
});
