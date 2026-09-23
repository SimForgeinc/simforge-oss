import { describe, expect, it } from 'vitest';

import {
  detectMirroredOpenScenarioImport,
  fixMirroredOpenScenarioImport,
  OPENSCENARIO_IMPORT_EXTENSION_KEY,
} from '../repair/mirrored-openscenario-import.js';
import { parseTemplate, serializeTemplate } from '../serialize.js';
import { newTemplateId } from '../template-document.js';
import { ltapTemplate } from './v2-fixtures.js';

const IMPORTED_AT = '2026-09-20T10:00:00.000Z';
const FIXED_AT = '2026-09-23T00:00:00.000Z';

type OscActor = { id: string; kind?: string; x: number; yOsc: number; zOsc?: number; h: number; speedKph?: number };

/**
 * A document exactly as the pre-b79130bb `translateOpenScenarioImport` wrote
 * it: scene pose `(x, z_osc, +y_osc)`. Reproduced here, not imported, because
 * the importer is being removed and this repair must outlive it.
 */
function legacyImport(actors: readonly OscActor[], options: { importedAt?: string; diagnostics?: unknown[] } = {}) {
  const importedAt = options.importedAt ?? IMPORTED_AT;
  const roles = actors.map((actor) => ({
    id: actor.id,
    kind: 'scene_absolute' as const,
    label: actor.id,
    actor: { class: actor.kind ?? 'car', static: actor.kind === 'static_object' },
    pose: { position: { x: actor.x, y: actor.zOsc ?? 0, z: actor.yOsc }, headingRad: actor.h },
    ...(actor.speedKph === undefined ? {} : { initialSpeedKph: actor.speedKph }),
  }));
  return parseTemplate({
    scenarioVersion: 2,
    meta: { name: 'cut-in', description: '', createdAt: importedAt, modifiedAt: importedAt, appVersion: 'xosc-import/v1', tags: ['openscenario-import'], author: 'OpenSCENARIO import' },
    sourceMap: { mapId: 'town04', mapName: 'Town04' },
    anchor: { id: 'imported_scene', pin: { mapId: 'town04' } },
    roles,
    choreography: { clipSeconds: 20, warmupSeconds: 0, interactions: [] },
    metricSubject: roles[0]?.id,
    extensions: {
      openScenarioImport: {
        version: 1,
        importedAt,
        source: { byteLength: 1234, sha256: 'a'.repeat(64), fileName: 'cut-in.xosc', mediaType: 'application/xml', artifactId: 'art_1' },
        mapResolution: { mapVersionId: 'usmapv_town04', label: 'Town04' },
        report: {
          standard: 'ASAM OpenSCENARIO XML 1.2',
          logicFile: 'Town04.xodr',
          embeddedMapIdentity: { mapVersionId: null, mapId: null, xodrSha256: null },
          diagnostics: options.diagnostics ?? [
            { code: 'world_positions_preserved', path: 'Storyboard.Init', disposition: 'supported', message: `${actors.length} actor world position${actors.length === 1 ? '' : 's'} preserved exactly in a map-pinned v2 draft.` },
          ],
          capabilities: { supported: 1, approximated: 0, unsupported: 0 },
        },
      },
    },
  });
}

function role(doc: { roles: readonly unknown[] }, id: string) {
  return doc.roles.find((r) => (r as { id: string }).id === id) as {
    kind: string;
    pose: { position: { x: number; y: number; z: number }; headingRad: number };
  };
}

const EGO: OscActor = { id: 'Ego', x: 100.5, yOsc: 12.25, zOsc: 0.3, h: 1.2, speedKph: 50 };
const ADVERSARY: OscActor = { id: 'Adversary', x: 80, yOsc: -8.5, h: -0.4 };

describe('detectMirroredOpenScenarioImport', () => {
  it('selects every importer-created role and reports the corrected pose', () => {
    const detection = detectMirroredOpenScenarioImport(legacyImport([EGO, ADVERSARY]));
    expect(detection).toEqual({
      status: 'affected',
      importedAt: IMPORTED_AT,
      importedActorCount: 2,
      flips: [
        { id: 'Ego', before: { x: 100.5, y: 0.3, z: 12.25 }, after: { x: 100.5, y: 0.3, z: -12.25 } },
        { id: 'Adversary', before: { x: 80, y: 0, z: -8.5 }, after: { x: 80, y: 0, z: 8.5 } },
      ],
      skipped: [],
    });
  });

  it('leaves documents that were never imported alone', () => {
    expect(detectMirroredOpenScenarioImport(ltapTemplate())).toEqual({ status: 'not_imported' });
    expect(detectMirroredOpenScenarioImport(null)).toEqual({ status: 'not_imported' });
    expect(detectMirroredOpenScenarioImport({ roles: [], extensions: { openScenarioImport: { version: 2 } } })).toEqual({ status: 'not_imported' });
  });

  it('does not key off meta alone: the provenance extension is required', () => {
    const doc = legacyImport([EGO]);
    const { [OPENSCENARIO_IMPORT_EXTENSION_KEY]: _dropped, ...extensions } = doc.extensions!;
    expect(detectMirroredOpenScenarioImport({ ...doc, extensions })).toEqual({ status: 'not_imported' });
  });

  it('recognises a document written by the fixed importer from its report', () => {
    const doc = legacyImport([EGO], {
      diagnostics: [
        { code: 'catalog_reference_unresolved', path: 'Entities.Ego', disposition: 'approximated', message: 'CatalogReference vehiclecatalog/car is not resolved; …' },
        { code: 'world_positions_preserved', path: 'Storyboard.Init', disposition: 'supported', message: '1 actor world position preserved exactly in a map-pinned v2 draft.' },
      ],
    });
    expect(detectMirroredOpenScenarioImport(doc)).toEqual({ status: 'fixed_importer', evidence: ['catalog_reference_unresolved'] });
    const teleport = legacyImport([EGO], {
      diagnostics: [{ code: 'actor_position_unsupported', path: 'Storyboard.Init.X', disposition: 'unsupported', message: 'Actor has no Init TeleportAction with a WorldPosition; …' }],
    });
    expect(detectMirroredOpenScenarioImport(teleport).status).toBe('fixed_importer');
    const legacyMessage = legacyImport([EGO], {
      diagnostics: [{ code: 'actor_position_unsupported', path: 'Storyboard.Init.X', disposition: 'unsupported', message: 'Actor has no WorldPosition in Init; it was not translated because map-relative positions must not be guessed.' }],
    });
    expect(detectMirroredOpenScenarioImport(legacyMessage).status).toBe('affected');
  });

  it('skips roles the author changed or added after the import, and says why', () => {
    const imported = legacyImport([EGO, ADVERSARY, { id: 'Walker', kind: 'pedestrian', x: 5, yOsc: 5, h: 0 }, { id: 'Cyclist', kind: 'bicycle', x: 6, yOsc: 6, h: 0 }, { id: 'Van', kind: 'van', x: 7, yOsc: 7, h: 0 }]);
    const placed = newTemplateId('vehicle');
    const raw = JSON.parse(serializeTemplate(imported)) as {
      roles: Record<string, unknown>[];
      choreography: { interactions: unknown[] };
      extensions: Record<string, { importedAt: string }>;
    };
    // The editor mints ids from the browser clock; this one is minted "now", after the import.
    raw.extensions.openScenarioImport!.importedAt = new Date(Date.now() - 60_000).toISOString();
    raw.roles[1] = { ...raw.roles[1], kind: 'on_reference', pose: { laneOffset: 0, s: 10, tFrac: 0, headingOffsetRad: 0 } };
    raw.roles[2] = { ...raw.roles[2], laneRef: { roadId: '1', section: 0, laneId: -1, s: 3, t: 0, headingOffsetRad: 0 } };
    raw.roles[3] = { ...raw.roles[3], initialRoute: { mode: 'customRoute', points: [{ x: 6, z: 6 }] } };
    raw.choreography.interactions.push({ id: 'r1', actor: 'Van', verb: 'route', trigger: { kind: 'time', atS: 0 }, target: { mode: 'customRoute', points: [{ x: 7, z: 7 }, { x: 9, z: 7 }] } });
    raw.roles.push({
      id: placed,
      kind: 'scene_absolute',
      actor: { class: 'car', catalogId: 'sedan', dims: { length: 4.8, width: 1.9, height: 1.5 }, static: false, sensors: [] },
      pose: { position: { x: 1, y: 0, z: -3 }, headingRad: 0 },
    });

    const detection = detectMirroredOpenScenarioImport(raw);
    expect(detection.status).toBe('affected');
    if (detection.status !== 'affected') return;
    expect(detection.flips.map((flip) => flip.id)).toEqual(['Ego']);
    expect(detection.skipped).toEqual([
      { id: 'Adversary', reason: 'not_scene_absolute' },
      { id: 'Walker', reason: 'lane_anchored' },
      { id: 'Cyclist', reason: 'has_initial_route' },
      { id: 'Van', reason: 'has_route_interaction' },
      { id: placed, reason: 'placed_in_editor' },
    ]);
  });

  it('flips an imported role whose model the author swapped (dims written, pose untouched)', () => {
    const raw = JSON.parse(serializeTemplate(legacyImport([EGO]))) as { roles: { actor: Record<string, unknown> }[] };
    raw.roles[0]!.actor = { ...raw.roles[0]!.actor, catalogId: 'suv', dims: { length: 5, width: 2, height: 1.8 } };
    expect(detectMirroredOpenScenarioImport(raw).status).toBe('affected');
  });

  it('treats an editor-shaped id minted before the import as an entity name from the file', () => {
    // A SimForge export re-imported: the entity names are the original role ids.
    const exportedId = `vehicle-${Date.parse('2026-08-01T00:00:00.000Z').toString(36)}-k3j4h5g6`;
    const detection = detectMirroredOpenScenarioImport(legacyImport([{ ...EGO, id: exportedId }]));
    expect(detection.status).toBe('affected');
  });

  it('refuses to guess when more roles qualify than the import placed', () => {
    const doc = legacyImport([EGO, ADVERSARY], {
      diagnostics: [{ code: 'world_positions_preserved', path: 'Storyboard.Init', disposition: 'supported', message: '1 actor world position preserved exactly in a map-pinned v2 draft.' }],
    });
    const detection = detectMirroredOpenScenarioImport(doc);
    expect(detection.status).toBe('ambiguous');
    expect(fixMirroredOpenScenarioImport(doc, FIXED_AT).changed).toBe(false);
  });

  it('reports nothing to fix when every imported role was edited or removed', () => {
    const raw = JSON.parse(serializeTemplate(legacyImport([EGO]))) as { roles: Record<string, unknown>[] };
    raw.roles[0] = { ...raw.roles[0], laneRef: { roadId: '1', section: 0, laneId: -1, s: 3, t: 0, headingOffsetRad: 0 } };
    expect(detectMirroredOpenScenarioImport(raw)).toEqual({ status: 'nothing_to_fix', skipped: [{ id: 'Ego', reason: 'lane_anchored' }] });
    expect(detectMirroredOpenScenarioImport({ ...legacyImport([]) }).status).toBe('nothing_to_fix');
  });
});

describe('fixMirroredOpenScenarioImport', () => {
  it('negates z only, keeps heading, x and height, and records the marker', () => {
    const doc = legacyImport([EGO, ADVERSARY]);
    const before = JSON.parse(JSON.stringify(doc));
    const result = fixMirroredOpenScenarioImport(doc, FIXED_AT);
    expect(result.changed).toBe(true);
    if (!result.changed) return;
    expect(doc).toEqual(before); // input not mutated

    const ego = role(result.document, 'Ego');
    expect(ego.pose).toEqual({ position: { x: 100.5, y: 0.3, z: -12.25 }, headingRad: 1.2 });
    // The compiler reads map y = -pose.z: the actor is back at its OSC world y.
    expect(-ego.pose.position.z).toBe(EGO.yOsc);
    expect(role(result.document, 'Adversary').pose).toEqual({ position: { x: 80, y: 0, z: 8.5 }, headingRad: -0.4 });

    expect(result.document.extensions?.openScenarioImport).toEqual({
      ...(doc.extensions!.openScenarioImport as object),
      mirrorFix: { version: 1, appliedAt: FIXED_AT, roles: ['Ego', 'Adversary'], skipped: [] },
    });
    // Everything else is byte-identical, and the result is still a valid template.
    const strip = (value: typeof doc) => ({ ...value, roles: [], extensions: {} });
    expect(strip(result.document)).toEqual(strip(doc));
    expect(parseTemplate(result.document)).toEqual(result.document);
  });

  it('is idempotent', () => {
    const once = fixMirroredOpenScenarioImport(legacyImport([EGO]), FIXED_AT);
    expect(once.changed).toBe(true);
    const twice = fixMirroredOpenScenarioImport(once.document, '2030-01-01T00:00:00.000Z');
    expect(twice.changed).toBe(false);
    expect(twice.detection.status).toBe('already_fixed');
    expect(twice.document).toBe(once.document);
  });

  it('returns untouched documents by identity', () => {
    const plain = ltapTemplate();
    const result = fixMirroredOpenScenarioImport(plain, FIXED_AT);
    expect(result).toEqual({ changed: false, document: plain, detection: { status: 'not_imported' } });
    expect(result.document).toBe(plain);
  });

  it('treats raw stored JSON and the parsed template the same', () => {
    const doc = legacyImport([EGO, { ...ADVERSARY, yOsc: 0 }]);
    const raw = JSON.parse(serializeTemplate(doc)) as unknown;
    const fromRaw = fixMirroredOpenScenarioImport(raw, FIXED_AT);
    const fromParsed = fixMirroredOpenScenarioImport(doc, FIXED_AT);
    expect(fromRaw.changed && fromParsed.changed).toBe(true);
    expect(parseTemplate(fromRaw.document)).toEqual(fromParsed.document);
    // A zero z stays +0: canonical JSON never sees -0.
    expect(Object.is(role(fromParsed.document, 'Adversary').pose.position.z, 0)).toBe(true);
  });
});
