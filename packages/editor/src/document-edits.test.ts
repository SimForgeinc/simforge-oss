import { describe, expect, it, vi } from 'vitest';
import { MemoryStorage, WebTemplateFileStore } from '@simforge-oss/scenario';
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
