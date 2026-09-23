import { describe, expect, it, vi } from 'vitest';
import {
  detectMirroredOpenScenarioImport,
  fixMirroredOpenScenarioImport,
  MemoryStorage,
  parseTemplate,
  WebTemplateFileStore,
} from '@simforge-oss/scenario';
import { EditorDocument } from './document';
import { TEST_MAP } from './map';

async function openedRecord() {
  const source = await EditorDocument.openBlank(TEST_MAP, {
    store: new WebTemplateFileStore({ storage: new MemoryStorage() }),
    autosaveMs: 60_000,
  });
  source.add([{ id: 'car', catalogId: 'vehicle.sedan', x: 0, y: 0, z: 0, headingRad: 0 }]);
  const stored = structuredClone(source.data);
  source.dispose();
  // Studio opens a server record exactly like this (`useEditorRuntime`).
  const document = await EditorDocument.openBlank(TEST_MAP, {
    store: new WebTemplateFileStore({ storage: new MemoryStorage() }),
    autosaveMs: 10,
  });
  document.importTemplate(stored);
  return document;
}

describe('subscribeEdits', () => {
  it('stays silent when an opened record is only autosaved locally (no edit)', async () => {
    const document = await openedRecord();
    const edits = vi.fn();
    const all = vi.fn();
    document.subscribeEdits(edits);
    document.subscribe(all);
    await document.flush();
    // The save-status notification still reaches plain subscribers ...
    expect(all).toHaveBeenCalled();
    // ... but it is not an edit, so nothing that persists on edit may fire.
    expect(edits).not.toHaveBeenCalled();
    document.dispose();
  });

  it('fires once per authored change, including renames and undo', async () => {
    const document = await openedRecord();
    const edits = vi.fn();
    document.subscribeEdits(edits);
    document.rename('Renamed');
    expect(edits).toHaveBeenCalledTimes(1);
    await document.flush();
    expect(edits).toHaveBeenCalledTimes(1);
    document.undo();
    expect(edits).toHaveBeenCalledTimes(2);
    document.dispose();
  });
});

describe('applyRepair', () => {
  /** A pre-b79130bb OpenSCENARIO import: scene z = +y_osc (mirrored). */
  function mirroredImport() {
    const importedAt = '2026-09-20T10:00:00.000Z';
    return parseTemplate({
      scenarioVersion: 2,
      meta: { name: 'cut-in', createdAt: importedAt, modifiedAt: importedAt, appVersion: 'xosc-import/v1', tags: ['openscenario-import'] },
      sourceMap: { mapId: TEST_MAP.sourceMapId, mapName: TEST_MAP.label },
      anchor: { id: 'imported_scene', pin: { mapId: TEST_MAP.sourceMapId } },
      roles: [{
        id: 'Ego',
        kind: 'scene_absolute',
        label: 'Ego',
        actor: { class: 'car', static: false },
        pose: { position: { x: 10.123456789, y: 0, z: 12.5 }, headingRad: 1.2 },
        initialSpeedKph: 50,
      }],
      choreography: { clipSeconds: 20, warmupSeconds: 0, interactions: [] },
      extensions: {
        openScenarioImport: {
          version: 1,
          importedAt,
          report: { diagnostics: [{ code: 'world_positions_preserved', message: '1 actor world position preserved exactly in a map-pinned v2 draft.' }] },
        },
      },
    });
  }

  it('writes the mirrored-import repair verbatim as one undoable, persisted edit', async () => {
    const document = await EditorDocument.openBlank(TEST_MAP, {
      store: new WebTemplateFileStore({ storage: new MemoryStorage() }),
      autosaveMs: 60_000,
    });
    document.importTemplate(mirroredImport());
    const opened = document.data;
    const fix = fixMirroredOpenScenarioImport(opened, '2026-09-23T00:00:00.000Z');
    expect(fix.changed).toBe(true);
    if (!fix.changed) return;
    const edits = vi.fn();
    document.subscribeEdits(edits);

    document.applyRepair({
      roles: fix.document.roles.filter((role) => fix.marker.roles.includes(role.id)),
      extensions: { openScenarioImport: fix.document.extensions!.openScenarioImport },
    });

    expect(edits).toHaveBeenCalledTimes(1);
    // Every template op stamps `meta.modifiedAt`; nothing else differs.
    expect({ ...document.data, meta: { ...document.data.meta, modifiedAt: '' } })
      .toEqual({ ...fix.document, meta: { ...fix.document.meta, modifiedAt: '' } });
    // Verbatim: x keeps its full precision (update() would have quantised it).
    const ego = document.data.roles[0]!;
    expect(ego.kind === 'scene_absolute' && ego.pose).toEqual({ position: { x: 10.123456789, y: 0, z: -12.5 }, headingRad: 1.2 });
    expect(detectMirroredOpenScenarioImport(document.data).status).toBe('already_fixed');

    expect(document.undo()).toBe(true);
    expect(document.data).toEqual(opened);
    document.dispose();
  });

  it('refuses a repair that names a role the document does not have, without writing', async () => {
    const document = await EditorDocument.openBlank(TEST_MAP, {
      store: new WebTemplateFileStore({ storage: new MemoryStorage() }),
      autosaveMs: 60_000,
    });
    document.importTemplate(mirroredImport());
    const before = document.data;
    const ghost = { ...document.data.roles[0]!, id: 'Ghost' };
    expect(() => document.applyRepair({ roles: [ghost], extensions: { x: 1 } })).toThrow(/unknown role "Ghost"/);
    expect(document.data).toBe(before);
    expect(document.canUndo).toBe(false);
    document.dispose();
  });
});

describe('setAmbientTrafficExtensions', () => {
  it('writes a traffic source and its density as one undoable edit', async () => {
    const document = await openedRecord();
    const edits = vi.fn();
    document.subscribeEdits(edits);
    const profile = { version: 1, preset: 'city', seed: 'ambient-1' };
    document.setAmbientTrafficExtensions({
      'studio.ambientTraffic.provider.v1': 'sumo',
      'studio.ambientTraffic.profile.v1': profile,
    });
    expect(edits).toHaveBeenCalledTimes(1);
    expect(document.data.extensions?.['studio.ambientTraffic.provider.v1']).toBe('sumo');
    expect(document.data.extensions?.['studio.ambientTraffic.profile.v1']).toEqual(profile);
    document.undo();
    expect(document.data.extensions?.['studio.ambientTraffic.provider.v1']).toBeUndefined();
    expect(document.data.extensions?.['studio.ambientTraffic.profile.v1']).toBeUndefined();
    document.dispose();
  });

  it('refuses keys outside the ambient traffic namespace', async () => {
    const document = await openedRecord();
    expect(() => document.setAmbientTrafficExtensions({ 'studio.presentation.x': 1 })).toThrow(/studio\.ambientTraffic\./);
    document.dispose();
  });
});
