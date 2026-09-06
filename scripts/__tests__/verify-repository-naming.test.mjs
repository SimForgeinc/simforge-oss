import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
