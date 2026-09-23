/**
 * `simContentHash`: the content identity of everything in a scenario document
 * that can change its simulation.
 *
 * It is the document part of the compile/simulate cache key
 * (`simforge.sim-key/v1`), so it must satisfy two rules:
 *
 * 1. **Sound:** two documents with the same hash resolve to the same simulation
 *    input on the same map version, catalog and engine. Anything that can
 *    reach the resolved input is included. When in doubt a field stays in;
 *    including too much costs a cache miss, and excluding too much returns the
 *    wrong trace.
 * 2. **Stable under bookkeeping:** saving, renaming, retitling or rearranging
 *    the editor's own view does not change it.
 *
 * Excluded:
 * - `meta.createdAt`, `meta.modifiedAt`, `meta.appVersion`: bookkeeping.
 * - `meta.description`, `meta.tags`, `meta.author`: library metadata.
 * - `meta.name`, but ONLY when the document pins `simulation.seed`. Without a
 *   pinned seed the compiler derives the per-cell seed from the template id,
 *   which falls back to `meta.name`, so the name is simulation-relevant for
 *   unpinned documents and stays in.
 * - Top-level `extensions["studio.presentation.*"]`: editor view state
 *   (cameras, timeline lanes). Role-level presentation extensions stay in,
 *   because the Studio compiler tags actors with them (body colour) and those
 *   tags are part of the resolved input.
 *
 * The hash is `sha256(canonicalJson({ v, content }))` using the one canonical
 * JSON rule (`./canonical-json.ts`). The document is quantized onto its storage
 * grid first, so a value and its saved-and-reloaded form hash the same.
 */

import { canonicalSha256 } from './canonical-json.js';
import { quantizeDocument } from './serialize.js';

/** Version tag inside the hashed envelope; bump when the included set changes. */
export const SIM_CONTENT_HASH_VERSION = 'simforge.sim-content/v1' as const;

/** Top-level extension keys with this prefix are editor view state. */
export const PRESENTATION_EXTENSION_PREFIX = 'studio.presentation.';

const BOOKKEEPING_META_KEYS = ['createdAt', 'modifiedAt', 'appVersion', 'description', 'tags', 'author'] as const;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasPinnedSeed(document: JsonRecord): boolean {
  const simulation = document['simulation'];
  return isRecord(simulation) && typeof simulation['seed'] === 'string' && simulation['seed'].length > 0;
}

/**
 * The simulation-relevant projection of a scenario document (v2 template, or
 * any JSON document with the same top-level shape). Exported for tests and for
 * diffing "what changed the simulation".
 */
export function simulationRelevantContent(document: unknown): unknown {
  if (!isRecord(document)) return document;
  const out: JsonRecord = { ...document };
  if (isRecord(document['meta'])) {
    const meta: JsonRecord = { ...document['meta'] };
    for (const key of BOOKKEEPING_META_KEYS) delete meta[key];
    if (hasPinnedSeed(document)) delete meta['name'];
    out['meta'] = meta;
  }
  if (isRecord(document['extensions'])) {
    const extensions: JsonRecord = {};
    for (const [key, value] of Object.entries(document['extensions'])) {
      if (!key.startsWith(PRESENTATION_EXTENSION_PREFIX)) extensions[key] = value;
    }
    // Removing the last presentation key must not differ from never having one.
    if (Object.keys(extensions).length > 0) out['extensions'] = extensions;
    else delete out['extensions'];
  }
  return out;
}

/**
 * Content identity of a document's simulation-relevant content (see module
 * comment). Pass a PARSED document (`parseTemplate`): parsing materializes
 * defaults, and a raw and a parsed form of one document are different JSON.
 */
export function simContentHash(document: unknown): string {
  return canonicalSha256({ v: SIM_CONTENT_HASH_VERSION, content: quantizeDocument(simulationRelevantContent(document)) });
}
