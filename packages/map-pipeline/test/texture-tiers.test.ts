import { mkdir, mkdtemp, rm, stat, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { buildTextureTiers } from '../scripts/texture-tiers.mjs';

afterEach(() => vi.restoreAllMocks());

it.each([false, true])('refuses writes into installed maps before creating any directory (alias: %s)', async (alias) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'texture-tier-safety-'));
  try {
    const installed = path.join(home, '.local/share/simforge/maps');
    await mkdir(installed, { recursive: true });
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    let output = path.join(installed, 'must-not-create');
    if (alias) {
      const linked = path.join(home, 'alias');
      await symlink(installed, linked);
      output = path.join(linked, 'must-not-create');
    }
    await expect(buildTextureTiers({ sourceRoot: installed, outputRoot: output })).rejects.toThrow('Installed maps are immutable');
    await expect(stat(path.join(installed, 'must-not-create'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
