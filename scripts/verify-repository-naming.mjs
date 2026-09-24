#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REMOVED_PATHS = [
  'apps/studio',
  'apps/cloud',
  'adapters/carla-api',
  'packages/editor-ui',
  'packages/scenario-model',
  'packages/sim-engine',
  'packages/scene-state',
  'packages/xodr-tools',
  'packages/map-intel',
  'packages/anchor-matcher',
  'packages/scenario-materializer',
  'packages/city-renderer',
  'packages/camera-rig',
  'packages/editor-core',
  'packages/ambient-traffic',
  'packages/prop-catalog',
  'packages/render-runtime',
  'packages/browser-renderer',
  'packages/native-renderer',
  'packages/esmini-runner',
  'packages/trace-comparator',
  'packages/rl-env',
  'packages/policy-eval',
  'packages/examiner',
];

// Product-only surfaces: they live in the hosted SimCloud platform and must not
// come back here, not even as a local bring-your-own-key variant.
//
// Asset generation (the provider client, the generation store/runner/routes
// and UI, and the provider-key settings that only it used) was listed here in
// 46f0ffb1, returned in be94c0ab as a local bring-your-own-key feature, and
// was moved back out on 2026-09-22 by user decision: generation runs
// server-side in SimCloud with the key held there. OSS Studio keeps only the
// generic, empty-by-default gallery slot in studio/app/lib/host/asset-gallery-actions.ts.
const PRODUCT_ONLY_PATHS = [
  'studio/app/api/asset-gallery/generations',
  'studio/app/api/billing',
  'studio/app/api/simforge/ai-providers',
  'studio/app/components/WorkspaceSwitcher.tsx',
  'studio/app/dashboard/assets/AssetGenerateDialog.tsx',
  'studio/app/dashboard/assets/AssetGenerateImagePicker.tsx',
  'studio/app/dashboard/assets/asset-generation-images.ts',
  'studio/app/host/local/AiProviderSettings.tsx',
  'studio/app/lib/admin',
  'studio/app/lib/ai-providers',
  'studio/app/lib/asset-gallery/generation-contracts.ts',
  'studio/app/lib/asset-gallery/generation-runner.ts',
  'studio/app/lib/asset-gallery/generation-storage.ts',
  'studio/app/lib/asset-gallery/generation-store.ts',
  'studio/app/lib/asset-gallery/glb-metadata.ts',
  'studio/app/lib/auth/capabilities.ts',
  'studio/app/lib/db/workspace-audit-log-store.ts',
  'studio/app/lib/db/workspace-store.ts',
  'studio/app/lib/experimental-features.ts',
  ['studio/app/lib', 'mes' + 'hy'].join('/'),
  ['tools', 'mes' + 'hy'].join('/'),
  'docs/product/ai-providers.md',
];

/**
 * Names of product-only services that must not appear anywhere in this
 * repository: code, config, docs, tests, fixtures. Exported for the
 * OSS-boundary check that will guard `oss/` inside the platform repository.
 *
 * The term is assembled rather than written, so this file does not match
 * itself. `allowedIn` lists the only files that may carry it, each for a
 * reason that is not the feature:
 * - the release's third-party record, because 35 bundled catalog models were
 *   made with the service and their CC BY 4.0 licence requires crediting it.
 * Matching is case-exact on the three spellings, so an unrelated identifier
 * such as a mesh's Y coordinate (`meshY`) is not a hit.
 */
const GENERATION_PROVIDER = ['Mes', 'hy'].join('');
export const PRODUCT_ONLY_TERMS = [
  {
    term: GENERATION_PROVIDER,
    pattern: new RegExp([GENERATION_PROVIDER, GENERATION_PROVIDER.toLowerCase(), GENERATION_PROVIDER.toUpperCase()].join('|'), 'u'),
    why: 'asset generation is a SimCloud platform feature (server-side, platform-held key)',
    allowedIn: [
      'scripts/release/bundled-components.json',
    ],
  },
];

/** Where a registered stack package may live: one directory under one of these. */
const STACK_PACKAGE_ROOTS = ['packages', 'services'];

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function sourceFiles(root) {
  const files = [];
  const pending = [root];
  const ignored = new Set(['.git', '.next', 'dist', 'docs', 'node_modules']);
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (/\.(?:[cm]?[jt]sx?|json|ya?ml)$/u.test(entry.name)) files.push(path);
    }
  }
  return files;
}

/**
 * Every text file the repository carries. In a git checkout that is what git
 * tracks plus untracked files it does not ignore, so build output and caches
 * never slow the scan or trip it; elsewhere (test fixtures) it is a walk.
 */
function repositoryTextFiles(root) {
  let paths;
  if (existsSync(join(root, '.git'))) {
    const listed = execFileSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
    paths = listed.split('\0').filter(Boolean).map((path) => join(root, path));
  } else {
    paths = [];
    const pending = [root];
    const ignored = new Set(['.git', '.next', 'dist', 'node_modules', 'target']);
    while (pending.length) {
      const directory = pending.pop();
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (ignored.has(entry.name)) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) pending.push(path);
        else if (entry.isFile()) paths.push(path);
      }
    }
  }
  const files = [];
  for (const path of paths) {
    let stats;
    try { stats = statSync(path); } catch { continue; }
    if (!stats.isFile() || stats.size > 64 * 1024 * 1024) continue;
    const bytes = readFileSync(path);
    if (bytes.includes(0)) continue;
    files.push({ path, text: bytes.toString('utf8') });
  }
  return files;
}

export function verifyRepositoryNaming(root) {
  const errors = [];
  const rootManifest = readJson(join(root, 'package.json'));
  if (rootManifest.name !== 'simforge') errors.push('package.json name must be "simforge"');
  const stack = readJson(join(root, 'config/simforge-oss-stack.json'));
  const stackPackages = Array.isArray(stack.packages) ? stack.packages : [];
  if (stackPackages.length === 0) errors.push('config/simforge-oss-stack.json must register at least one package');

  const actualPackages = readdirSync(join(root, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, 'packages', entry.name, 'package.json')))
    .map((entry) => entry.name)
    .sort();
  // packages/ holds only stack packages; services/ may also hold other
  // workspaces (e.g. campaign runners), so only packages/ is compared exactly.
  const expectedPackages = stackPackages
    .filter((item) => item.path.startsWith('packages/'))
    .map((item) => item.path.replace(/^packages\//u, ''))
    .sort();
  if (JSON.stringify(actualPackages) !== JSON.stringify(expectedPackages)) {
    errors.push(`packages/ must contain exactly the registered stack packages: ${expectedPackages.join(', ')}`);
  }
  for (const item of stackPackages) {
    const [root, name, ...rest] = String(item.path).split('/');
    if (!STACK_PACKAGE_ROOTS.includes(root) || !name || rest.length > 0) {
      errors.push(`${item.name} must live directly under ${STACK_PACKAGE_ROOTS.map((dir) => `${dir}/`).join(' or ')}; found ${item.path}`);
      continue;
    }
    if (item.name !== `@simforge-oss/${name}`) errors.push(`${item.path} must be registered as @simforge-oss/${name}`);
    if (item.version !== stack.stackVersion) errors.push(`${item.name} manifest version must match ${stack.stackVersion}`);
    const path = join(root, item.path, 'package.json');
    if (!existsSync(path)) continue;
    const manifest = readJson(path);
    if (manifest.name !== item.name) errors.push(`${item.path}/package.json must be named ${item.name}`);
    if (manifest.version !== stack.stackVersion) {
      errors.push(`${item.path}/package.json must match stack version ${stack.stackVersion}`);
    }
  }

  const studio = readJson(join(root, 'studio', 'package.json'));
  if (studio.name !== '@simforge-oss/studio') errors.push('studio/package.json must be named @simforge-oss/studio');
  for (const path of REMOVED_PATHS) {
    if (existsSync(join(root, path))) errors.push(`${path} must not exist`);
  }
  for (const path of PRODUCT_ONLY_PATHS) {
    if (existsSync(join(root, path))) errors.push(`${path} is product-only and must not exist`);
  }
  if (!existsSync(join(root, 'renderer', 'Cargo.toml'))) errors.push('renderer/Cargo.toml must exist');
  if (!existsSync(join(root, 'native', 'Cargo.toml'))) errors.push('native/Cargo.toml must exist');

  const cli = readJson(join(root, 'packages/cli/package.json'));
  const expectedBins = { simforge: './bin/simforge.js', sf: './bin/sf.js' };
  if (JSON.stringify(cli.bin) !== JSON.stringify(expectedBins)) errors.push('CLI bins must be exactly simforge and sf; retired bins are forbidden');

  const retiredScope = ['@uni', 'scenarios/'].join('');
  const legacyImport = new RegExp(String.raw`(?:from\s*|import\s*\(|require\s*\()\s*['"]${retiredScope}`, 'u');
  const legacyEngineImport = /(?:from\s*|import\s*\(|require\s*\()\s*['"]@simforge\//u;
  const productScopePrefix = ['@sim', 'cloud/'].join('');
  for (const path of sourceFiles(root)) {
    const source = readFileSync(path, 'utf8');
    if (legacyImport.test(source)) errors.push(`${relative(root, path)} imports the retired package scope`);
    if (legacyEngineImport.test(source)) errors.push(`${relative(root, path)} imports the retired @simforge package scope`);
    if (source.includes(productScopePrefix)) errors.push(`${relative(root, path)} contains the product-only package scope`);
  }

  const termFiles = repositoryTextFiles(root);
  for (const { term, pattern, why, allowedIn } of PRODUCT_ONLY_TERMS) {
    for (const { path, text } of termFiles) {
      const name = relative(root, path).split(sep).join('/');
      if (allowedIn.includes(name) || !pattern.test(text)) continue;
      errors.push(`${name} names ${term}, which is product-only: ${why}`);
    }
  }

  if (errors.length) throw new Error(`Repository naming verification failed:\n- ${errors.join('\n- ')}`);
  return { packageCount: stackPackages.length, scannedFiles: sourceFiles(root).length };
}

function main() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const result = verifyRepositoryNaming(root);
  process.stdout.write(`SimForge naming verified (${result.packageCount} packages, ${result.scannedFiles} files).\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
