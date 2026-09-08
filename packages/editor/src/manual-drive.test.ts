import { describe, expect, it } from 'vitest';
import { contentHash } from '@simforge-oss/engine';
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
  manualDriveFor,
  manualDriveTakeGuard,
  recordedManualDrive,
} from './manual-drive';

async function blankDocument(): Promise<EditorDocument> {
  return EditorDocument.openBlank(TEST_MAP, {
    store: new WebTemplateFileStore({ storage: new MemoryStorage() }),
    autosaveMs: 60_000,
  });
}

/** One sample per 20 ms tick, driving along +x at `speedMps` (0 = a stationary take). */
function take(clipSeconds: number, speedMps: number, x0 = 10, z0 = 5): ManualDriveRecording {
  const ticks = Math.round(clipSeconds / 0.02);
  return {
    version: MANUAL_DRIVE_RECORDING_VERSION,
    clipSeconds,
    samples: Array.from({ length: ticks + 1 }, (_, index) => {
      const timeS = index === ticks ? clipSeconds : Number((index * 0.02).toFixed(3));
      return { timeS, x: x0 + speedMps * timeS, y: 0, z: z0, headingRad: 0, speedMps };
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

describe('manual drive take guard', () => {
  it('opening a take writes nothing; a saved take enters as one undo step and evicts only competing motion', async () => {
    const document = await blankDocument();
    try {
      document.add([{ id: 'ego', catalogId: 'vehicle.sedan', x: 10, y: 0, z: 5, headingRad: 0 }]);
      document.addInteraction(speedAction('ego'));
      document.addInteraction(hornAction('ego'));
      document.add([{ id: 'other', catalogId: 'vehicle.sedan', x: 30, y: 0, z: 5, headingRad: 0 }]);
      document.addInteraction(speedAction('other'));
      const before = document.data.choreography.interactions.map((item) => item.id);
      const hashBefore = contentHash(document.data);
      const clipSeconds = document.data.choreography.clipSeconds;

      const guard = decodeManualDriveTakeGuard(encodeManualDriveTakeGuard(manualDriveTakeGuard({
        documentId: 'doc-1',
        mapVersionId: TEST_MAP.versionId,
        actorRoleId: 'ego',
        template: document.data,
      })))!;
      expect(guard.interactionId).toBe('manual_drive_ego');
      expect(manualDriveFor(document.data, 'ego')).toBeUndefined();
      expect(contentHash(document.data)).toBe(hashBefore);

      const accepted = checkManualDriveTake({
        template: document.data,
        documentId: 'doc-1',
        mapVersionId: TEST_MAP.versionId,
        actor: document.actor('ego'),
        guard,
        recording: take(clipSeconds, 10),
      });
      expect(accepted.ok).toBe(true);
      if (!accepted.ok) return;
      expect(accepted.interaction).toMatchObject({
        id: 'manual_drive_ego', actor: 'ego', verb: 'route', trigger: { kind: 'at', t: 0 }, until: { kind: 'at', t: clipSeconds },
      });

      document.replaceActorMotion(accepted.interaction);
      expect(document.data.choreography.interactions.map((item) => item.id)).toEqual(['horn_ego', 'speed_other', 'manual_drive_ego']);

      expect(document.undo()).toBe(true);
      expect(document.data.choreography.interactions.map((item) => item.id)).toEqual(before);
      expect(contentHash(document.data)).toBe(hashBefore);
    } finally {
      document.dispose();
    }
  });

  it('refuses a take once the document was edited, and re-records an existing drive under its own id', async () => {
    const document = await blankDocument();
    try {
      document.add([{ id: 'ego', catalogId: 'vehicle.sedan', x: 10, y: 0, z: 5, headingRad: 0 }]);
      const clipSeconds = document.data.choreography.clipSeconds;
      document.replaceActorMotion(recordedManualDrive('ego', take(clipSeconds, 10)));
      const existing = manualDriveFor(document.data, 'ego')!;

      const guard = manualDriveTakeGuard({ documentId: 'doc-1', mapVersionId: TEST_MAP.versionId, actorRoleId: 'ego', template: document.data });
      expect(guard.interactionId).toBe(existing.id);
      const check = () => checkManualDriveTake({
        template: document.data,
        documentId: 'doc-1',
        mapVersionId: TEST_MAP.versionId,
        actor: document.actor('ego'),
        guard,
        recording: take(clipSeconds, 0),
      });

      // A stationary take is a real take: it is accepted on its own terms.
      const accepted = check();
      expect(accepted.ok).toBe(true);
      if (accepted.ok) expect(accepted.interaction.id).toBe(existing.id);

      document.add([{ id: 'late', catalogId: 'vehicle.sedan', x: 40, y: 0, z: 5, headingRad: 0 }]);
      const refused = check();
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.reason).toMatch(/edited while recording/);
      expect(manualDriveFor(document.data, 'ego')).toEqual(existing);
    } finally {
      document.dispose();
    }
  });

  it('refuses a take whose recording does not cover the clip', async () => {
    const document = await blankDocument();
    try {
      document.add([{ id: 'ego', catalogId: 'vehicle.sedan', x: 10, y: 0, z: 5, headingRad: 0 }]);
      const clipSeconds = document.data.choreography.clipSeconds;
      const guard = manualDriveTakeGuard({ documentId: 'doc-1', mapVersionId: TEST_MAP.versionId, actorRoleId: 'ego', template: document.data });
      const refused = checkManualDriveTake({
        template: document.data,
        documentId: 'doc-1',
        mapVersionId: TEST_MAP.versionId,
        actor: document.actor('ego'),
        guard,
        recording: take(clipSeconds / 2, 10),
      });
      expect(refused.ok).toBe(false);
    } finally {
      document.dispose();
    }
  });
});

describe('a recorded take follows its actor', () => {
  it('translates the whole track rigidly when the actor is moved', async () => {
    const document = await blankDocument();
    try {
      document.add([{ id: 'ego', catalogId: 'vehicle.sedan', x: 12, y: 0, z: 9, headingRad: 0 }]);
      const clipSeconds = document.data.choreography.clipSeconds;
      const recording = take(clipSeconds, 10, 12, 9);
      document.replaceActorMotion(recordedManualDrive('ego', recording));

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
