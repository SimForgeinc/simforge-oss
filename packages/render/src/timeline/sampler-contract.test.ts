import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TIMELINE_SAMPLER_VERSION } from './index.js';

// The worker-contract N/N-1 check (scripts/worker-contract) reads these two
// declarations from source: what the control plane builds, and what the
// worker's runtime renders. Keep them in the form it parses.
const rsFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../native/crates/simforge-core/src/trace/timeline/mod.rs');

describe('timeline sampler contract', () => {
  it('builds with the sampler the runtime derives, and renders what it builds', () => {
    const rs = readFileSync(rsFile, 'utf8');
    const constant = (name: string) => new RegExp(`const ${name}: &str = "([^"]+)"`).exec(rs)?.[1];
    expect(constant('SAMPLER_VERSION')).toBe(TIMELINE_SAMPLER_VERSION);
    const list = /const ACCEPTED_SAMPLER_VERSIONS: &\[&str\] = &\[([^\]]*)\]/.exec(rs);
    const accepts = list
      ? list[1]!.split(',').map((item) => item.trim()).filter(Boolean).map((item) => (item.startsWith('"') ? item.slice(1, -1) : constant(item)))
      : [constant('SAMPLER_VERSION')];
    expect(accepts.every((value) => typeof value === 'string')).toBe(true);
    expect(accepts).toContain(TIMELINE_SAMPLER_VERSION);
  });
});
