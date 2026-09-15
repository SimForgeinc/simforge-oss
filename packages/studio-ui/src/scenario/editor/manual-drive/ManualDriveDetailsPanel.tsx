"use client";

import * as stylex from "@stylexjs/stylex";
import { styles } from "./ManualDriveDetailsPanel.stylex";
import { Gamepad2 } from "lucide-react";
import { useState } from "react";
import type { ManualDriveInteraction } from "@simforge-oss/editor";

import { EditorDetailsPanel } from "../inspector/EditorDetailsPanel";
import { summarizeRecording } from "./authoring";
import type { ManualDriveRecorder } from "./use-manual-drive-recorder";

/**
 * Right-side details for a saved Manual drive. A drive is recorded, never
 * typed, so this surface shows the take and offers exactly the recorder:
 * Record again replaces this take only after the new one is reviewed and
 * saved, and while a recorder tab is open the editor says it is waiting.
 */
export function ManualDriveDetailsPanel({
  interaction,
  clipSeconds,
  recorder,
  onClose,
  onDelete,
}: {
  interaction: ManualDriveInteraction;
  clipSeconds: number;
  recorder: ManualDriveRecorder | null;
  onClose: () => void;
  onDelete: () => void;
}) {
  const [failure, setFailure] = useState<string | null>(null);
  const recording = interaction.target.recording;
  const clipMismatch = Math.abs(recording.clipSeconds - clipSeconds) > 1e-6;
  const summary = summarizeRecording(recording);
  const waiting = recorder?.inFlight?.actorRoleId === interaction.actor ? recorder.inFlight : null;

  return (
    <EditorDetailsPanel
      ariaLabel="Manual drive details"
      id={`scenario-interaction-${interaction.id}`}
      onClose={onClose}
      onDelete={onDelete}
      preview={(
        <div {...stylex.props(styles.divFlex)}>
          <Gamepad2 aria-hidden="true" {...stylex.props(styles.gamepad2Icon)} />
          <strong {...stylex.props(styles.manualDrive)}>Manual drive</strong>
          <span {...stylex.props(styles.manualDriveStatus)} data-testid="manual-drive-status">
            {clipMismatch ? "Clip length changed" : "Recorded"}
          </span>
        </div>
      )}
      testId="scenario-manual-drive-panel"
    >
      <div {...stylex.props(styles.manualDriveDetails)} data-interaction-id={interaction.id} data-testid={`manual-drive-details-${interaction.id}`}>
        <p {...stylex.props(styles.p)}>
          {recording.samples.length} poses over {recording.clipSeconds}s · {summary.distanceM.toFixed(0)} m · peak {summary.maxSpeedKph.toFixed(0)} km/h.
        </p>
        {clipMismatch ? (
          <p {...stylex.props(styles.manualDriveClipMismatch)} data-testid="manual-drive-clip-mismatch" role="alert">
            Recorded for a {recording.clipSeconds}s clip; the clip is now {clipSeconds}s. Record it again.
          </p>
        ) : null}
        <p {...stylex.props(styles.ownsThisActorRsquo)}>
          Owns this actor&rsquo;s motion from 0s to the end of the clip. It cannot be shortened or moved on the timeline.
        </p>
        {waiting ? (
          <div {...stylex.props(styles.manualDriveWaiting)} data-testid="manual-drive-waiting">
            <p {...stylex.props(styles.recorderOpenInAnotherTabFini)}>
              Recorder open in another tab. Finish the drive there; the take comes back here for review.
              This recording stays until the new take is saved.
            </p>
            <button
              {...stylex.props(styles.manualDriveStopWaitingButton)}
              data-testid="manual-drive-stop-waiting"
              onClick={recorder?.abandonTake}
              type="button"
            >
              Stop waiting
            </button>
          </div>
        ) : (
          <>
            <button
              {...stylex.props(styles.manualDriveRecordButton)}
              data-testid={`manual-drive-record-${interaction.id}`}
              disabled={!recorder}
              onClick={() => setFailure(recorder ? recorder.startTake(interaction.actor) : "The recorder is not available here.")}
              type="button"
            >
              Record again
            </button>
            <p {...stylex.props(styles.recordingAgainReplacesThisTa)}>
              Recording again replaces this take only after you review and save the new one.
            </p>
          </>
        )}
        {failure ? (
          <p {...stylex.props(styles.manualDriveRecordFailure)} data-testid="manual-drive-record-failure" role="alert">
            {failure}
          </p>
        ) : null}
      </div>
    </EditorDetailsPanel>
  );
}
