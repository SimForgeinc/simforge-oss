import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { probeLocalNativeRender, resolveNativeRenderService } from './local-runtime.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function runtimeRoot(manifest?: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'sf-runtime-'));
  roots.push(root);
  if (manifest !== undefined) {
    await fs.mkdir(path.join(root, 'bin'), { recursive: true });
    await fs.writeFile(path.join(root, 'bin', 'runtime-manifest.json'), manifest);
  }
  return root;
}

describe('native runtime manifest', () => {
  it('resolves without a manifest (the runtime root is searched)', async () => {
    const root = await runtimeRoot();
    expect(resolveNativeRenderService({ SIMFORGE_NATIVE_RUNTIME_ROOT: root }).state).toBe('missing');
  });

  it('refuses a manifest that exists but cannot be read, instead of ignoring it', async () => {
    for (const manifest of ['{not json', '{"components": 7}', '{"components": [{"kind": 3}]}']) {
      const root = await runtimeRoot(manifest);
      expect(() => resolveNativeRenderService({ SIMFORGE_NATIVE_RUNTIME_ROOT: root }), manifest)
        .toThrow(expect.objectContaining({ code: 'native_runtime_manifest_invalid' }));
      const probe = probeLocalNativeRender({ SIMFORGE_NATIVE_RUNTIME_ROOT: root, PATH: '' });
      expect(probe.ready).toBe(false);
      expect(probe.reasons.join(' ')).toMatch(/runtime-manifest.json/);
    }
  });
});
