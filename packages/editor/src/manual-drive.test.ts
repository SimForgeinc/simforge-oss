import { describe, expect, it } from 'vitest';
import {
  MANUAL_DRIVE_RECORDING_VERSION,
  MemoryStorage,
  WebTemplateFileStore,
  type Interaction,
  type ManualDriveRecording,
} from '@simforge-oss/scenario';
import { EditorDocument } from './document';
import { TEST_MAP } from './map';
import {
  checkManualDriveTake,
  decodeManualDriveTakeGuard,
  encodeManualDriveTakeGuard,
  isUnrecordedManualDrive,
  manualDriveFor,
  manualDrivePlaceholder,
  manualDriveTakeGuard,
} from './manual-drive';

async function blankDocument(): Promise<EditorDocument> {
  return EditorDocument.openBlank(TEST_MAP, {
    store: new WebTemplateFileStore({ storage: new MemoryStorage() }),
    autosaveMs: 60_000,
  });
}

/** One sample per 20 ms tick, driving straight along +x at 10 m/s. */
function straightTake(clipSeconds: number, x0 = 10, z0 = 5): ManualDriveRecording {
  const ticks = Math.round(clipSeconds / 0.02);
  return {
    version: MANUAL_DRIVE_RECORDING_VERSION,
    clipSeconds,
    samples: Array.from({ length: ticks + 1 }, (_, index) => {
      const timeS = index === ticks ? clipSeconds : Number((index * 0.02).toFixed(3));
      return { timeS, x: x0 + 10 * timeS, y: 0, z: z0, headingRad: 0, speedMps: 10 };
    }),
  };
}

const speedAction = (actor: string): Interaction => ({
  id: `speed_${actor}`,
  actor,
  label: 'Brake to stop',
  trigger: { kind: 'at', t: 4 },
  until: { kind: 'at', t: 6 },
  verb: 'speed',
  target: { mode: 'stop' },
  dynamics: { shape: 'linear', constraint: 'time', value: 1.5 },
});

const hornAction = (actor: string): Interaction => ({
  id: `horn_${actor}`,
  actor,
  label: 'Sound horn',
  trigger: { kind: 'at', t: 2 },
  verb: 'set',
  target: { key: 'audio.horn', value: true },
});

describe('replaceActorMotion', () => {
  it('installs a manual drive, evicts competing motion and keeps state actions, as one undo step', async () => {
    const document = await blankDocument();
    try {
      document.add([{ id: 'ego', catalogId: 'vehicle.sedan', x: 10, y: 0, z: 5, headingRad: 0 }]);
      document.addInteraction(speedAction('ego'));
      document.addInteraction(hornAction('ego'));
      document.add([{ id: 'other', catalogId: 'vehicle.sedan', x: 30, y: 0, z: 5, headingRad: 0 }]);
      document.addInteraction(speedAction('other'));
      const before = document.data.choreography.interactions.map((item) => item.id);

      document.replaceActorMotion(manualDrivePlaceholder(document.actor('ego')!, document.data.choreography.clipSeconds));

      const ids = document.data.choreography.interactions.map((item) => item.id);
      expect(ids).toEqual(['horn_ego', 'speed_other', 'manual_drive_ego']);
      expect(isUnrecordedManualDrive(manualDriveFor(document.data, 'ego')!)).toBe(true);

      expect(document.undo()).toBe(true);
      expect(document.data.choreography.interactions.map((item) => item.id)).toEqual(before);
    } finally {
      document.dispose();
    }
  });
});

describe('manual drive take guard', () => {
  it('accepts a take recorded against the unchanged document and refuses one after an edit', async () => {
    const document = await blankDocument();
    try {
      document.add([{ id: 'ego', catalogId: 'vehicle.sedan', x: 10, y: 0, z: 5, headingRad: 0 }]);
      const clipSeconds = document.data.choreography.clipSeconds;
      document.replaceActorMotion(manualDrivePlaceholder(document.actor('ego')!, clipSeconds));
      const interaction = manualDriveFor(document.data, 'ego')!;
      const guard = decodeManualDriveTakeGuard(encodeManualDriveTakeGuard(manualDriveTakeGuard({
        documentId: 'doc-1',
        mapVersionId: TEST_MAP.versionId,
        interaction,
        template: document.data,
      })))!;
      const recording = straightTake(clipSeconds);
      const check = () => checkManualDriveTake({
        template: document.data,
        documentId: 'doc-1',
        mapVersionId: TEST_MAP.versionId,
        actor: document.actor('ego'),
        guard,
        recording,
      });

      const accepted = check();
      expect(accepted.ok).toBe(true);
      if (accepted.ok) {
        expect(accepted.interaction.id).toBe(interaction.id);
        expect(accepted.interaction.until).toEqual({ kind: 'at', t: clipSeconds });
        expect(accepted.interaction.target.recording.samples).toHaveLength(recording.samples.length);
      }

      document.add([{ id: 'late', catalogId: 'vehicle.sedan', x: 40, y: 0, z: 5, headingRad: 0 }]);
      const refused = check();
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.reason).toMatch(/edited while recording/);
      expect(isUnrecordedManualDrive(manualDriveFor(document.data, 'ego')!)).toBe(true);
    } finally {
      document.dispose();
    }
  });

  it('refuses a take whose recording does not cover the clip', async () => {
    const document = await blankDocument();
    try {
      document.add([{ id: 'ego', catalogId: 'vehicle.sedan', x: 10, y: 0, z: 5, headingRad: 0 }]);
      const clipSeconds = document.data.choreography.clipSeconds;
      document.replaceActorMotion(manualDrivePlaceholder(document.actor('ego')!, clipSeconds));
      const interaction = manualDriveFor(document.data, 'ego')!;
      const guard = manualDriveTakeGuard({ documentId: 'doc-1', mapVersionId: TEST_MAP.versionId, interaction, template: document.data });
      const short = straightTake(clipSeconds / 2);
      const refused = checkManualDriveTake({
        template: document.data,
        documentId: 'doc-1',
        mapVersionId: TEST_MAP.versionId,
        actor: document.actor('ego'),
        guard,
        recording: short,
      });
      expect(refused.ok).toBe(false);
    } finally {
      document.dispose();
    }
  });
});

describe('manual drive follows its actor', () => {
  it('re-seeds a placeholder on the new pose and translates a recorded take rigidly', async () => {
    const document = await blankDocument();
    try {
      document.add([{ id: 'ego', catalogId: 'vehicle.sedan', x: 10, y: 0, z: 5, headingRad: 0 }]);
      const clipSeconds = document.data.choreography.clipSeconds;
      document.replaceActorMotion(manualDrivePlaceholder(document.actor('ego')!, clipSeconds));

      document.update([{ id: 'ego', x: 12, z: 9, headingRad: 1 }]);
      const placeholder = manualDriveFor(document.data, 'ego')!;
      expect(placeholder.target.recording.samples).toEqual([
        { timeS: 0, x: 12, y: 0, z: 9, headingRad: 1, speedMps: 0 },
        { timeS: clipSeconds, x: 12, y: 0, z: 9, headingRad: 1, speedMps: 0 },
      ]);

      const recording = straightTake(clipSeconds, 12, 9);
      document.replaceActorMotion({ ...placeholder, target: { mode: 'manualDrive', recording } });
      document.update([{ id: 'ego', x: 15, z: 10 }]);
      const moved = manualDriveFor(document.data, 'ego')!;
      expect(moved.target.recording.samples).toHaveLength(recording.samples.length);
      expect(moved.target.recording.samples[0]).toEqual({ timeS: 0, x: 15, y: 0, z: 10, headingRad: 0, speedMps: 10 });
      expect(moved.target.recording.samples.at(-1)).toEqual({
        timeS: clipSeconds, x: 15 + 10 * clipSeconds, y: 0, z: 10, headingRad: 0, speedMps: 10,
      });
    } finally {
      document.dispose();
    }
  });
});
