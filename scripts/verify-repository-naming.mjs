#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
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

const PRODUCT_ONLY_PATHS = [
  'studio/app/api/billing',
  'studio/app/api/asset-gallery/generations',
  'studio/app/components/WorkspaceSwitcher.tsx',
  'studio/app/lib/admin',
  'studio/app/lib/auth/capabilities.ts',
  'studio/app/lib/asset-gallery/generation-contracts.ts',
  'studio/app/lib/asset-gallery/generation-runner.ts',
  'studio/app/lib/asset-gallery/generation-storage.ts',
  'studio/app/lib/asset-gallery/generation-store.ts',
  'studio/app/lib/db/workspace-audit-log-store.ts',
  'studio/app/lib/db/workspace-store.ts',
  'studio/app/lib/experimental-features.ts',
  'studio/app/lib/meshy',
];

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
  const expectedPackages = stackPackages.map((item) => item.path.replace(/^packages\//u, '')).sort();
  if (JSON.stringify(actualPackages) !== JSON.stringify(expectedPackages)) {
    errors.push(`packages/ must contain exactly the registered stack packages: ${expectedPackages.join(', ')}`);
  }
  for (const item of stackPackages) {
    const name = item.path.replace(/^packages\//u, '');
    if (!item.path.startsWith('packages/') || name.includes('/')) {
      errors.push(`${item.name} must live directly under packages/; found ${item.path}`);
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

  if (errors.length) throw new Error(`Repository naming verification failed:\n- ${errors.join('\n- ')}`);
  return { packageCount: stackPackages.length, scannedFiles: sourceFiles(root).length };
}

function main() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const result = verifyRepositoryNaming(root);
  process.stdout.write(`SimForge naming verified (${result.packageCount} packages, ${result.scannedFiles} files).\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
