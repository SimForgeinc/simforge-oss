import {
  CATALOG,
  CATALOG_ALIASES,
  getEntry,
  registerExternalCatalogEntry,
  resolveCatalogId,
  type ExternalCatalogEntry,
} from './catalog.js';
import type { CatalogEntry, Dims } from './types.js';
import { GALLERY_CATALOG } from './gallery.generated.js';

export type CatalogVisualProfile = 'primitive' | 'gallery';

/** Default stays procedural so sensor goldens do not acquire asset dependencies. */
export const DEFAULT_CATALOG_VISUAL_PROFILE: CatalogVisualProfile = 'primitive';
export const GALLERY_DIMENSION_GATE = 0.30;

const canonicalById: Readonly<Record<string, CatalogEntry>> = Object.fromEntries(
  CATALOG.map((entry) => [entry.id, entry]),
);
const galleryByCanonicalId: Readonly<Record<string, ExternalCatalogEntry>> = Object.fromEntries(
  GALLERY_CATALOG.map((entry) => [entry.id.slice('gallery.'.length), entry]),
);

function withAssetRoot(entry: ExternalCatalogEntry, assetRoot: string): ExternalCatalogEntry {
  const root = assetRoot.replace(/\/$/, '');
  if (entry.model.kind !== 'glb') return entry;
  const rewrite = (url: string): string => url.replace(/^\/gallery-assets/, root);
  const clipAssets = entry.model.clipAssets;
  return {
    ...entry,
    model: {
      ...entry.model,
      url: rewrite(entry.model.url),
      ...(clipAssets ? {
        clipAssets: {
          idle: { ...clipAssets.idle, url: rewrite(clipAssets.idle.url) },
          locomotion: { ...clipAssets.locomotion, url: rewrite(clipAssets.locomotion.url) },
          ...(clipAssets.run ? { run: { ...clipAssets.run, url: rewrite(clipAssets.run.url) } } : {}),
          ...(clipAssets.rigged ? { rigged: { ...clipAssets.rigged, url: rewrite(clipAssets.rigged.url) } } : {}),
        },
      } : {}),
    },
  };
}

function dimensionDeviations(actual: Dims, target: Dims): Dims {
  return {
    l: Math.abs(actual.l - target.l) / target.l,
    w: Math.abs(actual.w - target.w) / target.w,
    h: Math.abs(actual.h - target.h) / target.h,
  };
}

/** Fail loudly before registering any out-of-contract generated visual. */
export function assertGalleryDimensions(entry: ExternalCatalogEntry): void {
  const canonicalId = entry.id.slice('gallery.'.length);
  const canonical = canonicalById[canonicalId];
  if (!canonical) throw new Error(`${entry.id} has no canonical catalog entry`);
  const deviations = dimensionDeviations(entry.dims, canonical.dims);
  const gateAxes: readonly (keyof Dims)[] = entry.class === 'pedestrian' ? ['h'] : ['l', 'w', 'h'];
  for (const axis of gateAxes) {
    if (deviations[axis] > GALLERY_DIMENSION_GATE) {
      throw new Error(
        `${entry.id} dims.${axis} exceeds gallery gate: ${(deviations[axis] * 100).toFixed(1)}% > ${(GALLERY_DIMENSION_GATE * 100).toFixed(1)}%`,
      );
    }
  }
}

/**
 * Registers every approved local gallery alias. `assetRoot` is the URL mount
 * for SCEN_DEV_ASSETS; the development server convention is `/gallery-assets`.
 */
export function installGalleryCatalog(assetRoot = '/gallery-assets'): readonly ExternalCatalogEntry[] {
  const installed = GALLERY_CATALOG.map((template) => withAssetRoot(template, assetRoot));
  for (const entry of installed) {
    assertGalleryDimensions(entry);
    registerExternalCatalogEntry(entry);
  }
  return installed;
}

/** Resolve the visual id while preserving the canonical simulation identity. */
export function resolveCatalogVisualId(
  id: string,
  visualProfile: CatalogVisualProfile = DEFAULT_CATALOG_VISUAL_PROFILE,
): string | null {
  const resolved = resolveCatalogId(id);
  const canonicalId = resolved?.startsWith('gallery.')
    ? resolved.slice('gallery.'.length)
    : resolved ?? CATALOG_ALIASES[id] ?? null;
  if (!canonicalId) return null;
  if (visualProfile === 'primitive') return canonicalId;
  return galleryByCanonicalId[canonicalId] ? `gallery.${canonicalId}` : canonicalId;
}

export function getCatalogVisualEntry(
  id: string,
  visualProfile: CatalogVisualProfile = DEFAULT_CATALOG_VISUAL_PROFILE,
): CatalogEntry | null {
  const visualId = resolveCatalogVisualId(id, visualProfile);
  if (!visualId) return null;
  if (visualProfile === 'gallery' && visualId.startsWith('gallery.') && !getEntry(visualId)) {
    const template = galleryByCanonicalId[visualId.slice('gallery.'.length)];
    if (template) {
      assertGalleryDimensions(template);
      registerExternalCatalogEntry(template);
    }
  }
  return getEntry(visualId);
}

export { GALLERY_CATALOG };
