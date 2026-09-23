import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { verifyRepositoryNaming } from '../verify-repository-naming.mjs';

const PACKAGE_NAMES = ['scenario', 'native-runtime', 'cli'];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'simforge-naming-'));
  mkdirSync(join(root, 'packages'), { recursive: true });
  for (const name of PACKAGE_NAMES) {
    mkdirSync(join(root, 'packages', name), { recursive: true });
    writeFileSync(join(root, 'packages', name, 'package.json'), JSON.stringify({
      name: `@simforge-oss/${name}`,
      version: '0.1.0-rc.45',
      ...(name === 'cli' ? { bin: { simforge: './bin/simforge.js', sf: './bin/sf.js' } } : {}),
    }));
  }
  mkdirSync(join(root, 'studio'), { recursive: true });
  writeFileSync(join(root, 'studio', 'package.json'), JSON.stringify({ name: '@simforge-oss/studio' }));
  for (const workspace of ['renderer', 'native']) {
    mkdirSync(join(root, workspace), { recursive: true });
    writeFileSync(join(root, workspace, 'Cargo.toml'), '[workspace]\n');
  }
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(join(root, 'config', 'simforge-oss-stack.json'), JSON.stringify({
    stackVersion: '0.1.0-rc.45',
    packages: PACKAGE_NAMES.map((name) => ({
      name: `@simforge-oss/${name}`, version: '0.1.0-rc.45', path: `packages/${name}`,
    })),
  }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'simforge', private: true }));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('accepts the consolidated SimForge layout', () => {
  const item = fixture();
  try { assert.equal(verifyRepositoryNaming(item.root).packageCount, PACKAGE_NAMES.length); }
  finally { item.cleanup(); }
});

test('rejects workspace packages missing from the stack registry', () => {
  const item = fixture();
  try {
    mkdirSync(join(item.root, 'packages', 'orphan'), { recursive: true });
    writeFileSync(join(item.root, 'packages', 'orphan', 'package.json'), JSON.stringify({ name: '@simforge-oss/orphan' }));
    assert.throws(() => verifyRepositoryNaming(item.root), /packages\/ must contain exactly the registered stack packages/);
  } finally { item.cleanup(); }
});

test('accepts a stack package registered under services/', () => {
  const item = fixture();
  try {
    mkdirSync(join(item.root, 'services', 'render-worker'), { recursive: true });
    writeFileSync(join(item.root, 'services', 'render-worker', 'package.json'), JSON.stringify({
      name: '@simforge-oss/render-worker', version: '0.1.0-rc.45',
    }));
    const stackPath = join(item.root, 'config', 'simforge-oss-stack.json');
    const stack = JSON.parse(readFileSync(stackPath, 'utf8'));
    stack.packages.push({ name: '@simforge-oss/render-worker', version: '0.1.0-rc.45', path: 'services/render-worker' });
    writeFileSync(stackPath, JSON.stringify(stack));
    assert.equal(verifyRepositoryNaming(item.root).packageCount, PACKAGE_NAMES.length + 1);
  } finally { item.cleanup(); }
});

test('rejects a stack package outside packages/ and services/, or nested', () => {
  for (const path of ['tools/render-worker', 'services/render/worker']) {
    const item = fixture();
    try {
      const stackPath = join(item.root, 'config', 'simforge-oss-stack.json');
      const stack = JSON.parse(readFileSync(stackPath, 'utf8'));
      stack.packages.push({ name: '@simforge-oss/render-worker', version: '0.1.0-rc.45', path });
      writeFileSync(stackPath, JSON.stringify(stack));
      assert.throws(() => verifyRepositoryNaming(item.root), /must live directly under packages\/ or services\//);
    } finally { item.cleanup(); }
  }
});

test('rejects retired package imports', () => {
  const item = fixture();
  try {
    writeFileSync(join(item.root, 'packages', 'cli', 'legacy.ts'), "import x from '@uni" + "scenarios/cli';\n");
    assert.throws(() => verifyRepositoryNaming(item.root), /imports the retired package scope/);
  } finally { item.cleanup(); }
});

test('rejects the previous SimForge package scope', () => {
  const item = fixture();
  try {
    writeFileSync(join(item.root, 'packages', 'cli', 'legacy-scope.ts'), "import x from '@simforge" + "/cli';\n");
    assert.throws(() => verifyRepositoryNaming(item.root), /imports the retired @simforge package scope/);
  } finally { item.cleanup(); }
});

test('rejects removed directories and package drift', () => {
  const item = fixture();
  try {
    mkdirSync(join(item.root, 'apps', 'studio'), { recursive: true });
    assert.throws(() => verifyRepositoryNaming(item.root), /apps\/studio must not exist/);
  } finally { item.cleanup(); }
});

// Assembled so this test file does not name the provider itself.
const PROVIDER = ['Mes', 'hy'].join('');

test('rejects the product-only generation provider anywhere, docs included', () => {
  for (const [path, text] of [
    ['studio/app/lib/gallery.ts', `export const client = '${PROVIDER.toLowerCase()}';\n`],
    ['docs/product/providers.md', `Bring your own ${PROVIDER} key.\n`],
    ['.github/workflows/ci.yml', `env:\n  ${PROVIDER.toUpperCase()}_API_KEY: x\n`],
  ]) {
    const item = fixture();
    try {
      mkdirSync(join(item.root, path, '..'), { recursive: true });
      writeFileSync(join(item.root, path), text);
      assert.throws(() => verifyRepositoryNaming(item.root), new RegExp(`${path.replaceAll('.', '\\.')} names ${PROVIDER}, which is product-only`));
    } finally { item.cleanup(); }
  }
});

test('allows the provider only in the licence and sealed provenance records', () => {
  const item = fixture();
  try {
    mkdirSync(join(item.root, 'scripts', 'release'), { recursive: true });
    writeFileSync(join(item.root, 'scripts', 'release', 'bundled-components.json'), JSON.stringify({ attributionApplied: `Model created with ${PROVIDER} - CC BY 4.0 License` }));
    assert.equal(verifyRepositoryNaming(item.root).packageCount, PACKAGE_NAMES.length);
  } finally { item.cleanup(); }
});

test('does not mistake a mesh Y coordinate for the provider', () => {
  const item = fixture();
  try {
    writeFileSync(join(item.root, 'packages', 'cli', 'atlas.json'), JSON.stringify({ meshY: 1.25 }));
    assert.equal(verifyRepositoryNaming(item.root).packageCount, PACKAGE_NAMES.length);
  } finally { item.cleanup(); }
});

test('rejects the product-only asset generation surfaces', () => {
  for (const path of [
    'studio/app/api/asset-gallery/generations/route.ts',
    'studio/app/lib/asset-gallery/generation-runner.ts',
    'studio/app/lib/ai-providers/settings.ts',
    'studio/app/dashboard/assets/AssetGenerateDialog.tsx',
    `tools/${PROVIDER.toLowerCase()}/generate.mjs`,
  ]) {
    const item = fixture();
    try {
      mkdirSync(join(item.root, path, '..'), { recursive: true });
      writeFileSync(join(item.root, path), 'export {};\n');
      assert.throws(() => verifyRepositoryNaming(item.root), /is product-only and must not exist/, path);
    } finally { item.cleanup(); }
  }
});
