"use client";

import { createPortal } from "react-dom";
import * as stylex from "@stylexjs/stylex";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import type { ManualDriveRecording } from "@simforge-oss/scenario";
import { manualTake } from "./manual-drive-take.stylex";

export function ManualDriveTakeReview({
  recording,
  error,
  onSave,
  onRetry,
  onDiscard,
}: {
  recording: ManualDriveRecording;
  error: string | null;
  onSave: () => void;
  onRetry: () => void;
  onDiscard: () => void;
}) {
  if (typeof document === "undefined") return null;
  return createPortal(
    <div {...stylex.props(manualTake.modal)} role="dialog" aria-modal="true" aria-label="Manual drive take review">
      <div {...stylex.props(manualTake.dialog)}>
        <h2 {...stylex.props(manualTake.title)}>Take complete</h2>
        <p {...stylex.props(manualTake.summary)}>
          {recording.samples.length} samples over {recording.clipSeconds.toFixed(1)} seconds.
        </p>
        {error ? <p {...stylex.props(manualTake.error)} role="alert">{error}</p> : null}
        <div {...stylex.props(manualTake.actions)}>
          <Button type="button" variant="ghost" onClick={onDiscard}>Discard</Button>
          <Button type="button" variant="outline" onClick={onRetry}>Retry</Button>
          <Button type="button" onClick={onSave}>Save take</Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
