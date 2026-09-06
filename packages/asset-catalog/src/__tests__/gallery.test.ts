import { afterEach, describe, expect, it } from 'vitest';
import {
  GALLERY_CATALOG,
  assertGalleryDimensions,
  clearExternalCatalogEntries,
  getCatalogVisualEntry,
  installGalleryCatalog,
  listExternalCatalogEntries,
  resolveCatalogVisualId,
} from '../index.js';

afterEach(() => clearExternalCatalogEntries());

describe('gallery visual profile', () => {
  it('keeps primitive resolution as the no-op default', () => {
    expect(resolveCatalogVisualId('vehicle.sedan')).toBe('vehicle.sedan');
    expect(getCatalogVisualEntry('vehicle.sedan')?.id).toBe('vehicle.sedan');
    expect(listExternalCatalogEntries()).toHaveLength(0);
  });

  it('installs all approved aliases and falls back when an asset was rejected', () => {
    const installed = installGalleryCatalog('/mounted-dev-assets/gallery-assets');
    expect(installed).toHaveLength(51);
    expect(GALLERY_CATALOG).toHaveLength(51);
    expect(listExternalCatalogEntries()).toHaveLength(51);
    expect(resolveCatalogVisualId('vehicle.sedan', 'gallery')).toBe('gallery.vehicle.sedan');
    expect(getCatalogVisualEntry('vehicle.sedan', 'gallery')?.model).toMatchObject({
      kind: 'glb',
      url: '/mounted-dev-assets/gallery-assets/vehicle.sedan/model.glb',
    });
    expect(resolveCatalogVisualId('vehicle.suv', 'gallery')).toBe('vehicle.suv');
  });

  it('enforces normalized dimensions and pedestrian named-clip assets', () => {
    for (const entry of GALLERY_CATALOG) assertGalleryDimensions(entry);
    const adult = GALLERY_CATALOG.find((entry) => entry.id === 'gallery.pedestrian.adult');
    expect(adult?.animation).toMatchObject({ idleClip: 'idle', locomotionClip: 'walk' });
    expect(adult?.model).toMatchObject({
      kind: 'glb',
      url: '/gallery-assets/pedestrian.adult/model.glb',
      animated: true,
      clips: { idle: 'idle', locomotion: 'walk' },
      clipAssets: {
        idle: { url: '/gallery-assets/pedestrian.adult/animations/idle.glb', scale: 0.02 },
        locomotion: { url: '/gallery-assets/pedestrian.adult/animations/walk.glb', scale: 0.02 },
      },
    });
    expect(() => assertGalleryDimensions({
      ...GALLERY_CATALOG[0],
      dims: { ...GALLERY_CATALOG[0].dims, l: GALLERY_CATALOG[0].dims.l * 2 },
    })).toThrow(/exceeds gallery gate/);
  });
});
