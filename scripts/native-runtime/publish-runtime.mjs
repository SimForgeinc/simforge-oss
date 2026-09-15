#!/usr/bin/env node
// Turns a built native runtime into a publishable, pinnable release asset.
//
//   # package this host's target and print the release entry (touches nothing remote)
//   node scripts/native-runtime/publish-runtime.mjs
//
//   # package an existing build without rebuilding, and record it in the pin
//   node scripts/native-runtime/publish-runtime.mjs \
//     --from-manifest native/target/release/runtime-manifest.json --write-pin
//
//   # publish this leg's archive into the maintainers-only draft release
//   node scripts/native-runtime/publish-runtime.mjs --archive <path> --publish draft --confirm
//
// Flags: --target <triple> | --archive <path> | --from-manifest <path>
//        --write-pin  --publish draft  --confirm  --provenance <text>
//        --gpu-interop <true|false>  --tested <what was exercised on this target>
//
// Conventions this follows rather than reinvents:
//   * The archive is what scripts/native-runtime/package-runtime.mjs already
//     produces (`dist/native-runtime/simforge-native-runtime-<version>-<triple>.tar.gz`
//     plus its `.sha256`), verified here by unpacking it and re-checking the
//     manifest closure with runtime-archive.mjs.
//   * The tag lives in the `native-runtime-*` namespace, never `v*` (the
//     stack's npm/PyPI publish) and never `studio-*` (desktop installers),
//     exactly as studio/desktop/release-identity.mjs reserves those.
//   * CI creates a maintainers-only DRAFT; making a release public stays a
//     deliberate act by the release owner, as for desktop installers.
//   * The recorded ABI is the number this checkout's Rust builds and its
//     TypeScript requires, proved equal first (scripts/native-runtime/abi.mjs).
//     A checkout whose two ABI constants disagree cannot publish at all.
//
// stdout: {schema:'simforge.native-runtime-publish/v1', tag, target, entry,
//          abi, archive, published, pinned}. Exit 1 with {code, reason} on stderr.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { agreedAbi } from './abi.mjs';
import { buildRuntime, parseBuildArgs } from './build-runner.mjs';
import { packageRuntime } from './package-runtime.mjs';
import { extractRuntimeArchive, sha256File, verifyRuntimeStage } from './runtime-archive.mjs';
import { hostTriple, targetLayout, tripleForNode } from './target-layout.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PIN_FILE = path.join(REPO_ROOT, 'scripts/native-runtime/runtime-release.json');
const TAG_PREFIX = 'native-runtime-';

function fail(reason, code = 'runtime.publish_failed') {
  process.stderr.write(`${JSON.stringify({ code, reason })}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { target: undefined, archive: undefined, fromManifest: undefined, writePin: false, publish: 'none', confirm: false, provenance: undefined, gpuInterop: undefined, tested: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--write-pin') { options.writePin = true; continue; }
    if (flag === '--confirm') { options.confirm = true; continue; }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) fail(`${flag} requires a value`, 'runtime.usage');
    switch (flag) {
      case '--target': options.target = value; break;
      case '--archive': options.archive = path.resolve(value); break;
      case '--from-manifest': options.fromManifest = path.resolve(value); break;
      case '--publish': options.publish = value; break;
      case '--provenance': options.provenance = value; break;
      case '--tested': options.tested = value; break;
      case '--gpu-interop':
        if (value !== 'true' && value !== 'false') fail('--gpu-interop takes true or false', 'runtime.usage');
        options.gpuInterop = value === 'true';
        break;
      default: fail(`unknown argument ${flag}`, 'runtime.usage');
    }
    i += 1;
  }
  if (options.publish !== 'none' && options.publish !== 'draft') fail("--publish takes none or draft; a public release is the release owner's deliberate step", 'runtime.usage');
  if (options.archive && options.fromManifest) fail('--archive and --from-manifest are alternatives', 'runtime.usage');
  return options;
}

export function releaseTag(version, revision) {
  return `${TAG_PREFIX}${version}-${revision.slice(0, 12)}`;
}

/**
 * A publishable runtime must be able to build a scene. `build-runner.mjs
 * --no-sky` produces a bundle with no render service and no sky plates: it
 * builds and installs cleanly and then refuses every render, which is a worse
 * trap than a missing toolchain because it looks like success. Publishing one
 * is refused here, where the archive is still just a file.
 */
function assertRenderable(archive, manifest) {
  const layout = targetLayout(manifest.target);
  const installed = manifest.components.map((component) => component.install);
  const required = [`bin/${layout.renderServiceName}`, `lib/${layout.renderLibName}`, 'share/sky/SOURCES.json'];
  const missing = required.filter((install) => !installed.includes(install));
  const plates = installed.filter((install) => install.startsWith('share/sky/') && install.endsWith('.skytex'));
  if (missing.length > 0 || plates.length === 0) {
    fail(
      `${archive} cannot render: its manifest lists no ${[...missing, ...(plates.length === 0 ? ['share/sky/*.skytex plate'] : [])].join(', ')}. `
        + 'A runtime packaged with --no-sky installs and then refuses every render; publish a full build instead.',
      'runtime.not_renderable',
    );
  }
}

/** Everything the pin needs about one archive, read out of the archive itself. */
async function describeArchive({ archive, abi, provenance, gpuInterop }) {
  const stage = mkdtempSync(path.join(tmpdir(), 'simforge-runtime-verify-'));
  try {
    await extractRuntimeArchive(archive, stage);
    const manifest = await verifyRuntimeStage(stage);
    const sidecar = path.join(path.dirname(archive), `${path.basename(archive)}.sha256`);
    const sha256 = await sha256File(archive);
    let declared = null;
    try {
      declared = readFileSync(sidecar, 'utf8').trim().split(/\s+/u)[0];
    } catch {
      declared = null;
    }
    if (declared && declared !== sha256) fail(`${sidecar} declares ${declared} but ${archive} is ${sha256}`);
    assertRenderable(archive, manifest);
    return {
      manifest,
      entry: {
        archive: path.basename(archive),
        sha256,
        sizeBytes: statSync(archive).size,
        // Which Linux feature set the bytes carry cannot be read back out of
        // the archive, so it is recorded only when this invocation built them
        // (always --no-gpu-interop: a published runtime must run on a machine
        // with no CUDA present). Packaging an archive built elsewhere records
        // `null` rather than guessing.
        gpuInterop,
        // Never inferred. A target is "tested" only when someone states what
        // they exercised on it; the three targets nobody ran stay null, and
        // fetch-runtime.mjs passes the value through to the installer.
        tested: null,
        provenance: provenance ?? 'unstated',
      },
    };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function writePin({ manifest, target, entry, abi }) {
  const pin = JSON.parse(readFileSync(PIN_FILE, 'utf8'));
  if (!(target in pin.targets)) fail(`${target} is not a target of ${PIN_FILE}`);
  const tag = releaseTag(manifest.version, manifest.revision);
  // One pin describes one revision: mixing archives from different revisions
  // would publish a runtime set no single source tree ever produced.
  const sameRelease = pin.revision === manifest.revision && pin.version === manifest.version && pin.abi === abi;
  if (!sameRelease) {
    for (const key of Object.keys(pin.targets)) pin.targets[key] = null;
    pin.version = manifest.version;
    pin.revision = manifest.revision;
    pin.abi = abi;
    pin.tag = tag;
  }
  pin.targets[target] = entry;
  writeFileSync(PIN_FILE, `${JSON.stringify(pin, null, 2)}\n`);
  return { tag, reset: !sameRelease };
}

function gh(args) {
  const result = spawnSync('gh', args, { cwd: REPO_ROOT, encoding: 'utf8' });
  if (result.error) fail(`gh ${args.join(' ')}: ${result.error.message}`);
  return result;
}

/** Uploads into a maintainers-only draft release, creating it on the first leg. */
function publishDraft({ tag, archive, repository }) {
  const existing = gh(['release', 'view', tag, '--repo', repository, '--json', 'isDraft']);
  if (existing.status !== 0) {
    const created = gh([
      'release', 'create', tag, '--repo', repository, '--draft',
      '--title', `SimForge native runtime ${tag.slice(TAG_PREFIX.length)}`,
      '--notes', 'Prebuilt native runtime archives. Pinned by scripts/native-runtime/runtime-release.json and verified by digest and binding ABI at install time.',
    ]);
    if (created.status !== 0) fail(`gh release create ${tag} failed: ${created.stderr.trim()}`);
  } else if (JSON.parse(existing.stdout).isDraft !== true) {
    fail(`${tag} is already a published release; the assets of a published runtime are immutable`);
  }
  for (const asset of [archive, `${archive}.sha256`]) {
    const uploaded = gh(['release', 'upload', tag, asset, '--repo', repository, '--clobber']);
    if (uploaded.status !== 0) fail(`gh release upload ${path.basename(asset)} failed: ${uploaded.stderr.trim()}`);
  }
  return 'draft';
}

async function main(argv) {
  const options = parseArgs(argv);
  const abi = agreedAbi();
  let archive = options.archive;
  let gpuInterop = null;
  if (!archive) {
    let manifestPath = options.fromManifest;
    if (!manifestPath) {
      const built = buildRuntime(parseBuildArgs([...(options.target ? ['--target', options.target] : []), '--no-gpu-interop']));
      manifestPath = built.manifest;
      gpuInterop = built.gpuInterop;
    }
    archive = (await packageRuntime({ manifestPath })).archive;
  }
  const { manifest, entry } = await describeArchive({ archive, abi, provenance: options.provenance, gpuInterop: options.gpuInterop ?? gpuInterop });
  const target = options.target ?? manifest.target;
  if (manifest.target !== target) fail(`${archive} is built for ${manifest.target}, not ${target}`);
  const tag = releaseTag(manifest.version, manifest.revision);
  if (options.tested !== null) {
    // A claim about running the bytes can only be made where they can run.
    if (manifest.target !== tripleForNode() || manifest.target !== hostTriple()) {
      fail(`--tested claims ${manifest.target} was exercised, but this host is ${hostTriple()}; a cross-built target cannot be tested here`);
    }
    entry.tested = options.tested;
  }

  const pin = JSON.parse(readFileSync(PIN_FILE, 'utf8'));
  let published = 'none';
  if (options.publish === 'draft') {
    if (!options.confirm) fail('--publish draft needs --confirm; nothing remote happens without it', 'runtime.usage');
    published = publishDraft({ tag, archive, repository: pin.repository });
  }
  if (options.writePin) writePin({ manifest, target, entry, abi });

  return { schema: 'simforge.native-runtime-publish/v1', tag, target, entry, abi, archive, published, pinned: options.writePin };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
    .then((report) => process.stdout.write(`${JSON.stringify(report)}\n`))
    .catch((error) => fail(error instanceof Error ? error.message : String(error)));
}
