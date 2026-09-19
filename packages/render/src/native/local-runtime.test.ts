import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { probeLocalCarlaRender } from './local-runtime.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'carla-probe-'));
  roots.push(root);
  return { root, binary: join(root, 'simforge-oss-carla-exec') };
}

describe('local CARLA readiness', () => {
  it('refuses an absent adapter with its searched location', () => {
    const { binary } = fixture();
    const result = probeLocalCarlaRender({ SIMFORGE_CARLA_BINARY: binary, PATH: '' });
    expect(result.ready).toBe(false);
    expect(result.reasons).toEqual([`The CARLA adapter is not installed or executable (looked in ${binary}).`]);
  });
  it('requires an executable regular file and resolves the adapter from PATH', () => {
    const { root, binary } = fixture();
    writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o600 });
    expect(probeLocalCarlaRender({ PATH: root }).ready).toBe(false);
    chmodSync(binary, 0o700);
    expect(probeLocalCarlaRender({ PATH: root })).toEqual({ ready: true, reasons: [] });
    expect(probeLocalCarlaRender({ SIMFORGE_CARLA_BINARY: binary, PATH: '' }).ready).toBe(true);
  });
  it('does not let PATH mask an invalid explicit adapter or accept invalid endpoints', () => {
    const { root, binary } = fixture();
    writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    expect(probeLocalCarlaRender({ PATH: root, SIMFORGE_CARLA_BINARY: join(root, 'missing') }).ready).toBe(false);
    expect(probeLocalCarlaRender({ PATH: root, CARLA_HOST: 'host/path', CARLA_PORT: '65536' }).reasons)
      .toEqual(['The CARLA host is invalid.', 'The CARLA port must be an integer between 1 and 65535.']);
  });
});
