#!/usr/bin/env node
// Installs a packaged native runtime archive into the runtime root that the
// runner, local Studio host, CLI and Python providers discover:
//
//   ROOT = --root | $SIMFORGE_NATIVE_RUNTIME_ROOT | OS default
//          (Linux ${XDG_DATA_HOME:-~/.local/share}/simforge/native-runtime,
//           macOS ~/Library/Application Support/simforge/native-runtime,
//           Windows %LOCALAPPDATA%\simforge\native-runtime)
//   ROOT/runtimes/<generation>/        one immutable installed runtime:
//     bin/{simforge-runner[.exe], native-render-service[.exe], runtime-manifest.json}
//     lib/<render library>  share/**  wheels/*.whl (provider bundles only)
//     venv/                            provider environment built in place from wheels/
//   ROOT/bin ROOT/lib ROOT/share ROOT/wheels ROOT/venv
//          links (symlinks; directory junctions on Windows) into the active
//          generation, so `<ROOT>/bin/simforge-runner` stays the discovery path
//
// Usage: node scripts/native-runtime/install-runtime.mjs <archive.tar.gz>
//          [--root <dir>] [--python <interpreter>] [--extras <a,b>]
//   --python  interpreter used to create the provider venv (default python3,
//             python on Windows); only consulted when the archive carries wheels.
//   --extras  optional provider extras (default none): articulated-warp
//             (simforge-oss-physics[warp]), gpu-torch (simforge-oss-gpu[torch]),
//             renderer-torch (simforge-oss-native-renderer[torch]).
//
// Guarantees:
// - The archive is verified (SHA256SUMS, manifest closure, binary digest) and
//   must be built for this machine's OS/arch; installing a foreign target is
//   refused rather than "staged".
// - A generation is named by version, revision and runner digest and is never
//   modified after activation: an identical re-install reuses it, a different
//   bundle with the same name is an error, and older generations are never
//   removed by this script (a job may still be pinned to any of them; its
//   checkpoints only resume on the exact runtime that wrote them).
// - The provider venv is created at its final path (pip writes absolute
//   interpreter paths into console-script shebangs) and every provider module
//   is import-checked in its own interpreter before activation; a failed build
//   removes only the generation this invocation created.
// - Activation repoints the ROOT links. On POSIX each link is replaced with
//   rename(2), atomically. Windows cannot atomically replace a directory
//   junction, so each link is removed and recreated (a discovery in that
//   window sees a missing path, never a mixed runtime).
// - Never touches writable jobs, CAS or worker state (SIMFORGE_NATIVE_RUNTIME_STATE_ROOT).
//
// stdout: {schema:'simforge.native-runtime-install/v1', root, generation, reused,
//          providerEnvironment, runtime: <`runtime show` document>}.

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, rmdirSync, symlinkSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { extractRuntimeArchive, verifyRuntimeStage } from './runtime-archive.mjs';
import { childEnv, defaultRuntimeRoot, targetLayout } from './target-layout.mjs';

const PARTS = ['bin', 'lib', 'share', 'wheels', 'venv'];
const EXTRAS = { 'simforge-oss-physics': ['articulated-warp', 'warp'], 'simforge-oss-gpu': ['gpu-torch', 'torch'], 'simforge-oss-native-renderer': ['renderer-torch', 'torch'] };

function fail(reason, code = 'runner.install_failed') {
  process.stderr.write(`${JSON.stringify({ code, reason })}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const [archive, ...rest] = argv;
  if (!archive || archive.startsWith('--')) fail('usage: install-runtime.mjs <archive.tar.gz> [--root <dir>] [--python <interpreter>] [--extras <a,b>]', 'runner.usage');
  const options = { archive: path.resolve(archive), root: undefined, python: process.platform === 'win32' ? 'python' : 'python3', extras: [] };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (value === undefined || value.startsWith('--')) fail(`${flag} requires a value`, 'runner.usage');
    switch (flag) {
      case '--root': options.root = path.resolve(value); break;
      case '--python': options.python = value; break;
      case '--extras': options.extras = value.split(',').map((extra) => extra.trim()).filter(Boolean); break;
      default: fail(`unknown argument ${flag}`, 'runner.usage');
    }
    i += 1;
  }
  return options;
}

function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, { stdio: ['ignore', 'inherit', 'inherit'], env: childEnv(process.env, extraEnv) });
  if (result.error) throw new Error(`${command} ${args.join(' ')}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.status ?? `signal ${result.signal}`}`);
}

function linkState(target) {
  try {
    const info = lstatSync(target);
    return info.isSymbolicLink() ? 'link' : 'real';
  } catch {
    return 'absent';
  }
}

/** Points `linkPath` at `targetDir`, replacing any existing link. */
function swapLink(linkPath, targetDir, root) {
  if (process.platform === 'win32') {
    if (linkState(linkPath) === 'link') rmdirSync(linkPath);
    symlinkSync(targetDir, linkPath, 'junction');
    return;
  }
  const temp = `${linkPath}.link.${process.pid}`;
  rmSync(temp, { force: true });
  symlinkSync(path.relative(root, targetDir), temp);
  renameSync(temp, linkPath);
}

function removeLink(linkPath) {
  if (process.platform === 'win32') rmdirSync(linkPath);
  else unlinkSync(linkPath);
}

function wheelDistribution(fileName) {
  return fileName.split('-')[0].replace(/_/gu, '-').toLowerCase();
}

function buildProviderEnvironment({ generationDir, layout, manifest, python, extras }) {
  const venvDir = path.join(generationDir, 'venv');
  const interpreter = path.join(venvDir, ...layout.pythonRelative.split('/'));
  if (existsSync(interpreter)) return 'reused';
  rmSync(venvDir, { recursive: true, force: true }); // a half-built environment from an interrupted install
  const wheelsDir = path.join(generationDir, 'wheels');
  const specs = readdirSync(wheelsDir)
    .filter((name) => name.endsWith('.whl'))
    .sort()
    .map((wheel) => {
      const distribution = wheelDistribution(wheel);
      const extra = EXTRAS[distribution];
      const suffix = extra && extras.includes(extra[0]) ? `[${extra[1]}]` : '';
      return `${distribution}${suffix} @ ${pathToFileURL(path.join(wheelsDir, wheel)).href}`;
    });
  run(python, ['-m', 'venv', venvDir]);
  run(interpreter, ['-m', 'pip', 'install', '--quiet', '--upgrade', 'pip']);
  run(interpreter, ['-m', 'pip', 'install', '--quiet', '--find-links', wheelsDir, ...specs]);
  // Each import runs in its own interpreter process: a failing module cannot
  // mask or poison the others.
  for (const component of manifest.components) {
    if (component.kind !== 'wheel') continue;
    const check = spawnSync(interpreter, ['-c', `import importlib; importlib.import_module(${JSON.stringify(component.module)})`], { stdio: ['ignore', 'inherit', 'inherit'], env: childEnv() });
    if (check.status !== 0) throw new Error(`provider module ${component.module} failed to import from ${venvDir} (exit ${check.status ?? `signal ${check.signal}`})`);
  }
  return 'built';
}

export function installRuntime(options) {
  if (!existsSync(options.archive)) fail(`${options.archive} does not exist`, 'runner.usage');
  const root = options.root ?? defaultRuntimeRoot();
  mkdirSync(path.join(root, 'runtimes'), { recursive: true });
  for (const part of PARTS) {
    if (linkState(path.join(root, part)) === 'real') {
      fail(`${path.join(root, part)} is a real directory; this installer manages ROOT/${part} as a link into ROOT/runtimes/. Install into a fresh root (--root) or move the directory aside.`);
    }
  }

  const incoming = path.join(root, 'runtimes', `.incoming-${process.pid}-${Date.now()}`);
  let createdGeneration = null;
  const cleanup = () => {
    rmSync(incoming, { recursive: true, force: true });
    if (createdGeneration) rmSync(createdGeneration, { recursive: true, force: true });
  };
  return (async () => {
    let manifest;
    let layout;
    let generationDir;
    let reused = false;
    try {
      await extractRuntimeArchive(options.archive, incoming);
      manifest = await verifyRuntimeStage(incoming);
      layout = targetLayout(manifest.target);
      if (layout.nodePlatform !== process.platform || layout.nodeArch !== process.arch) {
        throw new Error(`archive is built for ${manifest.target}; this machine is ${process.platform}-${process.arch}. Install the archive for this target.`);
      }
      const generation = `${manifest.version}-${manifest.revision.slice(0, 12)}-${manifest.binary.sha256.slice(0, 12)}`;
      generationDir = path.join(root, 'runtimes', generation);
      if (existsSync(generationDir)) {
        const installed = readFileSync(path.join(generationDir, 'bin', 'runtime-manifest.json'));
        const incomingManifest = readFileSync(path.join(incoming, 'bin', 'runtime-manifest.json'));
        if (!installed.equals(incomingManifest)) {
          throw new Error(`${generationDir} already holds a different runtime manifest; generations are immutable. Remove it only if no job is pinned to it.`);
        }
        reused = true;
        rmSync(incoming, { recursive: true, force: true });
      } else {
        renameSync(incoming, generationDir);
        createdGeneration = generationDir;
      }

      let providerEnvironment = 'none';
      if (manifest.components.some((component) => component.kind === 'wheel')) {
        providerEnvironment = buildProviderEnvironment({ generationDir, layout, manifest, python: options.python, extras: options.extras });
      }

      // Activate: every part of this generation becomes ROOT/<part>; links to
      // parts this generation lacks are removed so ROOT never mixes generations.
      for (const part of PARTS) {
        const target = path.join(generationDir, part);
        const link = path.join(root, part);
        if (existsSync(target)) swapLink(link, target, root);
        else if (linkState(link) === 'link') removeLink(link);
      }
      createdGeneration = null; // activated: no longer ours to remove

      const runner = path.join(root, 'bin', layout.runnerName);
      const shown = spawnSync(runner, ['runtime', 'show'], { encoding: 'utf8', env: childEnv(process.env, { SIMFORGE_NATIVE_RUNTIME_ROOT: root }) });
      if (shown.error) throw new Error(`${runner} could not be executed: ${shown.error.message}`);
      if (shown.status !== 0) throw new Error(`${runner} runtime show failed: ${shown.stderr.trim()}`);
      return {
        schema: 'simforge.native-runtime-install/v1',
        root,
        generation: generationDir,
        reused,
        providerEnvironment,
        runtime: JSON.parse(shown.stdout),
      };
    } catch (error) {
      cleanup();
      throw error;
    }
  })();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  installRuntime(parseArgs(process.argv.slice(2)))
    .then((report) => process.stdout.write(`${JSON.stringify(report)}\n`))
    .catch((error) => fail(error instanceof Error ? error.message : String(error)));
}
