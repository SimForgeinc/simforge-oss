// Per-target naming and location rules shared by every native-runtime script
// (build, package, manifest, install) and offered to the desktop stage. One
// Rust target triple decides every OS-specific name; nothing else may guess.
//
//   targetLayout('x86_64-pc-windows-msvc')
//   -> { os: 'windows', arch: 'x86_64', exe: '.exe', runnerName: 'simforge-runner.exe',
//        renderServiceName: 'native-render-service.exe', renderLibName: 'simforge_render.dll',
//        pythonRelative: 'Scripts/python.exe', gpuInterop: false, nodePlatform: 'win32', nodeArch: 'x64' }

import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';

/** Rust target triples the runtime is produced for, keyed by Electron/Node platform-arch. */
export const SUPPORTED_TARGETS = Object.freeze({
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'win32-x64': 'x86_64-pc-windows-msvc',
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
});

const RUST_ARCH_TO_NODE = Object.freeze({ x86_64: 'x64', aarch64: 'arm64' });

/**
 * Environment for child processes: the inherited Node IPC channel variables
 * make a child Node abort in libuv shutdown, so every spawn drops them.
 */
export function childEnv(env = process.env, extra = {}) {
  const { NODE_CHANNEL_FD: _fd, NODE_CHANNEL_SERIALIZATION_MODE: _mode, ...rest } = env;
  return { ...rest, ...extra };
}

/** `<os>` and `<arch>` of a Rust triple; throws on anything this runtime does not target. */
export function parseTriple(triple) {
  const match = /^(x86_64|aarch64)-(unknown-linux-gnu|pc-windows-msvc|apple-darwin)$/u.exec(triple);
  if (!match) {
    throw new Error(`unsupported target triple ${triple}; supported: ${Object.values(SUPPORTED_TARGETS).join(', ')}`);
  }
  const os = match[2] === 'pc-windows-msvc' ? 'windows' : match[2] === 'apple-darwin' ? 'darwin' : 'linux';
  return { arch: match[1], os };
}

export function targetLayout(triple) {
  const { os, arch } = parseTriple(triple);
  const exe = os === 'windows' ? '.exe' : '';
  const renderLibName = os === 'windows' ? 'simforge_render.dll' : os === 'darwin' ? 'libsimforge_render.dylib' : 'libsimforge_render.so';
  return Object.freeze({
    triple,
    os,
    arch,
    exe,
    runnerName: `simforge-runner${exe}`,
    renderServiceName: `native-render-service${exe}`,
    renderLibName,
    /** Interpreter inside a `python -m venv` environment, relative to it. */
    pythonRelative: os === 'windows' ? 'Scripts/python.exe' : 'bin/python',
    /** The opaque-fd Vulkan->CUDA bridge exists only on Linux. */
    gpuInterop: os === 'linux',
    nodePlatform: os === 'windows' ? 'win32' : os,
    nodeArch: RUST_ARCH_TO_NODE[arch],
  });
}

/** Triple for a Node platform/arch pair (the build host or a packaging target). */
export function tripleForNode(platform = process.platform, arch = process.arch) {
  const triple = SUPPORTED_TARGETS[`${platform}-${arch}`];
  if (!triple) throw new Error(`no native runtime target for ${platform}-${arch}`);
  return triple;
}

/** Host triple as rustc reports it. */
export function hostTriple() {
  const output = execFileSync('rustc', ['-vV'], { encoding: 'utf8', env: childEnv() });
  const match = output.match(/^host:\s*(\S+)$/mu);
  if (!match) throw new Error('rustc -vV did not report a host triple');
  return match[1];
}

/**
 * Installed runtime root when SIMFORGE_NATIVE_RUNTIME_ROOT is unset. Mirrors
 * `nativeRuntimeRoot()` in packages/native-runtime/src/index.ts, which every
 * Node consumer uses; keep the two in step.
 */
export function defaultRuntimeRoot(env = process.env, platform = process.platform) {
  const explicit = env.SIMFORGE_NATIVE_RUNTIME_ROOT?.trim();
  if (explicit) return explicit;
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA?.trim() || path.join(homedir(), 'AppData', 'Local');
    return path.join(base, 'simforge', 'native-runtime');
  }
  if (platform === 'darwin') {
    return path.join(homedir(), 'Library', 'Application Support', 'simforge', 'native-runtime');
  }
  return path.join(env.XDG_DATA_HOME?.trim() || path.join(homedir(), '.local', 'share'), 'simforge', 'native-runtime');
}

/** Cargo's output directory for a build of `triple` under `workspaceRoot`. */
export function cargoReleaseDir(workspaceRoot, triple, host = hostTriple()) {
  return triple === host
    ? path.join(workspaceRoot, 'target', 'release')
    : path.join(workspaceRoot, 'target', triple, 'release');
}
