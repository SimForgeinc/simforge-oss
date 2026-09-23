/**
 * Binding identity corpus, WASM side. The editor samples the render timeline
 * through this binding; the Rust crate (native/crates/simforge-core/tests/
 * render_timeline_identity.rs) and the Python binding (adapters/timeline/
 * tests/test_identity.py) replay the same corpus. All three must reproduce
 * the committed digests bit for bit: timeline key, timeline content digest,
 * and the sha256 of every sampled pose's f64 bits.
 *
 * Requires the WASM artifact (`pnpm --filter @simforge-oss/native-runtime build:wasm`).
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadNative } from '../browser.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..');
const WASM = join(HERE, '..', '..', 'wasm', 'simforge_native_runtime_bg.wasm');

interface CorpusCase {
  readonly id: string;
  readonly trace: string;
  readonly height: { kind: 'flat'; z: number } | { kind: 'plane'; z0: number; gx: number; gy: number };
  readonly catalogDigest: string | null;
  readonly timelineKey: string;
  readonly timelineSha256: string;
  readonly poseDigest: string;
}

const corpus = JSON.parse(readFileSync(join(REPO, 'fixtures/render-timeline/identity-corpus.json'), 'utf8')) as {
  samplerVersion: string;
  cases: CorpusCase[];
};

function probeTimes(t: Float64Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < t.length; i += 1) {
    out.push(t[i]!);
    if (i + 1 < t.length) {
      out.push((t[i]! + t[i + 1]!) / 2);
      out.push(t[i]! + 0.3 * (t[i + 1]! - t[i]!));
    }
  }
  return out;
}

describe.skipIf(!existsSync(WASM))('render timeline: WASM reproduces the binding identity corpus', () => {
  for (const testCase of corpus.cases) {
    it(testCase.id, async () => {
      const wasm = await loadNative(readFileSync(WASM));
      const trace = readFileSync(join(REPO, testCase.trace));
      const catalog = testCase.catalogDigest ?? undefined;
      const h = testCase.height;
      const timeline = h.kind === 'flat'
        ? wasm.RenderTimeline.buildFlat(trace, h.z, catalog)
        : wasm.RenderTimeline.buildPlane(trace, h.z0, h.gx, h.gy, catalog);
      try {
        expect(timeline.key).toBe(testCase.timelineKey);
        expect(timeline.sha256).toBe(testCase.timelineSha256);
        const hash = createHash('sha256');
        const nan = Buffer.from([0, 0, 0, 0, 0, 0, 0xf8, 0x7f]);
        const actors = timeline.actorIds;
        const scratch = Buffer.alloc(8);
        for (const t of probeTimes(timeline.times)) {
          for (const actor of actors) {
            for (const v of timeline.poseArray(actor, t)) {
              if (Number.isNaN(v)) hash.update(nan);
              else {
                scratch.writeDoubleLE(v, 0);
                hash.update(scratch);
              }
            }
          }
        }
        expect(hash.digest('hex')).toBe(testCase.poseDigest);
      } finally {
        timeline.free();
      }
    });
  }
});
