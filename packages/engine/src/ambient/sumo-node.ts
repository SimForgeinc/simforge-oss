/**
 * Node loader for the pinned SUMO WebAssembly runtime (workers and the CLI).
 *
 * The directory is the packaged runtime (`sumo.mjs`, `sumo.wasm`,
 * `runtime-manifest.json`), the same bytes Studio serves under
 * `/api/simforge/sumo-runtime/1.27.1-7717f237/`. The wasm digest is pinned:
 * a different build would be a different traffic function, so it is refused
 * unless the caller explicitly opts out (and then the digest still enters the
 * traffic key).
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  validateSumoNetworkManifest,
  validateSumoRuntimeManifest,
  type SumoNetworkManifest,
  type SumoRuntimeManifest,
} from './sumo.js';
import type { SumoTrafficNetwork } from './sumo-traffic.js';
import type { SumoRuntime, SumoWasmModule } from './sumo-runtime.js';

/** sha256 of the only SUMO runtime build workers accept (SUMO 1.27.1, commit 7717f237). */
export const PINNED_SUMO_WASM_SHA256 = 'e93c001444732ee95c4e0030e824d7d1883b84c4994ac6fbe8b04b336ced3e93';
export const PINNED_SUMO_RUNTIME_VERSION = '1.27.1-7717f237';
/** sha256 of the Emscripten loader (`sumo.mjs`) shipped with that build. */
export const PINNED_SUMO_MODULE_SHA256 = 'eafc5a8ad2390ac12fd81e7b29c4126d3cd9a6e571c7f1483c5d9c7d23dc6886';

export type SumoRuntimeFile = 'sumo.mjs' | 'sumo.wasm' | 'runtime-manifest.json';

/**
 * Stage the pinned runtime into `directory` from any byte source (the
 * artifact store key `uniscenario/sumo-runtime/1.27.1-7717f237/<file>`, a
 * mounted volume, …) and load it. Files already staged with the pinned
 * digests are reused; anything else is re-read and replaced atomically.
 */
export async function stageSumoRuntime(options: {
  readonly directory: string;
  readonly read: (file: SumoRuntimeFile) => Promise<Uint8Array>;
}): Promise<SumoRuntime> {
  await mkdir(options.directory, { recursive: true });
  const pinned: Record<SumoRuntimeFile, string | null> = {
    'sumo.mjs': PINNED_SUMO_MODULE_SHA256,
    'sumo.wasm': PINNED_SUMO_WASM_SHA256,
    'runtime-manifest.json': null,
  };
  for (const file of Object.keys(pinned) as SumoRuntimeFile[]) {
    const target = path.join(options.directory, file);
    const expected = pinned[file];
    const existing = await readFile(target).catch(() => null);
    if (existing && expected !== null && sha256Of(existing) === expected) continue;
    const bytes = await options.read(file);
    if (expected !== null && sha256Of(bytes) !== expected) {
      throw new Error(`SUMO runtime ${file} ${sha256Of(bytes)} is not the pinned build ${expected}`);
    }
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, bytes);
    await rename(temporary, target);
  }
  return loadSumoRuntime(options.directory);
}

/**
 * The map version's SUMO derivative members as the traffic step takes them,
 * verified against the digest the map version row records.
 */
export function sumoTrafficNetworkFromMembers(options: {
  readonly manifest: Uint8Array | string;
  readonly network: Uint8Array;
  /** `map_versions.sumo_network_sha256`. */
  readonly expectedSha256: string;
}): SumoTrafficNetwork {
  const manifest = JSON.parse(typeof options.manifest === 'string' ? options.manifest : new TextDecoder().decode(options.manifest)) as SumoNetworkManifest;
  validateSumoNetworkManifest(manifest, manifest.mapId);
  const actual = sha256Of(options.network);
  if (manifest.sha256 !== options.expectedSha256 || actual !== options.expectedSha256) {
    throw new Error(`SUMO network ${actual} (sidecar ${manifest.sha256}) is not the map version's ${options.expectedSha256}`);
  }
  return { bytes: options.network, manifest };
}

function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Load the packaged Emscripten factory. A native dynamic import is used when
 * the host allows it; inside VM-sandboxed test runners (no dynamic-import
 * callback) the same pinned source is evaluated with its three module-level
 * references (`import.meta.url`, `await import('node:module')`, the default
 * export) bound explicitly.
 */
async function importSumoFactory(directory: string, moduleUrl: string): Promise<SumoFactory> {
  try {
    const nativeImport = new Function('url', 'return import(url)') as (url: string) => Promise<{ default: SumoFactory }>;
    return (await nativeImport(moduleUrl)).default;
  } catch (error) {
    if (!(error instanceof Error) || !/dynamic import callback|ERR_VM_DYNAMIC_IMPORT/.test(`${error.message} ${(error as { code?: string }).code ?? ''}`)) throw error;
  }
  const source = await readFile(path.join(directory, 'sumo.mjs'), 'utf8');
  const body = source
    .replaceAll('import.meta.url', '__sumoModuleUrl')
    .replace("await import('node:module')", '__sumoNodeModule')
    .replace(/export default Module;?\s*$/, 'return Module;');
  const nodeModule = await import('node:module');
  return new Function('__sumoModuleUrl', '__sumoNodeModule', body)(moduleUrl, nodeModule) as SumoFactory;
}

type SumoFactory = (options: {
  noInitialRun: boolean;
  locateFile: (file: string) => string;
  instantiateWasm: (imports: WebAssembly.Imports, success: (instance: WebAssembly.Instance) => void) => object;
  print: (line: string) => void;
  printErr: (line: string) => void;
}) => Promise<SumoWasmModule>;

export async function loadSumoRuntime(
  directory: string,
  options: { readonly allowUnpinned?: boolean } = {},
): Promise<SumoRuntime> {
  const manifest = JSON.parse(await readFile(path.join(directory, 'runtime-manifest.json'), 'utf8')) as SumoRuntimeManifest;
  validateSumoRuntimeManifest(manifest);
  const wasm = await readFile(path.join(directory, 'sumo.wasm'));
  if (wasm.byteLength !== manifest.wasmBytes) {
    throw new Error(`SUMO runtime binary is incomplete (${wasm.byteLength}/${manifest.wasmBytes} bytes)`);
  }
  const wasmSha256 = createHash('sha256').update(wasm).digest('hex');
  if (wasmSha256 !== PINNED_SUMO_WASM_SHA256 && !options.allowUnpinned) {
    throw new Error(`SUMO runtime ${wasmSha256} is not the pinned build ${PINNED_SUMO_WASM_SHA256}`);
  }
  const compiled = await WebAssembly.compile(wasm);
  const moduleUrl = pathToFileURL(path.join(directory, 'sumo.mjs')).href;
  const factory = await importSumoFactory(directory, moduleUrl);
  const commit = String((manifest as SumoRuntimeManifest & { sumoCommit?: string }).sumoCommit ?? '');
  return {
    version: `${manifest.sumoVersion}-${commit.slice(0, 8)}`,
    sumoVersion: manifest.sumoVersion,
    sumoCommit: commit,
    wasmSha256,
    createModule: (onStderr) => factory({
      noInitialRun: true,
      locateFile: (file) => path.join(directory, file),
      instantiateWasm: (imports, success) => {
        success(new WebAssembly.Instance(compiled, imports));
        return {};
      },
      print: () => undefined,
      printErr: onStderr,
    }),
  };
}
