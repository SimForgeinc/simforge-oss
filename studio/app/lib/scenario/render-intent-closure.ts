import { z } from "zod";
import type { SqlParams } from "@/app/lib/db/data-api";
import { canonicalJsonSha256, sha256 } from "./core";
import { MAP_DERIVATIVE_SET_CONTRACT, mapDerivativeExtraMembers, type MapDerivativeMember } from "./map-derivatives";
import { ScenarioRenderIntentSchema, type ScenarioRenderIntent } from "./render-wire-contracts";

/**
 * How `render_jobs.render_intent` stores a native intent.
 *
 * A native intent declares every member of its map's native closure, plus the
 * derivative sets bound to the map version, as an asset, so the intent a
 * worker receives and hashes reaches megabytes for a large map (San Ramon
 * P2: 29,377 members, 5.9 MB; Garching: 41,723 members, 8.3 MB). The Aurora
 * Data API refuses any request over 4 MiB, so writing that document inline
 * failed the submission with HTTP 413.
 *
 * Those members already live, immutably, in the map registry
 * (`native_map_asset_sets` / `_members` / `_blobs`). The row therefore stores
 * the intent with the member run cut out of `assets` and a reference in its
 * place (`nativeMapClosureRef`): the pinned asset set ids, where the run sits
 * in `assets`, how long it is, and the sha256 of the exact member entries.
 * Every reader restores the full intent through {@link rehydrateRenderIntent},
 * so the document a worker leases, its content hash (`intent_sha256`) and the
 * worker contract are unchanged. A member that is gone, unverified or
 * different fails the read with a named error; nothing is substituted.
 *
 * Rows written before this, and non-native intents, carry no reference and
 * are read exactly as stored.
 */
export const RENDER_INTENT_CLOSURE_REF_KEY = "nativeMapClosureRef";
export const RENDER_INTENT_CLOSURE_REF_SCHEMA = "simforge.render-intent-closure-ref/v1";

/**
 * The largest stored intent a submission writes. The Data API caps a request
 * at 4 MiB including its JSON envelope, in which every quote of the intent is
 * escaped again; 1 MiB of stored document leaves ample room. A stored native
 * intent is a few kilobytes, so reaching this means something other than the
 * map closure grew, and the submission is refused with
 * `render_intent_too_large` instead of a database error.
 */
export const RENDER_INTENT_STORED_MAX_BYTES = 1024 * 1024;

/** A set id; never contains the comma the derivative query splits on. */
const SET_ID = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);

export const RenderIntentClosureRefSchema = z.strictObject({
  schema: z.literal(RENDER_INTENT_CLOSURE_REF_SCHEMA),
  /** The map version's native closure set (`map_versions.native_map_asset_set_id` at submission). */
  nativeMapAssetSetId: SET_ID,
  /** Derivative sets bound to the map version at submission; their members not in the closure follow it. */
  derivativeSetIds: z.array(SET_ID).max(16),
  /** Index in the stored `assets` where the member run is spliced back. */
  offset: z.number().int().nonnegative(),
  count: z.number().int().positive(),
  /** `canonicalJsonSha256` of the member entries, in order. */
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type RenderIntentClosureRef = z.infer<typeof RenderIntentClosureRefSchema>;

export type NativeClosureAsset = { assetId: string; kind: "map"; sha256: string; sizeBytes: number };

type RowQuery = <T>(sql: string, params?: SqlParams) => Promise<T[]>;

/** The intent asset a native map member is declared as. */
export function nativeMapMemberAsset(relativePath: string, digest: string, sizeBytes: number | string): NativeClosureAsset {
  return {
    assetId: relativePath === "master.gltf" ? "map.tile.000000" : `map.resource.${sha256(relativePath)}`,
    kind: "map",
    sha256: digest,
    sizeBytes: Number(sizeBytes),
  };
}

export class RenderIntentTooLargeError extends Error {
  readonly detail: string;
  constructor(readonly storedBytes: number, readonly limitBytes = RENDER_INTENT_STORED_MAX_BYTES) {
    super("render_intent_too_large");
    this.name = "RenderIntentTooLargeError";
    this.detail = `The render intent is ${storedBytes} bytes stored; the limit is ${limitBytes} bytes.`;
  }
}

/**
 * The document `render_jobs.render_intent` stores for `intent`. `closure`
 * names the member run `assets[offset, offset + members.length)` and the sets
 * it came from; without it (non-native intents) the intent is stored whole.
 */
export function storedRenderIntent(
  intent: ScenarioRenderIntent,
  closure: { nativeMapAssetSetId: string; derivativeSetIds: readonly string[]; offset: number; members: readonly NativeClosureAsset[] } | null,
): Record<string, unknown> {
  let stored: Record<string, unknown> = intent;
  if (closure && closure.members.length > 0) {
    const run = intent.assets.slice(closure.offset, closure.offset + closure.members.length);
    if (canonicalJsonSha256(run) !== canonicalJsonSha256(closure.members)) {
      throw new Error("render_intent_closure_offset_invalid");
    }
    const ref: RenderIntentClosureRef = RenderIntentClosureRefSchema.parse({
      schema: RENDER_INTENT_CLOSURE_REF_SCHEMA,
      nativeMapAssetSetId: closure.nativeMapAssetSetId,
      derivativeSetIds: [...closure.derivativeSetIds],
      offset: closure.offset,
      count: closure.members.length,
      sha256: canonicalJsonSha256(closure.members),
    });
    stored = {
      ...intent,
      assets: [...intent.assets.slice(0, closure.offset), ...intent.assets.slice(closure.offset + closure.members.length)],
      [RENDER_INTENT_CLOSURE_REF_KEY]: ref,
    };
  }
  const bytes = Buffer.byteLength(JSON.stringify(stored));
  if (bytes > RENDER_INTENT_STORED_MAX_BYTES) throw new RenderIntentTooLargeError(bytes);
  return stored;
}

/**
 * The member entries a closure reference pins, in the order submission
 * declared them: the closure set's members by `relative_path` (the same
 * `ORDER BY` submission used) without `.map-release.json`, then the
 * derivative members the closure does not carry, by path. Every set must be
 * available and every member's blob verified.
 */
export async function loadNativeClosureAssets(query: RowQuery, ref: RenderIntentClosureRef): Promise<NativeClosureAsset[]> {
  const unavailable = (setId: string) => new Error(`render_intent_closure_unavailable:${setId}`);
  const closureRows = await query<{ object_count: number | string; relative_path: string; sha256: string; byte_length: number | string }>(
    `SELECT s.object_count, m.relative_path, b.sha256, b.byte_length
       FROM simforge.native_map_asset_sets s
       JOIN simforge.native_map_asset_members m ON m.asset_set_id = s.id
       JOIN simforge.native_map_asset_blobs b ON b.id = m.blob_id AND b.verification_state = 'verified'
      WHERE s.id = :set_id AND s.asset_set_state = 'available'
      ORDER BY m.relative_path`,
    { set_id: ref.nativeMapAssetSetId },
  );
  if (closureRows.length === 0 || closureRows.length !== Number(closureRows[0]!.object_count)) {
    throw unavailable(ref.nativeMapAssetSetId);
  }
  const closure = closureRows.filter((row) => row.relative_path !== ".map-release.json");
  let derived: MapDerivativeMember[] = [];
  if (ref.derivativeSetIds.length > 0) {
    const rows = await query<{ set_id: string; object_count: number | string; relative_path: string; sha256: string; byte_length: number | string }>(
      `SELECT ds.id AS set_id, ds.object_count, dm.relative_path, db.sha256, db.byte_length
         FROM simforge.native_map_asset_sets ds
         JOIN simforge.native_map_asset_members dm ON dm.asset_set_id = ds.id
         JOIN simforge.native_map_asset_blobs db ON db.id = dm.blob_id AND db.verification_state = 'verified'
        WHERE ds.id = ANY(string_to_array(:set_ids, ',')) AND ds.asset_set_state = 'available'
          AND ds.contract_version = :contract`,
      { set_ids: ref.derivativeSetIds.join(","), contract: MAP_DERIVATIVE_SET_CONTRACT },
    );
    for (const setId of ref.derivativeSetIds) {
      const own = rows.filter((row) => row.set_id === setId);
      if (own.length === 0 || own.length !== Number(own[0]!.object_count)) throw unavailable(setId);
    }
    // Sorted as `derivativeMembers` sorts them at submission (UTF-16 code units).
    derived = mapDerivativeExtraMembers(
      rows.map((row) => ({ relativePath: row.relative_path, sha256: row.sha256, byteLength: Number(row.byte_length) }))
        .sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0)),
      new Set(closure.map((row) => row.relative_path)),
    );
  }
  return [
    ...closure.map((row) => nativeMapMemberAsset(row.relative_path, row.sha256, row.byte_length)),
    ...derived.map((member) => nativeMapMemberAsset(member.relativePath, member.sha256, member.byteLength)),
  ];
}

/**
 * The full intent a stored `render_intent` stands for. A stored reference is
 * resolved from the map registry and must reproduce the member run exactly
 * (count and digest); otherwise `render_intent_closure_mismatch`.
 */
export async function rehydrateRenderIntent(query: RowQuery, storedValue: unknown): Promise<ScenarioRenderIntent> {
  const value = typeof storedValue === "string" ? JSON.parse(storedValue) as unknown : storedValue;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("render_intent_invalid");
  const { [RENDER_INTENT_CLOSURE_REF_KEY]: refValue, ...intent } = value as Record<string, unknown>;
  if (refValue === undefined) return ScenarioRenderIntentSchema.parse(intent);
  const parsed = RenderIntentClosureRefSchema.safeParse(refValue);
  if (!parsed.success) throw new Error("render_intent_closure_ref_invalid");
  const ref = parsed.data;
  const assets = intent.assets;
  if (!Array.isArray(assets) || ref.offset > assets.length) throw new Error("render_intent_closure_ref_invalid");
  const members = await loadNativeClosureAssets(query, ref);
  if (members.length !== ref.count || canonicalJsonSha256(members) !== ref.sha256) {
    throw new Error(`render_intent_closure_mismatch:${ref.nativeMapAssetSetId}`);
  }
  return ScenarioRenderIntentSchema.parse({
    ...intent,
    assets: [...assets.slice(0, ref.offset), ...members, ...assets.slice(ref.offset)],
  });
}

/**
 * Characters per slice when reading a stored render intent. Rows written
 * before closure references declare the whole map closure inline and reach
 * megabytes, while Aurora's Data API caps a single response at 1 MB and its
 * seam can page rows but never split one. 128k characters stays under that
 * cap even if every character came back escaped as a six-byte `\uXXXX`.
 */
export const RENDER_INTENT_TEXT_SLICE_CHARS = 131_072;

/** Postgres `length()` counts code points; a JS string counts UTF-16 units. */
function codePointLength(text: string) {
  let surrogatePairs = 0;
  for (const _ of text.matchAll(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g)) surrogatePairs += 1;
  return text.length - surrogatePairs;
}

/**
 * The stored text of a job's render intent, read in bounded slices and
 * reassembled. The column is written once at submission and never updated,
 * so slices read by separate statements cannot tear; the lease path still
 * verifies the full document against `intent_sha256`. Resolves `null` when
 * the job does not exist.
 */
export async function readRenderIntentText(
  query: RowQuery,
  jobId: string,
  sliceChars = RENDER_INTENT_TEXT_SLICE_CHARS,
): Promise<string | null> {
  const [head] = await query<{ chars: number | string; part: string }>(
    `SELECT length(render_intent::text) AS chars,
            substr(render_intent::text, 1, CAST(:size AS integer)) AS part
       FROM simforge.render_jobs WHERE id = :job_id`,
    { job_id: jobId, size: sliceChars },
  );
  if (!head) return null;
  const total = Number(head.chars);
  const parts = [head.part];
  for (let start = sliceChars + 1; start <= total; start += sliceChars) {
    const [slice] = await query<{ part: string }>(
      `SELECT substr(render_intent::text, CAST(:start AS integer), CAST(:size AS integer)) AS part
         FROM simforge.render_jobs WHERE id = :job_id`,
      { job_id: jobId, start, size: sliceChars },
    );
    if (!slice) throw new Error("render_intent_read_incomplete");
    parts.push(slice.part);
  }
  const text = parts.join("");
  if (codePointLength(text) !== total) throw new Error("render_intent_read_incomplete");
  return text;
}

/** A job's full render intent (see {@link rehydrateRenderIntent}), or `null` when the job does not exist. */
export async function readRenderIntent(query: RowQuery, jobId: string): Promise<ScenarioRenderIntent | null> {
  const text = await readRenderIntentText(query, jobId);
  return text === null ? null : rehydrateRenderIntent(query, text);
}
