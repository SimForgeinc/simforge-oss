#!/usr/bin/env node
// Writes the `simforge.native-runtime/v1` manifest for a built runtime bundle.
// The runner refuses to serve jobs unless the manifest beside it describes
// its exact bytes, so this is the last step of every build and the first
// thing an installer copies. Components (render service, FFI library,
// provider wheels) are listed with digests and support tiers so `runtime show`
// and the installer can prove what a fresh install actually contains.
//
//   node scripts/native-runtime/write-runtime-manifest.mjs \
//     --binary native/target/release/simforge-runner \
//     --out native/target/release/runtime-manifest.json \
//     [--render-service <path>] [--render-lib <path>] [--wheels <dir>] [--sky <dir>] \
//     [--revision <40-hex>] [--target <triple>] [--built-at <rfc3339>]
//
// stdout: the manifest document. Exit 1 on any inconsistency.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA = 'simforge.native-runtime/v1';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NATIVE_ROOT = path.join(REPO_ROOT, 'native');

function fail(reason) {
  process.stderr.write(`${JSON.stringify({ code: 'runtime.manifest_write_failed', reason })}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!flag.startsWith('--')) fail(`unexpected argument ${flag}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) fail(`${flag} requires a value`);
    if (value === '') { i += 1; continue; }
    args[flag.slice(2)] = value;
    i += 1;
  }
  return args;
}

function tomlValue(source, key) {
  const match = source.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'mu'));
  return match ? match[1] : undefined;
}

function workspaceVersion() {
  const version = tomlValue(readFileSync(path.join(NATIVE_ROOT, 'Cargo.toml'), 'utf8'), 'version');
  if (!version) fail('native/Cargo.toml has no [workspace.package] version');
  return version;
}

function crateVersions(version) {
  const crates = {};
  for (const entry of readdirSync(path.join(NATIVE_ROOT, 'crates'))) {
    const manifestPath = path.join(NATIVE_ROOT, 'crates', entry, 'Cargo.toml');
    let source;
    try {
      source = readFileSync(manifestPath, 'utf8');
    } catch {
      continue;
    }
    const name = tomlValue(source, 'name');
    if (!name) continue;
    crates[name] = /^version\.workspace\s*=\s*true/mu.test(source) ? version : (tomlValue(source, 'version') ?? version);
  }
  return crates;
}

function hostTarget() {
  const output = execFileSync('rustc', ['-vV'], { encoding: 'utf8' });
  const match = output.match(/^host:\s*(\S+)$/mu);
  if (!match) fail('rustc -vV did not report a host triple');
  return match[1];
}

function gitRevision() {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}

function digestFile(file) {
  const stats = statSync(file);
  if (!stats.isFile()) fail(`${file} is not a file`);
  return { sha256: createHash('sha256').update(readFileSync(file)).digest('hex'), sizeBytes: stats.size };
}

function wheelDistribution(fileName) {
  // PEP 427: {distribution}-{version}(-{build})?-{python}-{abi}-{platform}.whl
  const match = fileName.match(/^([A-Za-z0-9_.]+)-([A-Za-z0-9_.!+]+)(?:-\d[^-]*)?-([^-]+)-([^-]+)-([^-]+)\.whl$/u);
  if (!match) fail(`${fileName} is not a valid wheel file name`);
  return { distribution: match[1].replace(/_/gu, '-').toLowerCase(), version: match[2], platform: match[5] };
}

const SKY_SOURCES = path.join(REPO_ROOT, 'renderer/render-core/assets/sky/SOURCES.json');

function skyComponents(skyDir, requireTier) {
  // Plates are gitignored derivatives; the committed SOURCES.json pins each
  // product digest and the renderer re-verifies it at startup, so a bundle
  // either carries exact plates or none. Plates may be staged anywhere
  // (--sky); the reference manifest is never taken from the staging dir.
  const sourcesPath = SKY_SOURCES;
  const sources = JSON.parse(readFileSync(sourcesPath, 'utf8'));
  if (sources.schema !== 'simforge.sky-assets/v1') fail(`${sourcesPath}: unsupported schema ${sources.schema}`);
  const components = [{ kind: 'asset', name: 'SOURCES.json', install: 'share/sky/SOURCES.json', source: sourcesPath, ...digestFile(sourcesPath), tier: requireTier('bevy-sensor-render', 'sky sources') }];
  for (const source of sources.sources) {
    const file = path.join(skyDir, source.product);
    const digest = digestFile(file);
    if (digest.sha256 !== source.product_sha256 || digest.sizeBytes !== source.product_bytes) {
      fail(`${file} is ${digest.sha256}/${digest.sizeBytes}, SOURCES.json pins ${source.product_sha256}/${source.product_bytes}; rebuild with renderer/tools/prepare_sky_assets.py`);
    }
    components.push({ kind: 'asset', name: source.product, install: `share/sky/${source.product}`, source: file, ...digest, tier: requireTier('bevy-sensor-render', `sky plate ${source.product}`), license: source.license, credit: source.credit });
  }
  return components;
}

export function buildRuntimeManifest({ binary, revision, target, builtAt, renderService, renderLib, wheelsDir, skyDir }) {
  if (!/^[0-9a-f]{40}$/u.test(revision)) fail(`revision must be a full lowercase git SHA: ${revision}`);
  const version = workspaceVersion();
  const tiers = JSON.parse(readFileSync(path.join(REPO_ROOT, 'scripts/native-runtime/support-tiers.json'), 'utf8'));
  if (tiers.schema !== 'simforge.native-runtime-support-tiers/v1') fail('unsupported support-tiers schema');
  const tierIds = new Set(tiers.tiers.map((tier) => tier.tier));
  const requireTier = (tier, what) => {
    if (!tierIds.has(tier)) fail(`${what} references unknown support tier ${tier}`);
    return tier;
  };

  const components = [];
  const coreNotices = path.join(NATIVE_ROOT, 'crates/simforge-core/THIRD_PARTY_NOTICES');
  components.push({ kind: 'asset', name: 'simforge-core-third-party-notices', install: 'share/licenses/simforge-core.txt', source: coreNotices, ...digestFile(coreNotices), tier: requireTier('cpu-reference', 'core notices') });
  if (renderService) {
    components.push({ kind: 'binary', name: 'native-render-service', install: 'bin/native-render-service', ...digestFile(renderService), tier: requireTier('bevy-sensor-render', 'render service') });
  }
  if (renderLib) {
    components.push({ kind: 'sharedLibrary', name: 'libsimforge_render.so', install: 'lib/libsimforge_render.so', ...digestFile(renderLib), tier: requireTier('bevy-sensor-render', 'render library') });
  }
  if (skyDir) components.push(...skyComponents(skyDir, requireTier));
  if (wheelsDir) {
    const wheels = readdirSync(wheelsDir).filter((name) => name.endsWith('.whl')).sort();
    if (wheels.length === 0) fail(`${wheelsDir} contains no wheels`);
    for (const wheel of wheels) {
      const meta = wheelDistribution(wheel);
      const provider = tiers.providers[meta.distribution];
      if (!provider) fail(`no provider entry in support-tiers.json for wheel ${meta.distribution}`);
      components.push({
        kind: 'wheel',
        name: meta.distribution,
        version: meta.version,
        platform: meta.platform,
        install: `wheels/${wheel}`,
        module: provider.module,
        ...digestFile(path.join(wheelsDir, wheel)),
        tier: requireTier(provider.tier, `wheel ${meta.distribution}`),
      });
    }
    for (const [distribution, provider] of Object.entries(tiers.providers)) {
      if (!components.some((component) => component.kind === 'wheel' && component.name === distribution)) {
        fail(`provider ${distribution} (${provider.module}) has no wheel in ${wheelsDir}`);
      }
    }
  }

  return {
    schema: SCHEMA,
    version,
    revision,
    target,
    builtAt,
    binary: { name: path.basename(binary), ...digestFile(binary) },
    crates: crateVersions(version),
    supportTiers: tiers.tiers,
    components,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.binary) fail('--binary is required');
  if (!args.out) fail('--out is required');
  const manifest = buildRuntimeManifest({
    binary: path.resolve(args.binary),
    revision: args.revision ?? gitRevision(),
    target: args.target ?? hostTarget(),
    builtAt: args['built-at'] ?? new Date().toISOString(),
    renderService: args['render-service'] ? path.resolve(args['render-service']) : undefined,
    renderLib: args['render-lib'] ? path.resolve(args['render-lib']) : undefined,
    wheelsDir: args.wheels ? path.resolve(args.wheels) : undefined,
    skyDir: args.sky ? path.resolve(args.sky) : undefined,
  });
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(path.resolve(args.out), text);
  process.stdout.write(text);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
