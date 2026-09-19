import { expect, it } from 'vitest';
import { ShadowAtlas } from './shadow-atlas';
import type { CityManifest } from './types';

it('fits a scene-wide shadow atlas within the actual GPU limit without changing world UVs', () => {
  const manifest = { scene: { gridDimensions: [20, 27], cellSize: [100, 100], origin: [-1900, 0, -1200] } } as CityManifest;
  const atlas = new ShadowAtlas(manifest, 512, 8192);
  try {
    expect(atlas.texture.image.width).toBeLessThanOrEqual(8192);
    expect(atlas.texture.image.height).toBeLessThanOrEqual(8192);
    expect(atlas.texture.image.width / 20).toBe(atlas.texture.image.height / 27);
    expect(atlas.rect.toArray()).toEqual([-1900, -1200, 1 / 2000, 1 / 2700]);
  } finally { atlas.dispose(); }
});
