/**
 * Localised road-surface vocabulary. The native engine resolves the friction
 * field; this is the authoring enumeration and the renderer/exporter legend.
 */

/**
 * What is on the road. The list is the vocabulary an author picks from, so a
 * renderer and an exporter can each resolve a name rather than reverse a
 * number back into a material.
 */
export const SURFACE_KINDS = [
  'ice',
  'packed_snow',
  'standing_water',
  'wet_leaves',
  'loose_gravel',
  'sand',
  'spilled_oil',
  'polished_asphalt',
  'grit_treated',
] as const;

/** A surface covering. */
export type SurfaceKind = (typeof SURFACE_KINDS)[number];

/**
 * Grip multiplier against the surrounding surface, by covering — the legend of
 * what the native surface field applies. `grit_treated` is the one entry above
 * 1: a salted or gritted strip is *better* than the surface around it.
 */
export const SURFACE_KIND_FRICTION_SCALE: Record<SurfaceKind, number> = {
  ice: 0.15,
  packed_snow: 0.3,
  standing_water: 0.5,
  wet_leaves: 0.45,
  loose_gravel: 0.6,
  sand: 0.5,
  spilled_oil: 0.25,
  polished_asphalt: 0.75,
  grit_treated: 1.15,
};
