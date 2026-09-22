/**
 * The two builds of this package — the N-API addon and the WASM module — are
 * one engine. Studio's editor runs the WASM build and hashes the input it
 * resolved (`instance.manifest.inputHash`); the local compiler runs the addon
 * and re-resolves the same document, then refuses the export when the two
 * digests disagree (`materialized_traffic_source_input_digest_mismatch`).
 *
 * Nothing else can catch a disagreement between them. `engineVersion` and
 * `abiVersion` are identical in both builds by construction, so an addon left
 * over from before a serialization change loads cleanly, reports the expected
 * identity, and silently resolves every authored document to a different
 * input than the browser did. That is exactly what happened: an addon built
 * before `RouteSpec::Polyline::stop_controls` became `skip_serializing_if`
 * kept emitting `"stopControls": []`, so every scenario with a polyline route
 * — every pedestrian Studio places — became unrenderable while both builds
 * still claimed to be engine 0.7.0 / ABI 3.
 *
 * Requires both artifacts (`pnpm --filter @simforge-oss/native-runtime build`).
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { native } from '../index.js';
import { loadNative } from '../browser.js';

/** The surface this contract is about: parse a document, serialize its identity. */
type IdentityModule = {
  abiVersion(): number;
  engineVersion(): string;
  ScenarioInput: { parse(document: string): { toJson(): string } };
};

const WASM = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'wasm', 'simforge_native_runtime_bg.wasm');

/** A polyline route with no station stops: the authored contract writes no `stopControls`. */
const REFERENCE_INPUT = JSON.stringify({
  mapId: 'build-agreement',
  clipSeconds: 2,
  warmupSeconds: 0,
  dt: 0.02,
  seed: 'build-agreement',
  physics: { mode: 'dynamic-v1' },
  actors: [{
    id: 'walker',
    kind: 'pedestrian',
    initial: { pose: { x: 0, z: 0, headingRad: 0 }, speedMps: 1.2 },
    behavior: { route: { kind: 'polyline', points: [{ x: 0, z: 0 }, { x: 4, z: 0 }] } },
  }],
});

describe.skipIf(!existsSync(WASM))('N-API and WASM builds agree on input identity', () => {
  it('serializes one document to the same canonical input, under the same reported identity', async () => {
    const addon: IdentityModule = native();
    const wasm: IdentityModule = await loadNative(readFileSync(WASM));

    expect(addon.engineVersion()).toBe(wasm.engineVersion());
    expect(addon.abiVersion()).toBe(wasm.abiVersion());

    const fromAddon = addon.ScenarioInput.parse(REFERENCE_INPUT).toJson();
    expect(fromAddon).toBe(wasm.ScenarioInput.parse(REFERENCE_INPUT).toJson());
    // The identity carries the authored contract's fields only: an engine-only
    // empty collection in it is a digest the other build cannot reproduce.
    expect(fromAddon).toContain('"kind":"polyline"');
    expect(fromAddon).not.toContain('stopControls');
  });
});
