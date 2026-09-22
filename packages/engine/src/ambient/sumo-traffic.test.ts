import { describe, expect, it } from 'vitest';

import { sha256Bytes } from '../core/hash.js';
import type { SimTrace } from '../trace/trace.js';
import { resolveAmbientTrafficProfile } from './profile.js';
import { sumoVehicleId, type SumoNetworkManifest } from './sumo.js';
import { sumoIdHash, type SumoRuntime, type SumoWasmModule } from './sumo-runtime.js';
import {
  prepareSumoTraffic,
  runSumoTraffic,
  SUMO_TRAFFIC_PRE_ROLL_SECONDS,
  sumoTrafficActorIdFor,
  sumoTrafficKey,
  type SumoTrafficInput,
} from './sumo-traffic.js';
import { mergeSumoTrafficIntoTrace } from './sumo-trace-merge.js';

const NETWORK_XML = `<net>
    <location netOffset="0,0" convBoundary="0.00,0.00,400.00,20.00"/>
    <edge id="e1" from="A" to="B" priority="1" shape="0,10 200,10">
        <lane id="e1_0" index="0" speed="13.9" length="200" width="3.5" shape="0,8.25 200,8.25"><param key="origId" value="1_-1"/></lane>
    </edge>
    <edge id="e2" from="B" to="C" priority="1" shape="200,10 400,10">
        <lane id="e2_0" index="0" speed="13.9" length="200" width="3.5" shape="200,8.25 400,8.25"><param key="origId" value="2_-1"/></lane>
    </edge>
    <edge id="spare" from="C" to="D" priority="1" shape="400,10 400,20">
        <lane id="spare_0" index="0" speed="13.9" length="10" width="3.5" shape="400,8.25 400,18.25"/>
    </edge>
</net>`;
const NETWORK_BYTES = new TextEncoder().encode(NETWORK_XML);
const MANIFEST: SumoNetworkManifest = {
  schema: 'uniscenarios.sumo-network.v1',
  mapId: 'unit-map',
  networkFile: 'map.net.xml',
  sha256: sha256Bytes(NETWORK_BYTES),
  worldFromNetwork: { translationX: -100, translationY: 50, rotationDegrees: 0, scale: 1, invertY: true },
  routeCandidates: [['e1', 'e2'], ['e2']],
};

/**
 * A deterministic stand-in for the bridge: every route-file vehicle drives
 * +x at 10 m/s from x = 5·index, and the call log records the coupling order.
 */
class FakeSumo implements SumoWasmModule {
  readonly HEAPU8 = new Uint8Array(1 << 20);
  readonly log: string[] = [];
  private next = 1024;
  private time = 0;
  private vehicles: { id: string; x: number }[] = [];
  private readonly externals = new Set<string>();
  private statePointer = 0;
  private count = 0;
  constructor(private readonly options: { teleportAtSeconds?: number } = {}) {}

  _malloc(size: number): number { const pointer = this.next; this.next += size + 8; return pointer; }
  _free(): void {}
  lengthBytesUTF8(value: string): number { return new TextEncoder().encode(value).byteLength; }
  stringToUTF8(value: string, pointer: number): void {
    const bytes = new TextEncoder().encode(value);
    this.HEAPU8.set(bytes, pointer);
    this.HEAPU8[pointer + bytes.byteLength] = 0;
  }
  UTF8ToString(pointer: number): string {
    let end = pointer;
    while (this.HEAPU8[end] !== 0) end += 1;
    return new TextDecoder().decode(this.HEAPU8.subarray(pointer, end));
  }
  _us_sumo_start(_net: number, _netLength: number, routes: number, routesLength: number): number {
    const xml = new TextDecoder().decode(this.HEAPU8.subarray(routes, routes + routesLength));
    this.vehicles = [...xml.matchAll(/<(?:vehicle|flow) id="([^"]+)"/g)].map((match, index) => ({ id: match[1]!, x: 5 * index }));
    this.log.push(`start routes=${this.vehicles.length} proxyRoute=${/<route id="proxy-route" edges="([^"]+)"/.exec(xml)?.[1]}`);
    this.pack();
    return 0;
  }
  _us_sumo_step(delta: number): number {
    this.time = Math.round((this.time + delta) * 1000) / 1000;
    for (const vehicle of this.vehicles) vehicle.x += 10 * delta;
    if (this.options.teleportAtSeconds !== undefined && Math.abs(this.time - this.options.teleportAtSeconds) < 1e-9) {
      this.vehicles[0]!.x += 60;
    }
    this.log.push(`step ${this.time}`);
    this.pack();
    return 0;
  }
  _us_sumo_upsert_external(id: number, _kind: number, _route: number, x: number, y: number, _heading: number, speed: number): number {
    const name = this.UTF8ToString(id);
    this.externals.add(name);
    this.log.push(`upsert ${name} ${x.toFixed(2)},${y.toFixed(2)} v=${speed}`);
    return 0;
  }
  _us_sumo_remove(id: number): number { this.log.push(`remove ${this.UTF8ToString(id)}`); return 0; }
  _us_sumo_state_pointer(): number { return this.statePointer; }
  _us_sumo_state_count(): number { return this.count; }
  _us_sumo_signal_state_pointer(): number { return 0; }
  _us_sumo_signal_state_count(): number { return 0; }
  _us_sumo_time(): number { return this.time; }
  _us_sumo_last_error(): number { return 0; }
  _us_sumo_close(): void { this.log.push('close'); }

  private pack(): void {
    this.statePointer = 4096;
    const view = new DataView(this.HEAPU8.buffer, this.statePointer, this.vehicles.length * 32);
    this.vehicles.forEach((vehicle, index) => {
      const offset = index * 32;
      view.setUint32(offset, sumoIdHash(vehicle.id), true);
      view.setFloat32(offset + 4, vehicle.x, true);
      view.setFloat32(offset + 8, 8.25, true);
      view.setFloat32(offset + 12, 90, true);
      view.setFloat32(offset + 16, 10, true);
      view.setFloat32(offset + 20, 0, true);
      view.setFloat32(offset + 24, vehicle.x, true);
      view.setUint32(offset + 28, 0, true);
    });
    this.count = this.vehicles.length;
  }
}

function runtimeWith(modules: FakeSumo[]): SumoRuntime {
  return {
    version: '1.27.1-7717f237',
    sumoVersion: '1.27.1',
    sumoCommit: '7717f2379d9e314a0c81c5cec748444de06a2a91',
    wasmSha256: 'e93c001444732ee95c4e0030e824d7d1883b84c4994ac6fbe8b04b336ced3e93',
    createModule: async () => {
      const module = new FakeSumo();
      modules.push(module);
      return module;
    },
  };
}

/** One authored car crossing the network on lane 1:0:-1, 1 s clip at 0.02 s. */
function authoredTrace(): SimTrace {
  const frames = 51;
  const t = Array.from({ length: frames }, (_, index) => index * 0.02);
  return {
    header: {
      traceVersion: 4,
      engineVersion: 'unit',
      inputHash: 'a'.repeat(64),
      seed: 1,
      mapId: 'unit-map',
      engineGraphDigest: 'b'.repeat(64),
      dt: 0.02,
      clipSeconds: 1,
      warmupSeconds: 2,
      frame: 'xodr-local',
      actorIds: ['ego'],
      actorMetadata: { ego: { kind: 'car', dims: { l: 4.6, w: 1.9, h: 1.5 }, static: false, tags: [] } },
      metricSubject: 'ego',
      ego: { controllerProfile: 'sensor-limited' },
      physics: {} as never,
    },
    ticks: {
      t,
      actors: {
        ego: {
          // Scene x = network x - 100; scene z = 50 - network y = 41.75 on lane e1_0.
          x: t.map((time) => -50 + 12 * time),
          y: t.map(() => -41.75),
          headingRad: t.map(() => 0),
          speedMps: t.map(() => 12),
          lateralOffsetM: t.map(() => 0),
          motionDirection: t.map(() => 1 as const),
          laneRsl: t.map(() => '1:0:-1'),
          s: t.map((time) => 12 * time),
          present: t.map(() => 1),
        },
      },
      signals: {},
    },
    events: [],
    metrics: {} as never,
  } as SimTrace;
}

function input(overrides: Partial<SumoTrafficInput> = {}): SumoTrafficInput {
  return {
    authoredTrace: authoredTrace(),
    authoredTraceSha256: 'c'.repeat(64),
    sourceInputDigest: 'd'.repeat(64),
    signalPrograms: [],
    roadControls: [],
    profile: resolveAmbientTrafficProfile({ version: 1, preset: 'city', seed: 'unit', maxActors: 4 }),
    network: { bytes: NETWORK_BYTES, manifest: MANIFEST },
    map: { assetId: 'unit-map', versionId: 'usmap_unit' },
    ...overrides,
  };
}

describe('worker SUMO traffic step', () => {
  it('runs the documented coupling order: pre-roll, then upsert → step → record per tick', async () => {
    const modules: FakeSumo[] = [];
    const result = await runSumoTraffic(runtimeWith(modules), input());
    const log = modules[0]!.log;
    const preRollSteps = Math.round(SUMO_TRAFFIC_PRE_ROLL_SECONDS / 0.02);
    expect(log[0]).toMatch(/^start/);
    // The authored car is held at its t = 0 pose with speed 0 through the pre-roll.
    expect(log[1]).toBe('upsert external:ego 50.00,8.25 v=0');
    expect(log.filter((line) => line.startsWith('step')).length).toBe(preRollSteps + 50);
    const clip = log.slice(log.indexOf(`step ${SUMO_TRAFFIC_PRE_ROLL_SECONDS}`) + 1);
    // Each clip tick: the proxy moves to its t_k pose (0.24 m further), then SUMO steps once.
    expect(clip.slice(0, 4)).toEqual([
      'upsert external:ego 50.24,8.25 v=12',
      'step 60.02',
      'upsert external:ego 50.48,8.25 v=12',
      'step 60.04',
    ]);
    expect(log.at(-1)).toBe('close');
    expect(result.artifact.artifact.fixedStepSeconds).toBe(0.02);
    expect(result.artifact.artifact.durationSeconds).toBe(1);
    expect(result.artifact.artifact.provider).toEqual({ id: 'sumo', version: '1.27.1-7717f237', seed: 'unit' });
    expect(result.artifact.artifact.signals).toEqual([]);
  });

  it('drops ambient routes along authored lanes and parks proxies on an unused edge', async () => {
    const modules: FakeSumo[] = [];
    const result = await runSumoTraffic(runtimeWith(modules), input());
    // Route ["e1","e2"] shares e1 with the authored car: only ["e2"] remains.
    expect(result.diagnostics.authoredCorridorRejects).toBe(1);
    expect(result.diagnostics.proxyRouteEdge).toBe('spare');
    expect(modules[0]!.log[0]).toBe('start routes=1 proxyRoute=spare');
  });

  it('records quantized scene poses under stable hash ids', async () => {
    const result = await runSumoTraffic(runtimeWith([]), input());
    const [actor] = result.artifact.artifact.actors;
    expect(actor!.id).toBe(sumoTrafficActorIdFor(sumoVehicleId('unit', 0)));
    expect(actor!.id).toMatch(/^sumo:[0-9a-f]{8}$/);
    for (const state of actor!.states) {
      expect(Math.round(state.x * 1e4) / 1e4).toBe(state.x);
      expect(state.z).toBe(41.75);
      // SUMO 90° (network +x) is scene heading 0.
      expect(state.headingRad).toBe(0);
    }
  });

  it('is byte-identical across runs and sensitive to every key input', async () => {
    const first = await runSumoTraffic(runtimeWith([]), input());
    const second = await runSumoTraffic(runtimeWith([]), input());
    expect(second.artifact.bytes).toEqual(first.artifact.bytes);
    expect(second.key).toBe(first.key);
    const base = {
      sourceInputDigest: 'd'.repeat(64),
      authoredTraceSha256: 'c'.repeat(64),
      sumoNetworkSha256: MANIFEST.sha256,
      runtime: { version: '1.27.1-7717f237', wasmSha256: 'e'.repeat(64) },
      profile: input().profile,
      stepSeconds: 0.02,
      durationSeconds: 1,
    };
    const key = sumoTrafficKey(base);
    expect(sumoTrafficKey({ ...base })).toBe(key);
    for (const variant of [
      { sourceInputDigest: 'f'.repeat(64) },
      { authoredTraceSha256: 'f'.repeat(64) },
      { sumoNetworkSha256: 'f'.repeat(64) },
      { runtime: { ...base.runtime, wasmSha256: 'f'.repeat(64) } },
      { profile: { ...base.profile, seed: 'other' } },
      { durationSeconds: 2 },
      { signalAuthority: 'netconvert' as const },
    ]) {
      expect(sumoTrafficKey({ ...base, ...variant })).not.toBe(key);
    }
  });

  it('splits a teleported vehicle into a new actor instead of recording the jump', async () => {
    const runtime = runtimeWith([]);
    const teleporting: SumoRuntime = {
      ...runtime,
      createModule: async () => new FakeSumo({ teleportAtSeconds: SUMO_TRAFFIC_PRE_ROLL_SECONDS + 0.5 }),
    };
    const result = await runSumoTraffic(teleporting, input());
    expect(result.diagnostics.teleports).toBe(1);
    const ids = result.artifact.artifact.actors.map((actor) => actor.id);
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(`${ids[0]}~1`);
    const [before, after] = result.artifact.artifact.actors;
    const handover = before!.states.findIndex((state) => !state.present);
    expect(after!.states[handover]!.present).toBe(true);
    expect(after!.states[handover - 1]!.present).toBe(false);
  });

  it('refuses inputs that would break determinism or the trace grid', async () => {
    const trace = authoredTrace();
    await expect(runSumoTraffic(runtimeWith([]), input({ authoredTrace: { ...trace, header: { ...trace.header, dt: 0.05 } } })))
      .rejects.toThrow(/0\.02 s grid/);
    await expect(runSumoTraffic(runtimeWith([]), input({ network: { bytes: NETWORK_BYTES, manifest: { ...MANIFEST, sha256: '0'.repeat(64) } } })))
      .rejects.toThrow(/do not match the sidecar/);
    const wide = NETWORK_XML.replace('400.00,20.00', '9000.00,20.00');
    const wideBytes = new TextEncoder().encode(wide);
    await expect(runSumoTraffic(runtimeWith([]), input({ network: { bytes: wideBytes, manifest: { ...MANIFEST, sha256: sha256Bytes(wideBytes) } } })))
      .rejects.toThrow(/float32/);
  });

  it('runs a prepared module exactly once', async () => {
    const prepared = await prepareSumoTraffic(runtimeWith([]));
    prepared.run(input());
    expect(() => prepared.run(input())).toThrow(/exactly once/);
  });
});

describe('merging SUMO traffic into the authoritative trace', () => {
  it('adds render-ready ambient actors with an explicit origin and leaves authored tracks alone', async () => {
    const trace = authoredTrace();
    const result = await runSumoTraffic(runtimeWith([]), input());
    const merged = mergeSumoTrafficIntoTrace(trace, result.artifact);
    const [id] = result.artifact.artifact.actors.map((actor) => actor.id);
    expect(merged.ticks.actors.ego).toEqual(trace.ticks.actors.ego);
    expect(merged.header.actorIds).toEqual(['ego', id].sort());
    expect(merged.header.ambientActorIds).toEqual([id]);
    expect(merged.header.materializedTrafficDigest).toBe(result.artifact.sha256);
    expect(merged.header.actorMetadata?.[id!]).toEqual({
      kind: 'car',
      dims: { l: 4.55, w: 1.82, h: 1.48 },
      static: false,
      tags: ['ambient', 'catalog:vehicle.sedan', 'sumo'],
      origin: 'sumo',
    });
    const track = merged.ticks.actors[id!]!;
    // Scene z → xodr-local y = -z.
    expect(track.y[0]).toBe(-41.75);
    expect(track.motionDirection?.every((direction) => direction === 1)).toBe(true);
    expect(track.s[50]).toBeCloseTo(10, 6);
    expect(() => mergeSumoTrafficIntoTrace(merged, result.artifact)).toThrow(/already carries/);
  });
});
