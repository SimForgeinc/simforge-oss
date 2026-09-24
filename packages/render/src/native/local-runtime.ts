import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import { nativeExecutableName, nativeRuntimeRoot } from '@simforge-oss/native-runtime';
import { z } from 'zod';

import { RenderInputError } from '../render-input-error.js';
import { PINNED_ACTOR_ASSETS_DIGEST, PINNED_ACTOR_ASSETS_SIZE_BYTES } from './actor-assets.js';

/**
 * Where the executables and immutable assets a baseline local Bevy render
 * needs actually are on this machine. One resolution shared by the host's
 * capability report and the worker's claim scope, so the engine card the
 * user sees and the jobs the worker accepts describe the same installation.
 *
 * Nothing here fabricates readiness: every location is checked on disk,
 * PATH lookups are reported as such, and a missing dependency yields a
 * reason instead of a fallback.
 */

/** The one native renderer executable (`simforge-render serve|job|view|dev`). */
export const SIMFORGE_RENDER_BINARY_NAME = 'simforge-render';
const RUNTIME_MANIFEST_RELATIVE = 'bin/runtime-manifest.json';
const ACTOR_ASSETS_RUNTIME_RELATIVE = 'share/actor-assets';

export type LocalExecutableSource = 'env' | 'runtime-manifest' | 'runtime-root' | 'path' | 'playwright';

export type LocalExecutable =
  | { readonly state: 'available'; readonly path: string; readonly source: LocalExecutableSource; readonly sizeBytes: number }
  | { readonly state: 'missing'; readonly path: null; readonly source: null; readonly searched: readonly string[] };

export type LocalActorAssetsSource =
  | { readonly kind: 'directory'; readonly root: string; readonly source: 'env' | 'runtime-root' }
  | { readonly kind: 'remote'; readonly baseUrl: string };

export type LocalActorAssets =
  | { readonly state: 'available'; readonly digest: string; readonly closurePath: string | null; readonly blobBaseUrl: string; readonly source: LocalActorAssetsSource }
  | { readonly state: 'missing'; readonly digest: string; readonly searched: readonly string[] };

export interface LocalNativeRenderProbe {
  readonly ready: boolean;
  readonly runtimeRoot: string;
  readonly renderService: LocalExecutable;
  readonly encoder: LocalExecutable;
  readonly actorAssets: LocalActorAssets;
  readonly reasons: readonly string[];
}

function fileSize(path: string): number | null {
  try {
    const stats = statSync(path);
    return stats.isFile() ? stats.size : null;
  } catch {
    return null;
  }
}

const RuntimeManifestComponentSchema = z.object({
  kind: z.string().optional(),
  name: z.string().optional(),
  install: z.string().optional(),
});
const RuntimeManifestComponentsSchema = z.object({ components: z.array(z.unknown()).default([]) });

/**
 * The `components[]` of the installed runtime manifest; none when the runtime
 * installs no manifest. A manifest that exists but cannot be read is a broken
 * installation (`native_runtime_manifest_invalid`), never "no components":
 * that would quietly resolve the service from another location.
 */
function runtimeManifestComponents(root: string): Array<z.infer<typeof RuntimeManifestComponentSchema>> {
  const manifestPath = join(root, RUNTIME_MANIFEST_RELATIVE);
  if (fileSize(manifestPath) === null) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new RenderInputError('native_runtime_manifest_invalid', `${manifestPath} is not readable JSON: ${(error as Error).message}`);
  }
  const parsed = RuntimeManifestComponentsSchema.safeParse(raw);
  if (!parsed.success) throw new RenderInputError('native_runtime_manifest_invalid', `${manifestPath} has no components list`);
  return parsed.data.components.map((item, index) => {
    const component = RuntimeManifestComponentSchema.safeParse(item);
    if (!component.success) throw new RenderInputError('native_runtime_manifest_invalid', `${manifestPath} component ${index} is malformed`);
    return component.data;
  });
}

function pathCandidates(base: string, env: NodeJS.ProcessEnv): string[] {
  const name = nativeExecutableName(base);
  return (env.PATH ?? '').split(delimiter).filter(Boolean).map((entry) => join(entry, name));
}

function resolveExecutable(candidates: ReadonlyArray<{ path: string; source: LocalExecutableSource }>): LocalExecutable {
  for (const candidate of candidates) {
    const sizeBytes = fileSize(candidate.path);
    if (sizeBytes !== null) return { state: 'available', path: candidate.path, source: candidate.source, sizeBytes };
  }
  return { state: 'missing', path: null, source: null, searched: candidates.map((candidate) => candidate.path) };
}

/**
 * The native renderer binary (`simforge-render`): `SIMFORGE_NATIVE_RENDER_BINARY`, then the
 * component the runtime manifest installs under that name, then the
 * runtime root's `bin/`. Never PATH: the service is a packaged dependency,
 * not a developer tool.
 */
export function resolveNativeRenderService(env: NodeJS.ProcessEnv = process.env): LocalExecutable {
  const root = nativeRuntimeRoot(env);
  const candidates: Array<{ path: string; source: LocalExecutableSource }> = [];
  const explicit = env.SIMFORGE_NATIVE_RENDER_BINARY?.trim();
  if (explicit) candidates.push({ path: explicit, source: 'env' });
  for (const component of runtimeManifestComponents(root)) {
    if (component.kind === 'binary' && component.name === SIMFORGE_RENDER_BINARY_NAME && typeof component.install === 'string') {
      candidates.push({ path: join(root, component.install), source: 'runtime-manifest' });
    }
  }
  candidates.push({ path: join(root, 'bin', nativeExecutableName(SIMFORGE_RENDER_BINARY_NAME)), source: 'runtime-root' });
  return resolveExecutable(candidates);
}

/**
 * The video encoder: `SIMFORGE_FFMPEG_BINARY`, the runtime root's `bin/`, then
 * PATH (reported as such so a packaged build that forgot to bundle it is
 * visible instead of silently borrowing a developer's install).
 */
export function resolveEncoder(env: NodeJS.ProcessEnv = process.env): LocalExecutable {
  const candidates: Array<{ path: string; source: LocalExecutableSource }> = [];
  const explicit = env.SIMFORGE_FFMPEG_BINARY?.trim();
  if (explicit) candidates.push({ path: explicit, source: 'env' });
  candidates.push({ path: join(nativeRuntimeRoot(env), 'bin', nativeExecutableName('ffmpeg')), source: 'runtime-root' });
  candidates.push(...pathCandidates('ffmpeg', env).map((path) => ({ path, source: 'path' as const })));
  return resolveExecutable(candidates);
}

/** `ffprobe`, resolved exactly like {@link resolveEncoder}; the browser review MP4 needs it. */
export function resolveProbe(env: NodeJS.ProcessEnv = process.env): LocalExecutable {
  const candidates: Array<{ path: string; source: LocalExecutableSource }> = [];
  const explicit = env.SIMFORGE_FFPROBE_BINARY?.trim();
  if (explicit) candidates.push({ path: explicit, source: 'env' });
  candidates.push({ path: join(nativeRuntimeRoot(env), 'bin', nativeExecutableName('ffprobe')), source: 'runtime-root' });
  candidates.push(...pathCandidates('ffprobe', env).map((path) => ({ path, source: 'path' as const })));
  return resolveExecutable(candidates);
}

export function actorClosureRelativePath(digest: string): string {
  return join('closures', `${digest}.json`);
}

/**
 * The pinned actor closure: a packaged directory (`SIMFORGE_ACTOR_ASSETS_ROOT`,
 * then `<runtime root>/share/actor-assets`) holding `closures/<digest>.json`
 * and `blobs/sha256/<xx>/<sha256>`, or an explicitly configured remote origin
 * (`SIMFORGE_ACTOR_ASSETS_BASE_URL`). The built-in public origin is never an
 * implicit fallback: a baseline install must carry its own bytes.
 */
export function resolveActorAssets(env: NodeJS.ProcessEnv = process.env): LocalActorAssets {
  const digest = PINNED_ACTOR_ASSETS_DIGEST;
  const roots: Array<{ root: string; source: 'env' | 'runtime-root' }> = [];
  const explicitRoot = env.SIMFORGE_ACTOR_ASSETS_ROOT?.trim();
  if (explicitRoot) roots.push({ root: explicitRoot, source: 'env' });
  roots.push({ root: join(nativeRuntimeRoot(env), ACTOR_ASSETS_RUNTIME_RELATIVE), source: 'runtime-root' });
  const searched: string[] = [];
  for (const candidate of roots) {
    const closurePath = join(candidate.root, actorClosureRelativePath(digest));
    searched.push(closurePath);
    if (fileSize(closurePath) === PINNED_ACTOR_ASSETS_SIZE_BYTES) {
      return {
        state: 'available',
        digest,
        closurePath,
        blobBaseUrl: `file://${candidate.root.replace(/\\/g, '/')}`,
        source: { kind: 'directory', root: candidate.root, source: candidate.source },
      };
    }
  }
  const remote = env.SIMFORGE_ACTOR_ASSETS_BASE_URL?.trim();
  if (remote && /^https?:\/\//u.test(remote)) {
    const baseUrl = remote.replace(/\/+$/u, '');
    return { state: 'available', digest, closurePath: null, blobBaseUrl: baseUrl, source: { kind: 'remote', baseUrl } };
  }
  return { state: 'missing', digest, searched };
}

/** Everything a baseline local native render needs, with the reasons it is not ready. */
export function probeLocalNativeRender(env: NodeJS.ProcessEnv = process.env): LocalNativeRenderProbe {
  const runtimeRoot = nativeRuntimeRoot(env);
  const reasons: string[] = [];
  let renderService: LocalExecutable;
  try {
    renderService = resolveNativeRenderService(env);
  } catch (error) {
    // The probe reports a broken installation as a reason, not a crash.
    if (!(error instanceof RenderInputError)) throw error;
    reasons.push(error.message);
    renderService = { state: 'missing', path: null, source: null, searched: [] };
  }
  const encoder = resolveEncoder(env);
  const actorAssets = resolveActorAssets(env);
  if (renderService.state === 'missing' && renderService.searched.length > 0) {
    reasons.push(`The native render service is not installed (looked in ${renderService.searched.join(', ')}).`);
  }
  if (encoder.state === 'missing') reasons.push('No ffmpeg encoder is installed with the runtime.');
  if (actorAssets.state === 'missing') {
    reasons.push(`The pinned actor asset closure ${actorAssets.digest.slice(0, 12)} is not installed (looked in ${actorAssets.searched.join(', ')}).`);
  }
  return { ready: reasons.length === 0, runtimeRoot, renderService, encoder, actorAssets, reasons };
}

/** Local CARLA prerequisites only; server reachability is checked during execution. */
export function probeLocalCarlaRender(env: NodeJS.ProcessEnv = process.env): {
  readonly ready: boolean;
  readonly reasons: readonly string[];
} {
  const binary = env.SIMFORGE_CARLA_BINARY ?? 'simforge-oss-carla-exec';
  const candidates = binary.includes('/') || binary.includes('\\')
    ? [binary]
    : pathCandidates(binary, env);
  const executable = candidates.some((path) => {
    try {
      accessSync(path, constants.X_OK);
      return statSync(path).isFile();
    } catch {
      return false;
    }
  });
  const reasons: string[] = [];
  if (!executable) reasons.push(`The CARLA adapter is not installed or executable (looked in ${candidates.join(', ')}).`);
  const host = env.CARLA_HOST ?? '127.0.0.1';
  try {
    const parsed = new URL(`http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}`);
    if (!host || parsed.username || parsed.password || parsed.port || parsed.pathname !== '/' || parsed.search || parsed.hash || /\s/.test(host)) throw new Error('invalid host');
  } catch {
    reasons.push('The CARLA host is invalid.');
  }
  const port = Number(env.CARLA_PORT ?? 2000);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) reasons.push('The CARLA port must be an integer between 1 and 65535.');
  return { ready: reasons.length === 0, reasons };
}

/**
 * Whether the browser (Three.js) capture engine can run here: a Chromium
 * (`CHROMIUM_EXECUTABLE_PATH`, else the launcher-managed path the caller
 * resolved through playwright-core) plus the encoder/probe pair the review
 * MP4 needs. The worker passes playwright's path; this module stays free of
 * playwright so the host's capability report can import it.
 */
export function probeLocalBrowserRender(env: NodeJS.ProcessEnv = process.env, managedChromiumPath: string | null = null): {
  readonly ready: boolean;
  readonly chromium: LocalExecutable;
  readonly encoder: LocalExecutable;
  readonly probe: LocalExecutable;
  readonly reasons: readonly string[];
} {
  const candidates: Array<{ path: string; source: LocalExecutableSource }> = [];
  const explicit = env.CHROMIUM_EXECUTABLE_PATH?.trim();
  if (explicit) candidates.push({ path: explicit, source: 'env' });
  else if (managedChromiumPath) candidates.push({ path: managedChromiumPath, source: 'playwright' });
  const chromiumExecutable = resolveExecutable(candidates);
  const encoder = resolveEncoder(env);
  const probe = resolveProbe(env);
  const reasons: string[] = [];
  if (chromiumExecutable.state === 'missing') reasons.push('No Chromium executable is installed for the browser capture engine.');
  if (encoder.state === 'missing') reasons.push('No ffmpeg encoder is installed with the runtime.');
  if (probe.state === 'missing') reasons.push('No ffprobe is installed with the runtime.');
  return { ready: reasons.length === 0, chromium: chromiumExecutable, encoder, probe, reasons };
}


