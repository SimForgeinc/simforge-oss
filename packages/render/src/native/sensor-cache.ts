import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { RenderInputFile } from '../engine.js';
import type { NativeMapClosure } from './map-closure.js';
import { stageNativeTextureProfile } from './texture-profile.js';

/**
 * Builder identity of the service's static sensor scenes: bump with the
 * service's `SENSOR_SCENE_CACHE_VERSION` (or anything that changes how map
 * triangles become scenes). A closure marker from another builder is stale.
 */
export const NATIVE_SENSOR_SCENE_BUILDER = 'simforge.sensor-scenes/v1';

/** One closure's cache record (`<cacheDir>/closures/<closureSha256>.json`). */
export interface NativeSensorSceneMarker {
  readonly schema: 'simforge.native-sensor-cache/v1';
  readonly builder: string;
  readonly closureSha256: string;
  /** Content key of the scenes (triangle snapshot + road set); names the cache files. */
  readonly key: string;
  readonly triangles: number;
  readonly builtAt: string;
}

export function nativeSensorSceneMarkerPath(cacheDir: string, closureSha256: string): string {
  return path.join(cacheDir, 'closures', `${closureSha256}.json`);
}

/** Whether `cacheDir` already holds this closure's scenes from the current builder. */
export async function nativeSensorScenesCached(cacheDir: string, closureSha256: string): Promise<NativeSensorSceneMarker | null> {
  let marker: NativeSensorSceneMarker;
  try {
    marker = JSON.parse(await fs.readFile(nativeSensorSceneMarkerPath(cacheDir, closureSha256), 'utf8')) as NativeSensorSceneMarker;
  } catch {
    return null;
  }
  if (marker.builder !== NATIVE_SENSOR_SCENE_BUILDER || !/^[0-9a-f]{64}$/u.test(marker.key)) return null;
  for (const suffix of ['static', 'road']) {
    try {
      await fs.access(path.join(cacheDir, `${marker.key}.${suffix}.bvh`));
    } catch {
      return null;
    }
  }
  return marker;
}

export interface BuildNativeSensorScenesOptions {
  readonly binary: string;
  readonly closureSha256: string;
  readonly closure: NativeMapClosure<RenderInputFile>;
  /** Where the service keeps the content-addressed scenes (the render jobs' `sensorCacheDir`). */
  readonly cacheDir: string;
  /** Texture staging cache for the scene the builder loads. */
  readonly stagingDir: string;
  readonly signal: AbortSignal;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Load a map closure in the native service and build its static sensor
 * scenes into `cacheDir` (`native-render-service --build-sensor-cache`), so
 * no render job on this map pays the first-lidar BVH build. The scenes
 * depend on geometry only, so the smallest texture tier is staged; the
 * content key the service derives is the one every tier's job looks up.
 * Needs the GPU (the scene loads in Bevy): callers hold the GPU lock and
 * abort `signal` when a job wants the device.
 */
export async function buildNativeSensorScenes(options: BuildNativeSensorScenesOptions): Promise<NativeSensorSceneMarker> {
  const cached = await nativeSensorScenesCached(options.cacheDir, options.closureSha256);
  if (cached) return cached;
  let profile: Awaited<ReturnType<typeof stageNativeTextureProfile>> | undefined;
  for (const renderTextures of ['bc7-512', 'uastc-full'] as const) {
    profile = await stageNativeTextureProfile({
      closure: options.closure, renderTextures, framePixels: 0,
      // Geometry-only load: no VRAM admission here, the GPU lock is held.
      capacityBytes: Number.MAX_SAFE_INTEGER,
      cacheDirectory: options.stagingDir,
    }).catch(() => undefined);
    if (profile) break;
  }
  if (!profile) throw new Error('native_sensor_scene_stage_failed: no texture tier of this closure could be staged');
  const work = await fs.mkdtemp(path.join(options.stagingDir, 'sensor-scenes-'));
  try {
    const scenePath = path.join(work, 'scene.json');
    await fs.writeFile(scenePath, JSON.stringify({
      glbs: [profile.masterPath], profile: 'cinematic', warmupFrames: 0, sensorCacheDir: options.cacheDir,
    }));
    const child = spawn(options.binary, ['--scene', scenePath, '--build-sensor-cache'], {
      stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...options.env },
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => stdout.push(chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr.push(chunk);
      if (stderr.length > 64) stderr.shift();
    });
    const abort = () => child.kill('SIGKILL');
    options.signal.addEventListener('abort', abort, { once: true });
    try {
      const [code, signal] = await once(child, 'exit') as [number | null, NodeJS.Signals | null];
      if (options.signal.aborted) throw options.signal.reason instanceof Error ? options.signal.reason : new Error('native sensor scene build aborted');
      if (code !== 0) throw new Error(`native_sensor_scene_build_failed: exit ${String(code)} ${String(signal)}\n${stderr.join('').slice(-4000)}`);
    } finally {
      options.signal.removeEventListener('abort', abort);
    }
    const line = stdout.join('').trim().split('\n').pop() ?? '';
    const result = JSON.parse(line) as { key?: unknown; triangles?: unknown };
    if (typeof result.key !== 'string' || !/^[0-9a-f]{64}$/u.test(result.key) || typeof result.triangles !== 'number') {
      throw new Error(`native_sensor_scene_build_failed: unexpected result ${line.slice(0, 500)}`);
    }
    const marker: NativeSensorSceneMarker = {
      schema: 'simforge.native-sensor-cache/v1', builder: NATIVE_SENSOR_SCENE_BUILDER,
      closureSha256: options.closureSha256, key: result.key, triangles: result.triangles, builtAt: new Date().toISOString(),
    };
    const markerPath = nativeSensorSceneMarkerPath(options.cacheDir, options.closureSha256);
    await fs.mkdir(path.dirname(markerPath), { recursive: true });
    await fs.writeFile(`${markerPath}.tmp`, JSON.stringify(marker));
    await fs.rename(`${markerPath}.tmp`, markerPath);
    return marker;
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}
