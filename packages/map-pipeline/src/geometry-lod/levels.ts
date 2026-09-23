import {
  analyzeCards,
  compactPrimitive,
  componentsOfIndices,
  connectedComponents,
  filterTriangles,
  simplify,
  thinCards,
  triangleCount,
} from './mesh-ops.js';
import type { CardAnalysis, Components, PrimitiveData } from './mesh-ops.js';

/** One source primitive with what the level builder needs to know about it. */
export interface SourcePrimitive {
  data: PrimitiveData;
  material: number | undefined;
  alphaMasked: boolean;
  /** The mesh or the material names a plant (card thinning applies only to plants). */
  vegetation?: boolean;
}

export interface PreparedPrimitive extends SourcePrimitive {
  components: Components;
  cards: CardAnalysis;
}

export function preparePrimitive(primitive: SourcePrimitive): PreparedPrimitive {
  const components = connectedComponents(primitive.data);
  return { ...primitive, components, cards: analyzeCards(primitive.data, components, primitive.alphaMasked && primitive.vegetation !== false) };
}

export type LevelMethod = 'simplify' | 'card-thin';

export interface BuiltPrimitive {
  data: PrimitiveData;
  method: LevelMethod;
  /** meshoptimizer error (mesh-local metres). */
  simplifyError: number;
  /** Card-thinning: kept fraction of cards and the area-preserving scale. */
  keptFraction?: number;
  cardScale?: number;
}

export interface BuiltLevel {
  ratio: number;
  triangles: number;
  primitives: BuiltPrimitive[];
  method: LevelMethod;
  /** Geometric error of the level, mesh-local metres (see `levelError`). */
  geometricErrorM: number;
  simplifyErrorM: number;
  thinErrorM: number;
}

export interface LevelOptions {
  /** Largest scale a kept card may grow by (area preservation cap). */
  maxCardScale: number;
  /** Smallest fraction of cards a level keeps. */
  minKeptFraction: number;
  /**
   * Perceptual weight of card thinning: a thinned canopy at `k * diagonal * (scale - 1)`
   * metres of error looks like geometry simplified by the same amount.
   * Calibrated against the image gate (docs/engineering/map-geometry-lod.md).
   */
  thinErrorGain: number;
}

export const DEFAULT_LEVEL_OPTIONS: LevelOptions = { maxCardScale: 2, minKeptFraction: 0.25, thinErrorGain: 0.125 };

/**
 * Build one level at `ratio` of the source triangles.
 *
 * - Ordinary primitives: meshoptimizer toward `ratio`, error measured.
 * - Card-like primitives (foliage): structural pieces are simplified toward
 *   `ratio`; cards are first simplified toward `sqrt(ratio)` (clusters lose
 *   inner detail), then thinned by whole card to reach `ratio`, the kept
 *   cards scaled so leaf area is preserved (bounded by `maxCardScale`).
 */
export function buildLevel(primitives: readonly PreparedPrimitive[], ratio: number, radius: number, options: LevelOptions = DEFAULT_LEVEL_OPTIONS, maxErrorFraction = 0.1): BuiltLevel {
  // Simplification stops at this error even when the ratio is not reached:
  // collapsing a thin branch or a trunk to hit a triangle count produces
  // metre-scale errors that would push the level's switch distance to
  // kilometres. Card thinning (whose error is bounded by construction) then
  // covers the remaining reduction on foliage.
  const unlimited = Math.max(radius * maxErrorFraction, 1e-4);
  const built: BuiltPrimitive[] = [];
  let simplifyErrorM = 0;
  let thinErrorM = 0;
  let method: LevelMethod = 'simplify';
  for (const primitive of primitives) {
    const source = primitive.data;
    const total = triangleCount(source);
    if (!primitive.cards.cardLike) {
      const result = simplify(source, source.indices, Math.max(1, Math.round(total * ratio)), unlimited);
      simplifyErrorM = Math.max(simplifyErrorM, result.error);
      built.push({ data: compactPrimitive(source, result.indices), method: 'simplify', simplifyError: result.error });
      continue;
    }
    method = 'card-thin';
    const { components, cards } = primitive;
    const structural = filterTriangles(source.indices, components, (component) => !cards.thinnable[component]);
    const cardIndices = filterTriangles(source.indices, components, (component) => cards.thinnable[component] === 1);
    const structuralResult = simplify(source, structural, Math.max(1, Math.round((structural.length / 3) * ratio)), unlimited);
    const cardTarget = Math.max(1, Math.round((cardIndices.length / 3) * Math.sqrt(ratio)));
    const cardResult = simplify(source, cardIndices, cardTarget, unlimited);
    const simplifiedCards = cardResult.indices.length / 3;
    const fraction = Math.min(1, Math.max(options.minKeptFraction, (ratio * (cardIndices.length / 3)) / Math.max(1, simplifiedCards)));
    const thin = thinCards(components, cards.thinnable, fraction, options.maxCardScale);
    const cardComponents = componentsOfIndices(cardResult.indices, components);
    // The simplified list has its own triangles: select them by the
    // component of their first vertex.
    const keptCards = new Uint32Array(cardResult.indices.length);
    let cursor = 0;
    for (let t = 0; t < cardComponents.length; t++) {
      if (!thin.kept.has(cardComponents[t]!)) continue;
      keptCards[cursor++] = cardResult.indices[t * 3]!;
      keptCards[cursor++] = cardResult.indices[t * 3 + 1]!;
      keptCards[cursor++] = cardResult.indices[t * 3 + 2]!;
    }
    const indices = new Uint32Array(structuralResult.indices.length + cursor);
    indices.set(structuralResult.indices, 0);
    indices.set(keptCards.subarray(0, cursor), structuralResult.indices.length);
    const data = compactPrimitive(source, indices, { components, scale: thin.scale, scaled: (component) => cards.thinnable[component] === 1 && thin.kept.has(component) });
    const error = Math.max(structuralResult.error, cardResult.error);
    simplifyErrorM = Math.max(simplifyErrorM, error);
    const keptFraction = thin.kept.size / Math.max(1, countThinnable(cards));
    thinErrorM = Math.max(thinErrorM, options.thinErrorGain * cards.medianCardDiagonal * (1 / Math.sqrt(keptFraction) - 1 + (thin.scale - 1)));
    built.push({ data, method: 'card-thin', simplifyError: error, keptFraction, cardScale: thin.scale });
  }
  const triangles = built.reduce((sum, primitive) => sum + triangleCount(primitive.data), 0);
  return { ratio, triangles, primitives: built, method, geometricErrorM: Math.max(simplifyErrorM, thinErrorM), simplifyErrorM, thinErrorM };
}

function countThinnable(cards: CardAnalysis): number {
  let n = 0;
  for (const flag of cards.thinnable) n += flag;
  return n;
}

/**
 * Level ratios for a mesh of `triangles` triangles: geometric steps down
 * to a floor of `minTriangles`, at most `maxLevels`. Heavy meshes step
 * harder (the Belmont maple: 10 %, 3 %, 1 %).
 */
/** Simplification error cap per level (fraction of the mesh's bounding radius). */
export const LEVEL_ERROR_FRACTIONS = [0.015, 0.04, 0.1] as const;

export function levelRatios(triangles: number, minTriangles = 300, maxLevels = 3): number[] {
  const schedule = triangles >= 100_000 ? [0.1, 0.03, 0.01] : triangles >= 20_000 ? [0.25, 0.08, 0.025] : [0.35, 0.12, 0.04];
  return schedule.filter((ratio) => triangles * ratio >= minTriangles).slice(0, maxLevels);
}
