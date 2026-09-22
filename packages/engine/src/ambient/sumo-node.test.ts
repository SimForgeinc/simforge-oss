import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { sha256Bytes } from '../core/hash.js';
import {
  PINNED_SUMO_RUNTIME_VERSION,
  PINNED_SUMO_WASM_SHA256,
  stageSumoRuntime,
  sumoTrafficNetworkFromMembers,
  type SumoRuntimeFile,
} from './sumo-node.js';

const INSTALLED = path.join(
  process.env['SIMFORGE_SUMO_RUNTIME_DIR']
    ?? path.join(process.env['XDG_DATA_HOME'] ?? path.join(os.homedir(), '.local', 'share'), 'simforge', 'maps', 'dev-assets', 'sumo-runtime'),
);
const haveRuntime = existsSync(path.join(INSTALLED, 'sumo.wasm'));
const scratch: string[] = [];
afterAll(async () => { await Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true }))); });

describe('SUMO runtime staging', () => {
  it.runIf(haveRuntime)('stages the pinned build from a byte source and instantiates it', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'sumo-stage-'));
    scratch.push(directory);
    const reads: SumoRuntimeFile[] = [];
    const read = async (file: SumoRuntimeFile) => { reads.push(file); return new Uint8Array(await readFile(path.join(INSTALLED, file))); };
    const runtime = await stageSumoRuntime({ directory, read });
    expect(runtime.version).toBe(PINNED_SUMO_RUNTIME_VERSION);
    expect(runtime.wasmSha256).toBe(PINNED_SUMO_WASM_SHA256);
    const module = await runtime.createModule(() => undefined);
    expect(typeof module._us_sumo_start).toBe('function');
    // A second stage reuses the verified binaries.
    reads.length = 0;
    await stageSumoRuntime({ directory, read });
    expect(reads).toEqual(['runtime-manifest.json']);
  }, 60_000);

  it('refuses a runtime binary that is not the pinned build', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'sumo-stage-'));
    scratch.push(directory);
    await expect(stageSumoRuntime({ directory, read: async () => new TextEncoder().encode('not sumo') }))
      .rejects.toThrow(/not the pinned build/);
  });
});

describe('SUMO network members', () => {
  const network = new TextEncoder().encode('<net/>');
  const sha256 = sha256Bytes(network);
  const manifest = JSON.stringify({
    schema: 'uniscenarios.sumo-network.v1', mapId: 'm', networkFile: 'map.net.xml', sha256,
    worldFromNetwork: { translationX: 0, translationY: 0, rotationDegrees: 0, scale: 1, invertY: true },
    routeCandidates: [['e']],
  });

  it('accepts members that match the map version digest', () => {
    expect(sumoTrafficNetworkFromMembers({ manifest, network, expectedSha256: sha256 }).manifest.sha256).toBe(sha256);
  });

  it('refuses members from another build', () => {
    expect(() => sumoTrafficNetworkFromMembers({ manifest, network, expectedSha256: '0'.repeat(64) })).toThrow(/not the map version/);
    expect(() => sumoTrafficNetworkFromMembers({ manifest, network: new TextEncoder().encode('<net />'), expectedSha256: sha256 })).toThrow(/not the map version/);
  });
});
