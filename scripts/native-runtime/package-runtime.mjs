#!/usr/bin/env node
// Builds (via build-runner.mjs) and packages the runtime for one target into
// one distributable archive:
//   dist/native-runtime/simforge-native-runtime-<version>-<triple>.tar.gz  (+ .sha256)
// containing
//   bin/<runner>  bin/<render service>  bin/runtime-manifest.json
//   lib/<render library>
//   share/licenses/  share/sky/ (SOURCES.json + NASA-derived plates, when built)
//   wheels/*.whl  (only with --providers)
//   SHA256SUMS
// Every entry except SHA256SUMS is a manifest component or the runner itself,
// listed with its digest in runtime-manifest.json; nothing is copied by glob.
//
// Usage: node scripts/native-runtime/package-runtime.mjs [build-runner.mjs flags]
//        node scripts/native-runtime/package-runtime.mjs --from-manifest <runtime-manifest.json>
//          (package an existing build without rebuilding)
//
// Pure Node: no tar, gzip, sha256sum or bash on the packaging host. Runs on
// the native target host (cargo builds for it); a cross-built target is never
// executed here.
//
// stdout: {schema:'simforge.native-runtime-package/v1', archive, archiveSha256, runtime}.

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRuntime, parseBuildArgs } from './build-runner.mjs';
import { createRuntimeArchive, sha256File, verifyRuntimeStage, writeChecksums } from './runtime-archive.mjs';
import { cargoReleaseDir, hostTriple, targetLayout } from './target-layout.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = path.join(REPO_ROOT, 'dist', 'native-runtime');

function fail(reason) {
  process.stderr.write(`${JSON.stringify({ code: 'runtime.package_failed', reason })}\n`);
  process.exit(1);
}

function copyInto(stage, relative, source) {
  const target = path.join(stage, ...relative.split('/'));
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(source, target);
}

/**
 * Stages the manifest's closure from the build outputs and packs it. The
 * runner comes from beside the manifest; binaries/libraries from the build
 * directories; assets from their recorded build-time source; wheels from the
 * wheels directory.
 */
export async function packageRuntime({ manifestPath, wheelsDir }) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const layout = targetLayout(manifest.target);
  const host = hostTriple();
  const renderOut = cargoReleaseDir(path.join(REPO_ROOT, 'renderer'), manifest.target, host);
  const buildDir = path.dirname(manifestPath);

  const stage = mkdtempSync(path.join(tmpdir(), 'simforge-runtime-stage-'));
  try {
    copyInto(stage, `bin/${manifest.binary.name}`, path.join(buildDir, manifest.binary.name));
    copyInto(stage, 'bin/runtime-manifest.json', manifestPath);
    for (const component of manifest.components) {
      switch (component.kind) {
        case 'binary':
          copyInto(stage, component.install, path.join(renderOut, component.name));
          break;
        case 'sharedLibrary':
          copyInto(stage, component.install, path.join(renderOut, component.name));
          break;
        case 'wheel':
          if (!wheelsDir) fail(`${component.install} listed but no wheels directory given`);
          copyInto(stage, component.install, path.join(wheelsDir, path.basename(component.install)));
          break;
        case 'asset':
          if (!component.source) fail(`${component.install} has no source path`);
          copyInto(stage, component.install, component.source);
          break;
        default:
          fail(`${component.install}: unknown component kind ${component.kind}`);
      }
    }
    await writeChecksums(stage);
    // Every component the manifest lists must be in the stage with the same bytes.
    await verifyRuntimeStage(stage);

    mkdirSync(DIST, { recursive: true });
    const archive = path.join(DIST, `simforge-native-runtime-${manifest.version}-${layout.triple}.tar.gz`);
    // Reproducible for identical inputs: entry mtimes are the manifest's build time.
    const mtime = Math.floor(Date.parse(manifest.builtAt) / 1000);
    await createRuntimeArchive({ stageDir: stage, archivePath: archive, mtime: Number.isFinite(mtime) ? mtime : 0 });
    const archiveSha256 = await sha256File(archive);
    writeFileSync(`${archive}.sha256`, `${archiveSha256}  ${path.basename(archive)}\n`);
    return { schema: 'simforge.native-runtime-package/v1', archive, archiveSha256, runtime: manifest };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

async function main(argv) {
  const fromIndex = argv.indexOf('--from-manifest');
  let manifestPath;
  let wheelsDir;
  if (fromIndex >= 0) {
    manifestPath = argv[fromIndex + 1];
    if (!manifestPath || manifestPath.startsWith('--')) fail('--from-manifest requires a path');
    manifestPath = path.resolve(manifestPath);
    const rest = [...argv.slice(0, fromIndex), ...argv.slice(fromIndex + 2)];
    if (rest.length > 0) fail(`--from-manifest takes no other arguments (got ${rest.join(' ')})`);
    wheelsDir = path.join(DIST, 'wheels');
  } else {
    const built = buildRuntime(parseBuildArgs(argv));
    manifestPath = built.manifest;
    wheelsDir = built.wheelsDir ?? undefined;
  }
  const report = await packageRuntime({ manifestPath, wheelsDir });
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => fail(error instanceof Error ? error.message : String(error)));
}
