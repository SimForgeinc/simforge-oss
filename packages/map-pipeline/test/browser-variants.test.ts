import { describe, expect, it } from 'vitest';

import { browserVariantInput, browserVariantsBuildKey, browserVariantsFingerprint } from '../src/browser-variants.js';

const D = (c: string) => c.repeat(64);

describe('browser variants identity', () => {
  it('reads the web scene and UASTC sources, nothing of the simulation or runtime', () => {
    for (const file of ['3d/manifest.json', '3d/tiles/c_0_0.glb', '3d/variants/manifest.json', '3d/variants/objects/x.ktx2', 'images/abc.ktx2']) expect(browserVariantInput(file)).toBe(true);
    for (const file of ['map.xodr', 'topology-index.json.gz', 'images/abc.png', '3d/runtime/basis_transcoder.wasm', 'derived/sumo/map.net.xml']) expect(browserVariantInput(file)).toBe(false);
  });

  it('keys on input members by digest (order-free) and the builder fingerprint', () => {
    const fingerprint = browserVariantsFingerprint();
    const members = { '3d/manifest.json': D('a'), 'images/x.ktx2': D('b'), 'map.xodr': D('c') };
    const key = browserVariantsBuildKey({ members, fingerprint });
    expect(browserVariantsBuildKey({ members: { 'map.xodr': D('9'), 'images/x.ktx2': D('b'), '3d/manifest.json': D('a') }, fingerprint })).toBe(key);
    expect(browserVariantsBuildKey({ members: { ...members, 'images/x.ktx2': D('e') }, fingerprint })).not.toBe(key);
    expect(browserVariantsBuildKey({ members, fingerprint: D('f') })).not.toBe(key);
  });
});
