/**
 * `@simforge-oss/native-runtime` — Node entry.
 *
 * Loads the N-API addon built by `pnpm --filter @simforge-oss/native-runtime
 * build:node` (`native/simforge-native-runtime.<platform>-<arch>.node`, typed by
 * the generated `native/index.d.ts`). There is no TypeScript simulator behind
 * this module: a missing or mismatched addon is an installation error and is
 * reported as one.
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type * as Native from '../native/index.js';

import { ABI_VERSION } from './shared.js';

export * from './shared.js';
export {
  ABI_VERSION, ACTION_WIDTH, ACTOR_ROW, DEFAULT_MAX_OBJECTS,
  ENGINE_HZ, HANDOFF_ACTOR_ROW, HANDOFF_BODY_ROW, OBJECT_FEATURES, STATE_VECTOR_SIZE,
} from './shared.js';
export type * from '../native/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** `dist/` and `src/` are both one level under the package root. */
const PACKAGE_ROOT = join(HERE, '..');
const BINARY_NAME = 'simforge-native-runtime';

/**
 * Installed runtime root shared by the CLI, Studio hosts and native renderer:
 * `SIMFORGE_NATIVE_RUNTIME_ROOT`, else the OS data directory
 * (`${XDG_DATA_HOME:-~/.local/share}/simforge/native-runtime` on Linux,
 * `~/Library/Application Support/simforge/native-runtime` on macOS,
 * `%LOCALAPPDATA%\simforge\native-runtime` on Windows). Mirrors
 * `defaultRuntimeRoot()` in scripts/native-runtime/target-layout.mjs, which
 * the installer uses; keep the two in step.
 */
export function nativeRuntimeRoot(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const explicit = env.SIMFORGE_NATIVE_RUNTIME_ROOT?.trim();
  if (explicit) return explicit;
  if (platform === 'win32') {
    return join(env.LOCALAPPDATA?.trim() || join(homedir(), 'AppData', 'Local'), 'simforge', 'native-runtime');
  }
  if (platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'simforge', 'native-runtime');
  }
  return join(env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share'), 'simforge', 'native-runtime');
}

/** `<name>` or `<name>.exe`: the OS-correct file name of a runtime executable. */
export function nativeExecutableName(stem: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? `${stem}.exe` : stem;
}

/** Platform suffix `@napi-rs/cli --platform` uses in the addon file name (`linux-x64-gnu`, `darwin-arm64`, `win32-x64-msvc`). */
export function addonPlatformSuffix(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  if (platform === 'win32') return `win32-${arch}-msvc`;
  if (platform === 'linux') return `linux-${arch}-${linuxLibc()}`;
  return `${platform}-${arch}`;
}

/** glibc vs musl from the process report; the report omits `glibcVersionRuntime` on musl. */
function linuxLibc(): 'gnu' | 'musl' {
  const report: unknown = process.report?.getReport?.();
  if (report && typeof report === 'object' && 'header' in report) {
    const header: unknown = report.header;
    if (header && typeof header === 'object' && 'glibcVersionRuntime' in header && typeof header.glibcVersionRuntime === 'string') return 'gnu';
    return 'musl';
  }
  return 'gnu';
}

/**
 * Addon resolution. `SIMFORGE_NATIVE_RUNTIME_ADDON`, when set, is authoritative:
 * it is the only path tried and a missing file there is an error, never a
 * fall-through to the packaged binary.
 */
export function addonCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const explicit = env.SIMFORGE_NATIVE_RUNTIME_ADDON?.trim();
  if (explicit) return [explicit];
  return [join(PACKAGE_ROOT, 'native', `${BINARY_NAME}.${addonPlatformSuffix()}.node`)];
}

let loaded: typeof Native | null = null;

/**
 * Verify a loaded module is this binding at exactly {@link ABI_VERSION}.
 * Anything else — an older/newer build, a foreign addon, a module without the
 * version export — is rejected; there is one supported ABI at a time.
 */
export function assertNativeAbi(module: unknown, source: string): asserts module is typeof Native {
  if (!module || typeof module !== 'object' || !('abiVersion' in module) || typeof module.abiVersion !== 'function') {
    throw new Error(`@simforge-oss/native-runtime: ${source} is not a SimForge native runtime module (no abiVersion export)`);
  }
  const version: unknown = module.abiVersion();
  if (version !== ABI_VERSION) {
    throw new Error(
      `@simforge-oss/native-runtime: ${source} has binding ABI ${String(version)} but this package requires ABI ${ABI_VERSION}; ` +
        'rebuild the addon from the same checkout (`pnpm --filter @simforge-oss/native-runtime build:node`).',
    );
  }
}

/**
 * The native addon. Throws a descriptive error when it is not built for this
 * platform or has a different binding ABI; callers never get a partial or
 * emulated runtime.
 */
export function native(): typeof Native {
  if (loaded) return loaded;
  const [candidate] = addonCandidates();
  if (!candidate || !existsSync(candidate)) {
    throw new Error(
      `@simforge-oss/native-runtime: no native addon at ${candidate ?? '<none>'} (platform ${addonPlatformSuffix()}). ` +
        'Install a published platform package or build it with `pnpm --filter @simforge-oss/native-runtime build:node` ' +
        '(requires the Rust toolchain); SIMFORGE_NATIVE_RUNTIME_ADDON, when set, must point at an existing build.',
    );
  }
  const require = createRequire(import.meta.url);
  const addon: unknown = require(candidate);
  assertNativeAbi(addon, candidate);
  loaded = addon;
  return loaded;
}

/** Whether the addon file this package would load is present (no load side effects). */
export function isNativeAvailable(): boolean {
  const [candidate] = addonCandidates();
  return candidate !== undefined && existsSync(candidate);
}
