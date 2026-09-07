#!/usr/bin/env node
// Writes the `simforge.native-runtime/v1` manifest for a built runtime bundle.
// The runner refuses to serve jobs unless the manifest beside it describes
// its exact bytes, so this is the last step of every build and the first
// thing an installer copies. Components (render service, render library,
// provider wheels, assets) are listed with digests and support tiers so
// `runtime show` and the installer can prove what a fresh install contains.
//
// Support tiers are emitted per target and only for what the bundle carries:
// cpu-reference always; bevy-sensor-render with the render service; provider
// tiers with wheels. A tier's qualification is the recorded evidence for this
// exact target, otherwise `unqualified` with an explicit blocker.
//
//   node scripts/native-runtime/write-runtime-manifest.mjs \
//     --binary <runner> --out <runtime-manifest.json> --target <triple> \
//     [--render-service <path>] [--render-lib <path>] [--wheels <dir>] [--sky <dir>] \
//     [--revision <40-hex>] [--built-at <rfc3339>]
//
// stdout: the manifest document. Exit 1 on any inconsistency.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { childEnv, hostTriple, targetLayout } from './target-layout.mjs';

const SCHEMA = 'simforge.native-runtime/v1';
const TIERS_SCHEMA = 'simforge.native-runtime-support-tiers/v2';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NATIVE_ROOT = path.join(REPO_ROOT, 'native');
const SKY_SOURCES = path.join(REPO_ROOT, 'renderer/render-core/assets/sky/SOURCES.json');

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

function gitRevision() {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8', env: childEnv() }).trim();
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

function skyComponents(skyDir) {
  // Plates are gitignored derivatives; the committed SOURCES.json pins each
  // product digest and the renderer re-verifies it at startup, so a bundle
  // either carries exact plates or none. Plates may be staged anywhere
  // (--sky); the reference manifest is never taken from the staging dir.
  const sources = JSON.parse(readFileSync(SKY_SOURCES, 'utf8'));
  if (sources.schema !== 'simforge.sky-assets/v1') fail(`${SKY_SOURCES}: unsupported schema ${sources.schema}`);
  const components = [{ kind: 'asset', name: 'SOURCES.json', install: 'share/sky/SOURCES.json', source: SKY_SOURCES, ...digestFile(SKY_SOURCES), tier: 'bevy-sensor-render' }];
  for (const source of sources.sources) {
    const file = path.join(skyDir, source.product);
    const digest = digestFile(file);
    if (digest.sha256 !== source.product_sha256 || digest.sizeBytes !== source.product_bytes) {
      fail(`${file} is ${digest.sha256}/${digest.sizeBytes}, SOURCES.json pins ${source.product_sha256}/${source.product_bytes}; rebuild with renderer/tools/prepare_sky_assets.py`);
    }
    components.push({ kind: 'asset', name: source.product, install: `share/sky/${source.product}`, source: file, ...digest, tier: 'bevy-sensor-render', license: source.license, credit: source.credit });
  }
  return components;
}

/** The declared tier resolved for one target: requirements merged, qualification looked up. */
function resolveTier(declared, layout) {
  const qualified = declared.qualifiedTargets?.[layout.triple];
  const qualification = qualified
    ? { status: 'qualified', blockers: [], evidence: qualified.evidence, observed: qualified.observed ?? [] }
    : {
        status: 'unqualified',
        blockers: [`no installed qualification run recorded for ${layout.triple}; the tier is shipped as capability, not as a claim`],
        observed: [],
      };
  return {
    tier: declared.tier,
    description: declared.description,
    requires: { os: layout.os, arch: layout.arch, ...declared.requires, ...(declared.requiresByOs?.[layout.os] ?? {}) },
    qualification,
  };
}

export function buildRuntimeManifest({ binary, revision, target, builtAt, renderService, renderLib, wheelsDir, skyDir }) {
  if (!/^[0-9a-f]{40}$/u.test(revision)) fail(`revision must be a full lowercase git SHA: ${revision}`);
  const layout = targetLayout(target);
  const version = workspaceVersion();
  const declared = JSON.parse(readFileSync(path.join(REPO_ROOT, 'scripts/native-runtime/support-tiers.json'), 'utf8'));
  if (declared.schema !== TIERS_SCHEMA) fail(`unsupported support-tiers schema ${declared.schema}`);
  const declaredTiers = new Map(declared.tiers.map((tier) => [tier.tier, tier]));
  const shippedTiers = new Set(['cpu-reference']);
  const requireTier = (tier, what) => {
    if (!declaredTiers.has(tier)) fail(`${what} references unknown support tier ${tier}`);
    shippedTiers.add(tier);
    return tier;
  };

  if (path.basename(binary) !== layout.runnerName) fail(`runner binary must be named ${layout.runnerName} for ${target}, got ${path.basename(binary)}`);
  if (Boolean(renderService) !== Boolean(renderLib)) fail('--render-service and --render-lib must be given together');
  if (skyDir && !renderService) fail('--sky is meaningful only with the render service; the plates belong to the bevy-sensor-render tier');
  if (renderService && !skyDir) fail('the render service cannot build a scene without share/sky plates; pass --sky <dir>');

  const components = [];
  const coreNotices = path.join(NATIVE_ROOT, 'crates/simforge-core/THIRD_PARTY_NOTICES');
  components.push({ kind: 'asset', name: 'simforge-core-third-party-notices', install: 'share/licenses/simforge-core.txt', source: coreNotices, ...digestFile(coreNotices), tier: requireTier('cpu-reference', 'core notices') });
  if (renderService) {
    if (path.basename(renderService) !== layout.renderServiceName) fail(`render service must be named ${layout.renderServiceName} for ${target}`);
    if (path.basename(renderLib) !== layout.renderLibName) fail(`render library must be named ${layout.renderLibName} for ${target}`);
    components.push({ kind: 'binary', name: layout.renderServiceName, install: `bin/${layout.renderServiceName}`, ...digestFile(renderService), tier: requireTier('bevy-sensor-render', 'render service') });
    components.push({ kind: 'sharedLibrary', name: layout.renderLibName, install: `lib/${layout.renderLibName}`, ...digestFile(renderLib), tier: requireTier('bevy-sensor-render', 'render library') });
    components.push(...skyComponents(skyDir));
  }
  if (wheelsDir) {
    const wheels = readdirSync(wheelsDir).filter((name) => name.endsWith('.whl')).sort();
    if (wheels.length === 0) fail(`${wheelsDir} contains no wheels`);
    requireTier('python-provider', 'provider environment');
    for (const wheel of wheels) {
      const meta = wheelDistribution(wheel);
      const provider = declared.providers[meta.distribution];
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
    for (const [distribution, provider] of Object.entries(declared.providers)) {
      if (!components.some((component) => component.kind === 'wheel' && component.name === distribution)) {
        fail(`provider ${distribution} (${provider.module}) has no wheel in ${wheelsDir}`);
      }
    }
  }

  const supportTiers = declared.tiers
    .filter((tier) => shippedTiers.has(tier.tier))
    .map((tier) => resolveTier(tier, layout));

  return {
    schema: SCHEMA,
    version,
    revision,
    target,
    builtAt,
    binary: { name: path.basename(binary), ...digestFile(binary) },
    crates: crateVersions(version),
    supportTiers,
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
    target: args.target ?? hostTriple(),
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
