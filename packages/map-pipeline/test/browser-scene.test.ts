import { describe, expect, it } from 'vitest';

import { browserSceneBuildKey, browserSceneFingerprint, browserSceneNativeInput, browserSceneNotApplicable } from '../src/browser-scene.js';

const D = (c: string) => c.repeat(64);
const lod = (level: number) => ({ file: `tiles/veg_0_0.lod${level}.glb`, level, geometricError: level, triangles: 1, fileSize: 1 });

describe('browser scene identity', () => {
  it('reads the master and the geometry levels, never the sensor proxy', () => {
    for (const file of ['master.gltf', 'geometry.bin', 'derived/geometry-lod/manifest.json', 'derived/geometry-lod/lod.bin']) expect(browserSceneNativeInput(file)).toBe(true);
    for (const file of ['derived/geometry-lod/sensor.bin', 'map.xodr', 'images/a.ktx2', 'derived/textures-full-bc7/manifest.json']) expect(browserSceneNativeInput(file)).toBe(false);
  });

  it('keys on the browser scene inputs, the master and geometry levels, and the builder', () => {
    const fingerprint = browserSceneFingerprint();
    const browser = { '3d/manifest.json': D('a'), 'images/x.ktx2': D('b'), 'map.xodr': D('c') };
    const native = { 'master.gltf': D('d'), 'derived/geometry-lod/lod.bin': D('e'), 'derived/geometry-lod/sensor.bin': D('f') };
    const key = browserSceneBuildKey({ browser, native, fingerprint });
    expect(browserSceneBuildKey({ browser: { ...browser, 'map.xodr': D('9') }, native: { ...native, 'derived/geometry-lod/sensor.bin': D('9') }, fingerprint })).toBe(key);
    expect(browserSceneBuildKey({ browser, native: { ...native, 'derived/geometry-lod/lod.bin': D('1') }, fingerprint })).not.toBe(key);
    expect(browserSceneBuildKey({ browser: { ...browser, '3d/manifest.json': D('1') }, native, fingerprint })).not.toBe(key);
    expect(browserSceneBuildKey({ browser, native, fingerprint: D('0') })).not.toBe(key);
  });

  it('applies only to a scene whose vegetation cells have no levels yet', () => {
    const scene = (lods: number[][]) => ({ scene: {}, vegetationTiles: lods.map((levels, index) => ({ id: `veg_${index}`, lods: levels.map(lod) })) });
    expect(browserSceneNotApplicable(scene([[0], [0]]))).toBeNull();
    expect(browserSceneNotApplicable(scene([[0, 1], [0]]))).toMatch(/already carries vegetation levels/);
    expect(browserSceneNotApplicable(scene([]))).toMatch(/no vegetation cells/);
  });
});
