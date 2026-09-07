#!/usr/bin/env node
// Builds every native component of the runtime bundle for one target and
// writes the runtime manifest beside the runner binary. Runs on Linux, macOS
// and Windows build hosts with only cargo, git and node (plus maturin and a
// Python build environment when --providers is requested).
//
// Produces under native/target/[<triple>/]release:
//   simforge-runner[.exe], runtime-manifest.json
// and under renderer/target/[<triple>/]release:
//   native-render-service[.exe], libsimforge_render.so | libsimforge_render.dylib | simforge_render.dll
//   (built with --features gpu-interop on Linux targets only; the feature is
//   the opaque-fd Vulkan->CUDA bridge and does not exist elsewhere)
// and, only with --providers, wheels under dist/native-runtime/wheels/ for the
// Python providers (simforge-oss-gym via maturin, -physics, -gpu,
// -native-renderer, -splat via `python -m build`). The baseline bundle carries
// no Python, CUDA or research environment.
//
// Sky plates: renderer/render-core/assets/sky/*.skytex (gitignored derivatives
// from renderer/tools/prepare_sky_assets.py) are packaged into share/sky and
// verified against SOURCES.json; without them the renderer cannot build a
// scene, so the build fails unless --no-sky is passed explicitly (producing a
// runtime without the bevy-sensor-render tier and without the render service).
//
// Usage: node scripts/native-runtime/build-runner.mjs [--target <triple>] [--offline]
//          [--providers] [--no-gpu-interop] [--no-sky] [--sky <dir>] [--python <interpreter>]
//   --sky <dir>  directory holding the .skytex plates (default
//                renderer/render-core/assets/sky). The canonical
//                renderer/render-core/assets/sky/SOURCES.json is always the
//                verification reference; a SOURCES.json in <dir> is ignored.
//
// The built runner is asked to accept its own manifest (`runtime show`) only
// when the target is the build host; a cross-built binary is never executed
// here, and the report says so (`selfCheck: "deferred"`), leaving the proof
// to install-runtime.mjs on the target machine.
//
// stdout: one JSON document describing the outputs. Exit 1 on failure.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cargoReleaseDir, childEnv, hostTriple, targetLayout } from './target-layout.mjs';
import { buildRuntimeManifest } from './write-runtime-manifest.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NATIVE_ROOT = path.join(REPO_ROOT, 'native');
const RENDERER_ROOT = path.join(REPO_ROOT, 'renderer');
const WHEELS_DIR = path.join(REPO_ROOT, 'dist', 'native-runtime', 'wheels');
const DEFAULT_SKY_DIR = path.join(RENDERER_ROOT, 'render-core', 'assets', 'sky');
const SKY_PLATES = ['starmap_2020_8k.skytex', 'moon_lroc_4k.skytex'];
const PURE_PROVIDER_PACKAGES = ['adapters/physics', 'adapters/gpu', 'renderer/service/python', 'renderer/splat/python'];

function fail(reason) {
  process.stderr.write(`${JSON.stringify({ code: 'runner.build_failed', reason })}\n`);
  process.exit(1);
}

export function parseBuildArgs(argv) {
  const options = { target: undefined, offline: false, providers: false, gpuInterop: undefined, sky: DEFAULT_SKY_DIR, python: process.platform === 'win32' ? 'python' : 'python3' };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) fail(`${flag} requires a value`);
      i += 1;
      return next;
    };
    switch (flag) {
      case '--target': options.target = value(); break;
      case '--offline': options.offline = true; break;
      case '--providers': options.providers = true; break;
      case '--no-gpu-interop': options.gpuInterop = false; break;
      case '--no-sky': options.sky = null; break;
      case '--sky': options.sky = path.resolve(value()); break;
      case '--python': options.python = value(); break;
      default: fail(`unknown argument ${flag}`);
    }
  }
  return options;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: ['ignore', 'inherit', 'inherit'], env: childEnv() });
  if (result.error) fail(`${command} ${args.join(' ')}: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${args.join(' ')} exited ${result.status ?? `signal ${result.signal}`}`);
}

export function buildRuntime(options) {
  const host = hostTriple();
  const target = options.target ?? host;
  const layout = targetLayout(target);
  const cross = target !== host;
  const gpuInterop = options.gpuInterop ?? layout.gpuInterop;
  if (gpuInterop && !layout.gpuInterop) fail(`gpu-interop is the Linux opaque-fd Vulkan->CUDA bridge; it cannot be enabled for ${target}`);

  const cargoCommon = ['build', '--release', '--locked', ...(options.offline ? ['--offline'] : []), ...(cross ? ['--target', target] : [])];
  const nativeOut = cargoReleaseDir(NATIVE_ROOT, target, host);
  const renderOut = cargoReleaseDir(RENDERER_ROOT, target, host);

  run('cargo', [...cargoCommon, '-p', 'simforge-runner'], NATIVE_ROOT);
  const runner = path.join(nativeOut, layout.runnerName);
  if (!existsSync(runner)) fail(`${runner} missing after build`);

  let renderService;
  let renderLib;
  if (options.sky !== null) {
    for (const plate of SKY_PLATES) {
      if (!existsSync(path.join(options.sky, plate))) {
        fail(`${path.join(options.sky, plate)} missing; run renderer/tools/prepare_sky_assets.py (needs the NASA originals in renderer/assets-src) or pass --no-sky`);
      }
    }
    run('cargo', [...cargoCommon, '-p', 'service', '-p', 'render-ffi', ...(gpuInterop ? ['--features', 'gpu-interop'] : [])], RENDERER_ROOT);
    renderService = path.join(renderOut, layout.renderServiceName);
    renderLib = path.join(renderOut, layout.renderLibName);
    if (!existsSync(renderService)) fail(`${renderService} missing after build`);
    if (!existsSync(renderLib)) fail(`${renderLib} missing after build`);
  }

  let wheelsDir;
  if (options.providers) {
    mkdirSync(WHEELS_DIR, { recursive: true });
    for (const stale of readdirSync(WHEELS_DIR)) {
      if (stale.endsWith('.whl')) rmSync(path.join(WHEELS_DIR, stale));
    }
    // simforge-oss-gym carries the PyO3 extension; maturin builds it against
    // the native workspace crate named in its pyproject, for the same target.
    run('maturin', ['build', '--release', ...(cross ? ['--target', target] : []), '--out', WHEELS_DIR], path.join(REPO_ROOT, 'adapters', 'gym'));
    for (const pkg of PURE_PROVIDER_PACKAGES) {
      run(options.python, ['-m', 'build', '--wheel', '--outdir', WHEELS_DIR], path.join(REPO_ROOT, ...pkg.split('/')));
    }
    wheelsDir = WHEELS_DIR;
  }

  const manifestPath = path.join(nativeOut, 'runtime-manifest.json');
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8', env: childEnv() }).trim();
  const manifest = buildRuntimeManifest({
    binary: runner,
    revision,
    target,
    builtAt: new Date().toISOString(),
    renderService,
    renderLib,
    wheelsDir,
    skyDir: options.sky ?? undefined,
  });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  // The binary must accept its own manifest before it is called a build,
  // but only a host-native binary can run here.
  let selfCheck;
  if (cross) {
    selfCheck = { status: 'deferred', reason: `target ${target} differs from build host ${host}; install-runtime.mjs verifies on the target` };
  } else {
    const shown = spawnSync(runner, ['runtime', 'show'], { encoding: 'utf8', env: childEnv(process.env, { SIMFORGE_RUNTIME_MANIFEST: manifestPath }) });
    if (shown.error || shown.status !== 0) fail(`${runner} runtime show failed: ${shown.error?.message ?? shown.stderr}`);
    selfCheck = { status: 'passed', runtimeId: JSON.parse(shown.stdout).runtimeId };
  }

  return {
    schema: 'simforge.native-runtime-build/v1',
    target,
    host,
    runner,
    manifest: manifestPath,
    renderService: renderService ?? null,
    renderLib: renderLib ?? null,
    wheelsDir: wheelsDir ?? null,
    gpuInterop,
    selfCheck,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = buildRuntime(parseBuildArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
