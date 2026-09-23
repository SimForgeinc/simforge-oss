import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, expect, it } from 'vitest';

import type { RenderInputFile } from '../engine.js';
import { collectNativeMapMembers, nativeMapMemberInputId } from './map-closure.js';
import { NATIVE_SENSOR_SCENE_BUILDER, buildNativeSensorScenes, nativeSensorScenesCached } from './sensor-cache.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))); });

/** A minimal closure plus a stand-in service that writes the cache files and prints its result line. */
async function fixture() {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'native-sensor-cache-'));
  directories.push(directory);
  const inputs: RenderInputFile[] = [];
  for (const [relativePath, bytes] of [
    ['master.gltf', JSON.stringify({ buffers: [{ uri: 'geometry.bin', byteLength: 16 }] })],
    ['geometry.bin', Buffer.alloc(16)],
  ] as const) {
    const file = path.join(directory, 'closure', relativePath);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes);
    inputs.push({ inputId: nativeMapMemberInputId(relativePath), relativePath, path: file, sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: Buffer.byteLength(bytes) });
  }
  const key = 'a'.repeat(64);
  const binary = path.join(directory, 'native-render-service');
  const calls = path.join(directory, 'calls.log');
  await fs.writeFile(binary, [
    '#!/bin/sh',
    `echo "$@" >> ${calls}`,
    'scene=$2',
    'dir=$(sed -E \'s/.*"sensorCacheDir":"([^"]+)".*/\\1/\' "$scene")',
    `mkdir -p "$dir" && touch "$dir/${key}.static.bvh" "$dir/${key}.road.bvh"`,
    `echo '{"schema":"simforge.native-sensor-cache/v1","key":"${key}","cached":false,"triangles":42}'`,
  ].join('\n'));
  await fs.chmod(binary, 0o755);
  return { directory, binary, calls, key, closure: collectNativeMapMembers(inputs) };
}

it('builds a closure once, records its marker, and serves the cache afterwards', async () => {
  const { directory, binary, calls, key, closure } = await fixture();
  const cacheDir = path.join(directory, 'sensor-scenes');
  const options = {
    binary, closure, cacheDir, closureSha256: 'b'.repeat(64),
    stagingDir: path.join(directory, 'native-textures'), signal: new AbortController().signal,
  };
  expect(await nativeSensorScenesCached(cacheDir, options.closureSha256)).toBeNull();
  const marker = await buildNativeSensorScenes(options);
  expect(marker).toMatchObject({ key, triangles: 42, builder: NATIVE_SENSOR_SCENE_BUILDER, closureSha256: options.closureSha256 });
  expect(await nativeSensorScenesCached(cacheDir, options.closureSha256)).toMatchObject({ key });
  // Cached: the service is not started again.
  await buildNativeSensorScenes(options);
  expect((await fs.readFile(calls, 'utf8')).trim().split('\n')).toHaveLength(1);
  expect(await fs.readFile(calls, 'utf8')).toContain('--build-sensor-cache');
  // A missing tree invalidates the marker.
  await fs.rm(path.join(cacheDir, `${key}.road.bvh`));
  expect(await nativeSensorScenesCached(cacheDir, options.closureSha256)).toBeNull();
});

it('stops the build when the caller aborts (a job claimed the GPU)', async () => {
  const { directory, closure } = await fixture();
  const binary = path.join(directory, 'slow-service');
  await fs.writeFile(binary, '#!/bin/sh\nsleep 30\n');
  await fs.chmod(binary, 0o755);
  const controller = new AbortController();
  const building = buildNativeSensorScenes({
    binary, closure, cacheDir: path.join(directory, 'sensor-scenes'), closureSha256: 'c'.repeat(64),
    stagingDir: path.join(directory, 'native-textures'), signal: controller.signal,
  });
  setTimeout(() => controller.abort(new Error('a render job claimed the GPU')), 100);
  await expect(building).rejects.toThrow(/claimed the GPU/);
});
