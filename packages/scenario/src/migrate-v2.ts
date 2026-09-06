/**
 * v1 scene → v2 template conversion, and format detection between the two.
 *
 * ## The honest version of this conversion
 *
 * A v1 document is a **scene**: entities at absolute scene coordinates on one
 * named map. A v2 document is a **template**: a predicate over road structure
 * plus frame-relative choreography, which is a strictly different kind of
 * claim. Converting the first into the second requires answering
 * "which lane, how far along the reference path, how far across it" for every
 * entity — and that answer lives in the lane graph, in `map-intel`, which this
 * package deliberately does not depend on.
 *
 * So the conversion does **not** guess. It preserves every v1 pose verbatim in
 * `scene_absolute` roles, pins the anchor to the source map with **no site id**
 * (v1 had none to preserve), and returns a list of {@link MigrationNote}s
 * saying exactly what a human or `map-intel` still has to do. The resulting
 * template is valid, loadable and editable; it is also honestly marked as
 * non-portable until it is rebound, and `validateTemplate` reports
 * `non_portable_role` for every role until then.
 *
 * The alternative — inventing `(k, s, tFrac)` from `laneRef.s` and a guessed
 * lane width — would produce a template that *looks* portable and silently
 * places actors in the wrong lane on every other map. A conversion that says
 * "I cannot do this part" is worth more than one that quietly does it wrong.
 *
 * ## What is preserved, what is dropped
 *
 * | v1 | v2 | note |
 * |---|---|---|
 * | `meta` | `meta` | verbatim; `tags` gains `migrated:v1` |
 * | `map` | `sourceMap` + `anchor.pin.mapId` | `xodrSha256` → `pin.topologyDigest` |
 * | `entities[].pose` | `roles[].pose` (`scene_absolute`) | verbatim, non-portable |
 * | `entities[].laneRef` | `roles[].laneRef` | verbatim; still road-relative |
 * | `entities[].kind` | `actor.class` | `vehicle` → `car` (v1 could not say truck/bus) |
 * | `entities[].id` | `roles[].id` | rewritten when it is not a legal v2 id (ULIDs start with a digit) |
 * | `routes`/`triggers`/`lightPrograms`/`parameters` | — | reserved and required-empty in v1, so nothing to carry |
 * | — | `choreography` | empty timeline at the default 20 s clip |
 * | — | `metricSubject` | v1 had no ego concept; left unset, reported |
 */

import { ScenarioFormatError } from './errors.js';
import { SCENARIO_VERSION, type ScenarioV1 } from './schema/v1.js';
import { V2_ID_PATTERN } from './schema/v2/common.js';
import { SCENARIO_TEMPLATE_VERSION, type ScenarioTemplateV2 } from './schema/v2/template.js';
import { parseScenario, parseTemplate } from './serialize.js';

/** Something the conversion could not do, or did in a way you should know about. */
export interface MigrationNote {
  severity: 'info' | 'warning' | 'error';
  /** Stable code, e.g. `legacy_pose_absolute`. */
  code: string;
  /** Path into the *output* document. */
  path: string;
  message: string;
}

/** Outcome of {@link migrateToTemplate}. */
export interface TemplateMigrationResult {
  template: ScenarioTemplateV2;
  /** `scenarioVersion` found in the input. */
  fromVersion: number;
  /** True when a conversion ran (i.e. the input was a v1 scene). */
  migrated: boolean;
  /** Everything the conversion wants a human to know. Empty for a v2 input. */
  notes: MigrationNote[];
  /**
   * True when the template contains non-portable data and cannot be matched
   * onto another map until an author rebinds it.
   */
  needsRebinding: boolean;
}

/** The `scenarioVersion` of a raw document, when it carries an integer one. */
export function readScenarioVersion(json: unknown): number | undefined {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return undefined;
  if (!('scenarioVersion' in json)) return undefined;
  const version = json.scenarioVersion;
  return typeof version === 'number' && Number.isInteger(version) ? version : undefined;
}

/** Which parser a file wants, from its `scenarioVersion` alone. */
export function detectScenarioKind(json: unknown): 'scene-v1' | 'template-v2' | 'unknown' {
  const version = readScenarioVersion(json);
  if (version === SCENARIO_VERSION) return 'scene-v1';
  if (version === SCENARIO_TEMPLATE_VERSION) return 'template-v2';
  return 'unknown';
}

const note = (
  severity: MigrationNote['severity'],
  code: string,
  path: string,
  message: string,
): MigrationNote => ({ severity, code, path, message });

/** Make a v1 entity id into a legal v2 role id, keeping it recognisable. */
function toRoleId(entityId: string, taken: Set<string>): string {
  let candidate = V2_ID_PATTERN.test(entityId) ? entityId : `r${entityId}`;
  candidate = candidate.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);
  if (!/^[A-Za-z]/.test(candidate)) candidate = `r${candidate}`.slice(0, 64);
  let unique = candidate;
  let n = 2;
  while (taken.has(unique)) unique = `${candidate.slice(0, 60)}-${n++}`;
  taken.add(unique);
  return unique;
}

/**
 * Convert a validated v1 scene into raw v2 template JSON, appending notes.
 *
 * The output is raw so the caller validates it once with `parseTemplate`,
 * which also materialises every v2 default.
 */
export function v1ToTemplateV2(
  source: ScenarioV1,
  notes: MigrationNote[] = [],
): Record<string, unknown> {
  const map = source.map;
  const taken = new Set<string>();
  const roles = source.entities.map((entity, index) => {
    const id = toRoleId(entity.id, taken);
    if (id !== entity.id) {
      notes.push(
        note(
          'info',
          'id_rewritten',
          `roles.${index}.id`,
          `entity id "${entity.id}" is not a legal v2 role id (they must start with a letter); renamed to "${id}"`,
        ),
      );
    }
    notes.push(
      note(
        'warning',
        'legacy_pose_absolute',
        `roles.${index}.pose`,
        `role "${id}" keeps its absolute scene pose and cannot be retargeted; converting it to a frame pose (k, s, tFrac) needs the map's lane graph, which this package does not have`,
      ),
    );
    if (entity.laneRef) {
      notes.push(
        note(
          'info',
          'legacy_lane_ref',
          `roles.${index}.laneRef`,
          `role "${id}" carries a v1 laneRef (road ${entity.laneRef.roadId}, lane ${entity.laneRef.laneId}); it is road-relative, not frame-relative, so map-intel's anchor-lift still has to convert it`,
        ),
      );
    }
    if (entity.kind === 'vehicle') {
      notes.push(
        note(
          'info',
          'actor_class_widened',
          `roles.${index}.actor.class`,
          `v1 only knew "vehicle", so role "${id}" became a "car"; set actor.class if it is a truck, bus or motorcycle`,
        ),
      );
    }
    return {
      id,
      kind: 'scene_absolute',
      actor: {
        class: entity.kind === 'pedestrian' ? 'pedestrian' : 'car',
        catalogId: entity.model.catalogId,
        ...(entity.dims ? { dims: entity.dims } : {}),
      },
      ...(entity.label !== undefined ? { label: entity.label } : {}),
      pose: entity.pose,
      ...(entity.laneRef ? { laneRef: entity.laneRef } : {}),
      ...(entity.extensions ? { extensions: entity.extensions } : {}),
    };
  });

  notes.push(
    note(
      'warning',
      'anchor_pinned_no_site',
      'anchor.pin',
      `pinned to map "${map.mapId}" with no siteId: v1 documents predate site matching, so there is no site to preserve. Run the matcher (or pick a site in the editor) before this template can be retargeted.`,
    ),
  );
  if (roles.length > 0) {
    notes.push(
      note(
        'warning',
        'metric_subject_missing',
        'metricSubject',
        'v1 had no ego concept, so no metricSubject could be inferred; set it to the role whose metrics decide criticality',
      ),
    );
  }
  notes.push(
    note(
      'info',
      'clip_defaulted',
      'choreography',
      'v1 had no timeline; the template gets an empty choreography at the default 20 s clip',
    ),
  );

  const template: Record<string, unknown> = {
    scenarioVersion: SCENARIO_TEMPLATE_VERSION,
    meta: {
      ...source.meta,
      tags: ['migrated:v1'],
    },
    sourceMap: { ...map },
    anchor: {
      features: [],
      pin: {
        mapId: map.mapId,
        ...(map.xodrSha256 ? { topologyDigest: map.xodrSha256 } : {}),
      },
    },
    roles,
    props: [],
    choreography: { interactions: [] },
    invariants: [],
    variants: [],
  };
  if (source.extensions) template.extensions = { ...source.extensions };
  return template;
}

/**
 * Read a v1 scene or a v2 template and return a validated v2 template.
 *
 * Both inputs are parsed strictly against their own schema: a v1 scene must be
 * a valid scene before it is converted, and the conversion output must be a
 * valid template.
 *
 * @throws {ScenarioFormatError} If the input carries no supported `scenarioVersion`.
 * @throws {ScenarioValidationError} If the input, or the converted template, is invalid.
 */
export function migrateToTemplate(json: unknown): TemplateMigrationResult {
  const kind = detectScenarioKind(json);
  if (kind === 'unknown') {
    const version = readScenarioVersion(json);
    throw new ScenarioFormatError(
      version === undefined
        ? 'not a scenario document: scenarioVersion must be an integer'
        : `unsupported scenario format: file schema v${version}; this build reads scene v${SCENARIO_VERSION} and template v${SCENARIO_TEMPLATE_VERSION}`,
      version,
    );
  }
  const notes: MigrationNote[] = [];
  const template = kind === 'template-v2'
    ? parseTemplate(json)
    : parseTemplate(v1ToTemplateV2(parseScenario(json), notes));
  return {
    template,
    fromVersion: kind === 'template-v2' ? SCENARIO_TEMPLATE_VERSION : SCENARIO_VERSION,
    migrated: kind === 'scene-v1',
    notes,
    needsRebinding: template.roles.some((role) => role.kind === 'scene_absolute'),
  };
}
