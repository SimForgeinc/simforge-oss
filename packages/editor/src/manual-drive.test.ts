import { describe, expect, it } from 'vitest';
import {
  MANUAL_DRIVE_RECORDING_VERSION,
  MemoryStorage,
  WebTemplateFileStore,
  type ManualDriveRecording,
} from '@simforge-oss/scenario';
import { EditorDocument } from './document';
import { TEST_MAP } from './map';
import { manualDriveFor, recordedManualDrive } from './manual-drive';

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
