import { Scene } from 'three';
import { engine } from '@simforge-oss/engine/node';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { EditorViewer } from '@simforge-oss/editor';
import {
  EditorController,
  EditorDocument,
  LaneIndex,
  MAPS,
} from '@simforge-oss/editor';
import { MemoryStorage, WebTemplateFileStore } from '@simforge-oss/scenario';
import { hideStalePlacementGhost } from '../../../src/scenario/editor/placement-ghost';

/** The controller coalesces notifications onto a frame; tests drive that clock. */
const frames: FrameRequestCallback[] = [];

function flush(): void {
  frames.splice(0).forEach((frame) => frame(0));
}

beforeEach(() => {
  frames.length = 0;
  vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => null }) });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});
afterEach(() => vi.unstubAllGlobals());

function lanes(): LaneIndex {
  return LaneIndex.build({
    mapName: 'placement-ghost',
    lanes: {
      '1:0:-1': {
        rsl: '1:0:-1',
        roadId: 1,
        section: 0,
        laneId: -1,
        laneType: 'driving',
        polyline: [{ x: 0, y: 0 }, { x: 400, y: 0 }],
        isJunction: false,
        predecessors: [],
        successors: [],
      },
    },
    gates: [],
    junctions: {},
  }, { engine: engine() });
}

it('never leaves a ghost on stage after the editor takes the scene back', async () => {
  const document = await EditorDocument.openBlank(MAPS[0]!, {
    store: new WebTemplateFileStore({ storage: new MemoryStorage() }),
    autosaveMs: 60_000,
  });
  const viewer = { scene: new Scene() } as unknown as EditorViewer;
  const controller = new EditorController({
    viewer,
    laneIndex: lanes(),
    document,
    sampleHeight: () => 0,
  });
  const ghost = viewer.scene.children.find((child) => child.name === 'placement-ghost');
  expect(ghost, 'editor-core parents the placement ghost to the scene root').toBeDefined();

  // Arm placement, which builds the ghost's meshes, then end it the way the
  // single-shot palette flow does once the actor has been dropped.
  controller.togglePlacement('vehicle.sedan');
  flush();
  expect(controller.state.mode).toBe('placing');
  controller.cancel();
  flush();
  expect(controller.state.mode).toBe('idle');
  expect(ghost!.visible).toBe(false);

  // Upstream behaviour this exists to contain: restoring authoring chrome
  // re-shows the ghost without asking whether anything is being placed.
  controller.setPlaybackInspection(false);
  expect(ghost!.visible).toBe(true);

  expect(hideStalePlacementGhost(viewer.scene, controller.state.mode)).toBe(true);
  expect(ghost!.visible).toBe(false);
  // Already hidden: nothing to repair, so nothing is reported.
  expect(hideStalePlacementGhost(viewer.scene, controller.state.mode)).toBe(false);

  controller.dispose();
  document.dispose();
});

it('leaves the ghost alone while placement is armed', async () => {
  const document = await EditorDocument.openBlank(MAPS[0]!, {
    store: new WebTemplateFileStore({ storage: new MemoryStorage() }),
    autosaveMs: 60_000,
  });
  const viewer = { scene: new Scene() } as unknown as EditorViewer;
  const controller = new EditorController({
    viewer,
    laneIndex: lanes(),
    document,
    sampleHeight: () => 0,
  });
  const ghost = viewer.scene.children.find((child) => child.name === 'placement-ghost')!;

  controller.togglePlacement('vehicle.sedan');
  controller.setPlaybackInspection(false);
  flush();
  expect(controller.state.mode).toBe('placing');
  // The controller owns ghost visibility during a placement run: it hides the
  // ghost until the cursor is over the map and shows it on every ground move.
  expect(hideStalePlacementGhost(viewer.scene, controller.state.mode)).toBe(false);
  expect(ghost.visible).toBe(true);

  controller.dispose();
  document.dispose();
});

it('ignores a scene with no ghost, and a viewer with no scene yet', () => {
  expect(hideStalePlacementGhost(new Scene(), 'idle')).toBe(false);
  expect(hideStalePlacementGhost(null, 'idle')).toBe(false);
  expect(hideStalePlacementGhost(undefined, null)).toBe(false);
});
