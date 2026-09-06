import { test } from 'node:test';
import assert from 'node:assert/strict';

test('meshy manifest: concurrent writers do not lose entries (cross-process lock)', async () => {
  const { mkdtempSync, readFileSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFile } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'meshy-race-'));
  const manifest = join(dir, 'meshy-assets.json');
  writeFileSync(manifest, '[]');
  const N = 8;
  const child = (i) => new Promise((res, rej) => execFile(process.execPath, ['--input-type=module', '-e', `
    const { saveMeshyEntries } = await import(${JSON.stringify(new URL('../asset-library.mjs', import.meta.url).href)});
    const lib = { entries: [{ id: 'race-${'${'}i}', label: 'x', description: 'x', class: 'prop', glbPath: 'x.glb', source: 'meshy' }] };
    saveMeshyEntries(lib);`.replaceAll('${i}', String(i))],
    { env: { ...process.env, SIMFORGE_MESHY_ASSETS: manifest }, cwd: process.cwd() },
    (e, so, se) => e ? rej(new Error(se || String(e))) : res()));
  try {
    await Promise.all(Array.from({ length: N }, (_, i) => child(i)));
    const ids = JSON.parse(readFileSync(manifest, 'utf8')).map((e) => e.id).sort();
    assert.deepEqual(ids, Array.from({ length: N }, (_, i) => `race-${i}`).sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
