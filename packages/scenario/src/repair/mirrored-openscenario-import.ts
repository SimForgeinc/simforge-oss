/**
 * One-time repair for documents written by the OpenSCENARIO importer before
 * b79130bb (finding F-01, docs/engineering/openscenario-conformance.md).
 *
 * That importer mapped an OSC `WorldPosition (x, y, z, h)` to a
 * `scene_absolute` role pose `(x, z_osc, +y_osc)`. The scene frame is y-up with
 * `scene = (x, z_osc, -y_osc)` (packages/engine/src/frames.ts,
 * `__tests__/frame-convention.test.ts`) and the compiler reads map
 * `y = -pose.z`, so every imported actor sits mirrored across the map's x
 * (east-west) axis. Heading is frame-invariant and was stored correctly, as
 * were x and the height. The repair therefore negates `pose.position.z` and
 * touches nothing else.
 *
 * This module is deliberately standalone: it does not import the importer (which
 * is being removed) or anything outside this package's plain data helpers, and
 * it works on raw stored JSON as well as on a parsed `ScenarioTemplateV2`.
 *
 * ## Which roles are flipped
 *
 * The document does not record the imported actor ids (the import report lists
 * diagnostics, not actors), so a role is treated as import-created and still
 * mirrored only when all of these hold:
 *
 * 1. the document carries `extensions.openScenarioImport` (`version: 1`) and no
 *    `mirrorFix` marker, and its report shows no diagnostic only the fixed
 *    importer emits (see {@link FIXED_IMPORTER_EVIDENCE});
 * 2. the role is still `scene_absolute` (a role whose kind the author changed is
 *    placed by the solver, not by a pose);
 * 3. its id is not one the editor minted after the import. Every editor
 *    placement, paste and duplicate mints `<kind>-<base36 ms>-<random>`
 *    (`newTemplateId`), and the timestamp in it says when. An id minted before
 *    the import is an entity name from the file (a re-imported SimForge export);
 * 4. it carries no lane anchor (`laneRef`), no `initialRoute` and no `route`
 *    interaction. The importer wrote none of these: each means the author moved
 *    the actor onto a lane or drew motion in the world as it was shown, so its
 *    pose or geometry is the author's, not the importer's.
 *
 * Every other role is left alone and reported with its reason.
 *
 * Residual risks, stated so a reviewer can weigh them:
 * - an imported actor the author moved by typing a world pose in the inspector
 *   (no lane snap) is indistinguishable from an untouched one and is flipped;
 * - a document imported by the fixed importer (b79130bb until the importer's
 *   removal, never deployed) whose report has none of the fixed-only
 *   diagnostics looks pre-fix and would be flipped;
 * - positions inside triggers or invariants the author placed next to an
 *   imported actor are not moved with it.
 * The editor asks before applying and the repair is one undoable gesture; the
 * bulk script is a dry run unless told otherwise and prints every change.
 */

/** Key of the provenance block the importer wrote into `extensions`. */
export const OPENSCENARIO_IMPORT_EXTENSION_KEY = 'openScenarioImport';

/** Version of the `mirrorFix` marker this module writes. */
export const MIRROR_FIX_VERSION = 1;

/**
 * Report diagnostics that only the fixed importer (b79130bb) emits. Any of them
 * proves the document was imported with the correct frame.
 */
export const FIXED_IMPORTER_EVIDENCE: readonly ((diagnostic: { code: string; message: string }) => boolean)[] = [
  (d) => d.code === 'catalog_reference_unresolved',
  (d) => d.code === 'initial_speed_transition_approximated',
  (d) => d.code === 'entity_type_unsupported' && d.message.includes('by CatalogReference'),
  (d) => d.code === 'actor_position_unsupported' && d.message.includes('TeleportAction'),
];

/**
 * How far before `importedAt` an editor-minted id may claim to be and still
 * count as minted after the import. `importedAt` is server time and the mint
 * time is the browser's clock; the slack absorbs skew between them. A file
 * exported by SimForge and re-imported within this window has its roles
 * reported as editor-placed and left alone, which is the safe direction.
 */
const MINT_CLOCK_SLACK_MS = 60 * 60 * 1000;

/** Earliest plausible editor mint time; older base36 prefixes are entity names. */
const EARLIEST_MINT_MS = Date.UTC(2020, 0, 1);

/** `newTemplateId`: `<prefix ≤24>-<Date.now() base36>-<random base36 ≤8>`. */
const EDITOR_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,23}-([0-9a-z]{6,12})-([0-9a-z]{1,8})$/;

export type Vec3 = { readonly x: number; readonly y: number; readonly z: number };

export type MirroredImportRoleFlip = {
  readonly id: string;
  readonly before: Vec3;
  readonly after: Vec3;
};

export type MirroredImportSkipReason =
  | 'not_scene_absolute'
  | 'placed_in_editor'
  | 'lane_anchored'
  | 'has_initial_route'
  | 'has_route_interaction'
  | 'invalid_pose';

export type MirroredImportSkippedRole = {
  readonly id: string;
  readonly reason: MirroredImportSkipReason;
};

export type MirrorFixMarker = {
  readonly version: typeof MIRROR_FIX_VERSION;
  readonly appliedAt: string;
  /** Role ids whose `pose.position.z` was negated. */
  readonly roles: readonly string[];
  /** Roles the repair deliberately left alone, and why. */
  readonly skipped: readonly MirroredImportSkippedRole[];
};

export type MirroredImportDetection =
  /** No `extensions.openScenarioImport`: never imported, nothing to do. */
  | { readonly status: 'not_imported' }
  /** `mirrorFix` already present. */
  | { readonly status: 'already_fixed'; readonly marker: unknown }
  /** Imported by the fixed importer; positions are correct. */
  | { readonly status: 'fixed_importer'; readonly evidence: readonly string[] }
  /** Imported and mirrored, but no role qualifies (all edited or removed). */
  | { readonly status: 'nothing_to_fix'; readonly skipped: readonly MirroredImportSkippedRole[] }
  /**
   * More qualifying roles than the importer reported placing. Something other
   * than the importer or the editor added roles; a person must decide.
   */
  | {
      readonly status: 'ambiguous';
      readonly reason: string;
      readonly importedActorCount: number;
      readonly flips: readonly MirroredImportRoleFlip[];
      readonly skipped: readonly MirroredImportSkippedRole[];
    }
  | {
      readonly status: 'affected';
      readonly importedAt: string | null;
      /** From the import report's `world_positions_preserved` diagnostic, when present. */
      readonly importedActorCount: number | null;
      readonly flips: readonly MirroredImportRoleFlip[];
      readonly skipped: readonly MirroredImportSkippedRole[];
    };

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteVec3(value: unknown): Vec3 | null {
  if (!isRecord(value)) return null;
  const { x, y, z } = value;
  if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') return null;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return { x, y, z };
}

/** Negate without producing `-0`, which canonical JSON would not round-trip. */
function negate(value: number): number {
  return value === 0 ? 0 : -value;
}

function importBlock(doc: unknown): JsonRecord | null {
  if (!isRecord(doc) || !isRecord(doc.extensions)) return null;
  const block = doc.extensions[OPENSCENARIO_IMPORT_EXTENSION_KEY];
  return isRecord(block) && block.version === 1 ? block : null;
}

function reportDiagnostics(block: JsonRecord): { code: string; message: string }[] {
  const report = block.report;
  if (!isRecord(report) || !Array.isArray(report.diagnostics)) return [];
  return report.diagnostics
    .filter(isRecord)
    .map((d) => ({ code: typeof d.code === 'string' ? d.code : '', message: typeof d.message === 'string' ? d.message : '' }));
}

function importedActorCount(diagnostics: readonly { code: string; message: string }[]): number | null {
  const preserved = diagnostics.find((d) => d.code === 'world_positions_preserved');
  const match = preserved ? /^(\d+) actor world position/.exec(preserved.message) : null;
  return match ? Number(match[1]) : null;
}

/** True when `id` was minted by the editor at or after the import. */
function mintedInEditorAfter(id: string, importedAtMs: number | null): boolean {
  const match = EDITOR_ID_PATTERN.exec(id);
  if (!match) return false;
  const mintedAt = Number.parseInt(match[1]!, 36);
  if (!Number.isFinite(mintedAt) || mintedAt < EARLIEST_MINT_MS) return false;
  // Without an import time, any plausible editor id is treated as editor-placed:
  // leaving a mirrored actor alone is recoverable, flipping a correct one is not
  // obviously so.
  return importedAtMs === null || mintedAt >= importedAtMs - MINT_CLOCK_SLACK_MS;
}

function routedActors(doc: JsonRecord): Set<string> {
  const actors = new Set<string>();
  const choreography = doc.choreography;
  if (!isRecord(choreography) || !Array.isArray(choreography.interactions)) return actors;
  for (const interaction of choreography.interactions) {
    if (isRecord(interaction) && interaction.verb === 'route' && typeof interaction.actor === 'string') {
      actors.add(interaction.actor);
    }
  }
  return actors;
}

/**
 * Decide whether `doc` (raw stored JSON or a parsed template) is a mirrored
 * OpenSCENARIO import, and which roles a repair would flip. Pure; never throws
 * on malformed input.
 */
export function detectMirroredOpenScenarioImport(doc: unknown): MirroredImportDetection {
  const block = importBlock(doc);
  if (!block || !isRecord(doc)) return { status: 'not_imported' };
  if (block.mirrorFix !== undefined) return { status: 'already_fixed', marker: block.mirrorFix };

  const diagnostics = reportDiagnostics(block);
  const evidence = diagnostics
    .filter((d) => FIXED_IMPORTER_EVIDENCE.some((test) => test(d)))
    .map((d) => d.code);
  if (evidence.length > 0) return { status: 'fixed_importer', evidence };

  const importedAt = typeof block.importedAt === 'string' ? block.importedAt : null;
  const importedAtParsed = importedAt === null ? Number.NaN : Date.parse(importedAt);
  const importedAtMs = Number.isFinite(importedAtParsed) ? importedAtParsed : null;
  const routed = routedActors(doc);
  const flips: MirroredImportRoleFlip[] = [];
  const skipped: MirroredImportSkippedRole[] = [];

  for (const role of Array.isArray(doc.roles) ? doc.roles : []) {
    if (!isRecord(role) || typeof role.id !== 'string') continue;
    const id = role.id;
    if (role.kind !== 'scene_absolute') { skipped.push({ id, reason: 'not_scene_absolute' }); continue; }
    if (mintedInEditorAfter(id, importedAtMs)) { skipped.push({ id, reason: 'placed_in_editor' }); continue; }
    if (role.laneRef !== undefined) { skipped.push({ id, reason: 'lane_anchored' }); continue; }
    if (role.initialRoute !== undefined) { skipped.push({ id, reason: 'has_initial_route' }); continue; }
    if (routed.has(id)) { skipped.push({ id, reason: 'has_route_interaction' }); continue; }
    const position = isRecord(role.pose) ? finiteVec3(role.pose.position) : null;
    if (!position) { skipped.push({ id, reason: 'invalid_pose' }); continue; }
    flips.push({ id, before: position, after: { x: position.x, y: position.y, z: negate(position.z) } });
  }

  if (flips.length === 0) return { status: 'nothing_to_fix', skipped };
  const count = importedActorCount(diagnostics);
  if (count !== null && flips.length > count) {
    return {
      status: 'ambiguous',
      reason: `${flips.length} roles qualify but the import placed ${count}`,
      importedActorCount: count,
      flips,
      skipped,
    };
  }
  return { status: 'affected', importedAt, importedActorCount: count, flips, skipped };
}

export type MirroredImportFixResult<T> =
  | { readonly changed: true; readonly document: T; readonly marker: MirrorFixMarker; readonly detection: Extract<MirroredImportDetection, { status: 'affected' }> }
  | { readonly changed: false; readonly document: T; readonly detection: Exclude<MirroredImportDetection, { status: 'affected' }> };

/**
 * Apply the repair: negate `pose.position.z` of every role
 * {@link detectMirroredOpenScenarioImport} selects, and record
 * `extensions.openScenarioImport.mirrorFix`. Returns a new object; `doc` is not
 * mutated. Idempotent: anything but an `affected` document comes back
 * unchanged, and a repaired one carries the marker that makes it `already_fixed`.
 */
export function fixMirroredOpenScenarioImport<T>(doc: T, now: Date | string = new Date()): MirroredImportFixResult<T> {
  const detection = detectMirroredOpenScenarioImport(doc);
  if (detection.status !== 'affected') return { changed: false, document: doc, detection };
  const source = doc as unknown as JsonRecord;
  const extensions = source.extensions as JsonRecord;
  const block = extensions[OPENSCENARIO_IMPORT_EXTENSION_KEY] as JsonRecord;
  const flipped = new Map(detection.flips.map((flip) => [flip.id, flip.after]));
  const marker: MirrorFixMarker = {
    version: MIRROR_FIX_VERSION,
    appliedAt: typeof now === 'string' ? now : now.toISOString(),
    roles: detection.flips.map((flip) => flip.id),
    skipped: detection.skipped,
  };
  const roles = (source.roles as unknown[]).map((role) => {
    if (!isRecord(role) || typeof role.id !== 'string') return role;
    const after = flipped.get(role.id);
    if (!after) return role;
    const pose = role.pose as JsonRecord;
    return { ...role, pose: { ...pose, position: { ...(pose.position as JsonRecord), z: after.z } } };
  });
  const document = {
    ...source,
    roles,
    extensions: { ...extensions, [OPENSCENARIO_IMPORT_EXTENSION_KEY]: { ...block, mirrorFix: marker } },
  } as unknown as T;
  return { changed: true, document, marker, detection };
}
