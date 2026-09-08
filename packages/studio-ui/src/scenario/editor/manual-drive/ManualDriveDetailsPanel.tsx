"use client";

import { Gamepad2 } from "lucide-react";
import { useState } from "react";
import { isUnrecordedManualDrive, type ManualDriveInteraction } from "@simforge-oss/editor";

import { EditorDetailsPanel } from "../inspector/EditorDetailsPanel";
import { summarizeRecording } from "./authoring";
import type { ManualDriveRecorder } from "./use-manual-drive-recorder";

/**
 * Right-side details for a Manual drive. A drive is recorded, never typed, so
 * this surface shows the state of the take and offers exactly the recorder:
 * Record drive for a placeholder, Record again for a saved take, and while a
 * recorder tab is open, the fact that the editor is waiting on it.
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
  const unrecorded = isUnrecordedManualDrive(interaction);
  const recording = interaction.target.recording;
  const clipMismatch = !unrecorded && Math.abs(recording.clipSeconds - clipSeconds) > 1e-6;
  const summary = unrecorded ? null : summarizeRecording(recording);
  const waiting = recorder?.inFlight?.interactionId === interaction.id ? recorder.inFlight : null;

  return (
    <EditorDetailsPanel
      ariaLabel="Manual drive details"
      id={`scenario-interaction-${interaction.id}`}
      onClose={onClose}
      onDelete={onDelete}
      preview={(
        <div className="flex flex-col items-center gap-1 text-center">
          <Gamepad2 aria-hidden="true" className="size-9 text-[#E8E044]" />
          <strong className="text-xs font-medium text-white">Manual drive</strong>
          <span className="text-[9px] uppercase tracking-[0.16em] text-white/40" data-testid="manual-drive-status">
            {unrecorded ? "Not recorded yet" : clipMismatch ? "Clip length changed" : "Recorded"}
          </span>
        </div>
      )}
      testId="scenario-manual-drive-panel"
    >
      <div className="space-y-3" data-interaction-id={interaction.id} data-testid={`manual-drive-details-${interaction.id}`}>
        <p className="text-[10px] leading-4 text-white/55">
          {unrecorded
            ? `Holds the starting pose for the whole ${clipSeconds}s clip until you drive it.`
            : `${recording.samples.length} poses over ${recording.clipSeconds}s · ${summary!.distanceM.toFixed(0)} m · peak ${summary!.maxSpeedKph.toFixed(0)} km/h.`}
        </p>
        {clipMismatch ? (
          <p className="text-[10px] leading-4 text-amber-200" data-testid="manual-drive-clip-mismatch" role="alert">
            Recorded for a {recording.clipSeconds}s clip; the clip is now {clipSeconds}s. Record it again.
          </p>
        ) : null}
        <p className="text-[10px] leading-4 text-white/45">
          Owns this actor&rsquo;s motion from 0s to the end of the clip. It cannot be shortened or moved on the timeline.
        </p>
        {waiting ? (
          <div className="space-y-2" data-testid="manual-drive-waiting">
            <p className="text-[10px] leading-4 text-[#E8E044]">
              Recorder open in another tab. Finish the drive there; the take comes back here for review.
            </p>
            <button
              className="editor-motion flex h-8 w-full items-center justify-center rounded-lg border border-white/15 px-3 text-[10px] font-semibold text-white/70 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044]"
              data-testid="manual-drive-stop-waiting"
              onClick={recorder?.abandonTake}
              type="button"
            >
              Stop waiting
            </button>
          </div>
        ) : (
          <button
            className="editor-motion flex h-10 w-full items-center justify-center rounded-lg border border-[#E8E044] bg-[#E8E044] px-3 text-xs font-semibold text-black hover:bg-[#f4ed5d] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:cursor-not-allowed disabled:opacity-40"
            data-testid={`manual-drive-record-${interaction.id}`}
            disabled={!recorder}
            onClick={() => setFailure(recorder ? recorder.startTake(interaction.id) : "The recorder is not available here.")}
            type="button"
          >
            {unrecorded ? "Record drive" : "Record again"}
          </button>
        )}
        {failure ? (
          <p className="text-[10px] leading-4 text-amber-200" data-testid="manual-drive-record-failure" role="alert">
            {failure}
          </p>
        ) : null}
        {!unrecorded && !waiting ? (
          <p className="text-[10px] leading-4 text-white/45">
            Recording again replaces this take only after you review and save the new one.
          </p>
        ) : null}
      </div>
    </EditorDetailsPanel>
  );
}
