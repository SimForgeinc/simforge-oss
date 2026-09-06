/**
 * Actor-catalog lookups authoring tools share with the compiler.
 *
 * `@simforge-oss/asset-catalog` owns the real dimensions and actor classes;
 * the native compiler resolves the same metadata when it materialises. These
 * helpers let an author check agreement before compiling — they never alter
 * an executed input.
 */

import {
  actorClassesForCatalogEntry,
  getEntry,
  parseExternalCatalogEntries,
  resolveCatalogId,
  type CatalogEntry,
} from '@simforge-oss/asset-catalog/metadata';

/** Metadata resolver used by built-in and user-imported asset catalogs. */
export type ActorCatalogResolver = (catalogId: string) => CatalogEntry | null;

export const builtInActorCatalogResolver: ActorCatalogResolver = (catalogId) => {
  const resolved = resolveCatalogId(catalogId);
  return resolved === null ? null : getEntry(resolved);
};

/**
 * Overlay user-imported catalog entries without allowing them to shadow a
 * built-in id. A custom vehicle therefore needs metadata, not a code release.
 */
export function createActorCatalogResolver(entries: readonly CatalogEntry[] = []): ActorCatalogResolver {
  if (entries.length === 0) return builtInActorCatalogResolver;
  const custom = new Map<string, CatalogEntry>();
  for (const entry of parseExternalCatalogEntries(entries)) {
    if (builtInActorCatalogResolver(entry.id) !== null) {
      throw new Error(`custom catalog entry "${entry.id}" shadows a built-in catalog id`);
    }
    if (custom.has(entry.id)) throw new Error(`duplicate custom catalog id "${entry.id}"`);
    custom.set(entry.id, entry);
  }
  return (catalogId) => builtInActorCatalogResolver(catalogId) ?? custom.get(catalogId) ?? null;
}

/** Actor classes acceptable for a catalog id, or `null` if the id is unknown. */
export function actorClassesForCatalogId(
  catalogId: string,
  resolveEntry: ActorCatalogResolver = builtInActorCatalogResolver,
): readonly string[] | null {
  const entry = resolveEntry(catalogId);
  return entry === null ? null : actorClassesForCatalogEntry(entry);
}

/**
 * Why this `class` may not be filled by this `catalogId`, or `null` if it may.
 * An unknown id is a mismatch too: an unresolved id would silently materialise
 * as a default model.
 */
export function actorCatalogMismatch(
  actorClass: string,
  catalogId: string,
  resolveEntry: ActorCatalogResolver = builtInActorCatalogResolver,
): string | null {
  const allowed = actorClassesForCatalogId(catalogId, resolveEntry);
  if (allowed === null) {
    return `catalog id "${catalogId}" does not exist; an unresolved id silently materialises as a default model`;
  }
  if (allowed.includes(actorClass)) return null;
  return `actor class "${actorClass}" cannot be filled by catalog model "${catalogId}" ` +
    `(that model may only be ${allowed.join(', ')})`;
}

/** The catalog model's own footprint, in the scenario-model dims convention. */
export function catalogActorDims(
  catalogId: string,
  resolveEntry: ActorCatalogResolver = builtInActorCatalogResolver,
): { length: number; width: number; height: number } | null {
  const entry = resolveEntry(catalogId);
  if (entry === null) return null;
  return { length: entry.dims.l, width: entry.dims.w, height: entry.dims.h };
}
