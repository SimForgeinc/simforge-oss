"use client";

import * as stylex from "@stylexjs/stylex";
import { styles } from "./ManualDriveReviewPanel.stylex";
import { AlertTriangle, Gauge, Route, Timer, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { summarizeRecording } from "./authoring";
import type { ManualDriveRecorder, ManualDriveTakeReview } from "./use-manual-drive-recorder";

/**
 * The one place a finished take can enter the document. It says, before Save,
 * exactly what the take replaces: the previous recording on the actor, if any,
 * and any other motion the actor still carried. Lights, horn, existence
 * and every other actor are untouched, and the dialog says so rather than
 * leaving the author to guess.
 *
 * Portaled to `document.body` like `SensorSetupModal`: the editor overlay root
 * is `pointer-events-none` so the viewport receives the pointer, and a dialog
 * rendered inside it would let Save fall through to the map.
 */
export function ManualDriveReviewPanel({
  review,
  actorLabel,
  recorder,
}: {
  review: ManualDriveTakeReview;
  actorLabel: string;
  recorder: Pick<ManualDriveRecorder, "saveReview" | "discardReview" | "rerecord">;
}) {
  const [failure, setFailure] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => setMounted(true), []);
  const summary = summarizeRecording(review.recording);
  const refusal = review.check.ok ? null : review.check.reason;
  const current = review.replaces.current;
  const replacing = current === null
    ? null
    : `its previous recording (${current.target.recording.samples.length} samples over ${current.target.recording.clipSeconds}s)`;

  // Escape discards, exactly as the close button does; the take stays in the
  // mailbox only until this dialog answers, so leaving it must be deliberate.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      recorder.discardReview();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [recorder]);

  // Focus lands on the dialog itself when Save is refused, so keyboard users
  // are never left on the canvas behind a modal.
  useEffect(() => {
    if (!mounted || !refusal) return;
    dialogRef.current?.focus();
  }, [mounted, refusal]);

  const run = (action: () => string | null) => {
    setFailure(action());
  };

  if (!mounted) return null;
  return createPortal(
    <div
      {...stylex.props(styles.manualDriveReviewBackdrop)}
      data-testid="manual-drive-review-backdrop"
    >
      <section
        ref={dialogRef}
        aria-describedby="manual-drive-review-description"
        aria-labelledby="manual-drive-review-title"
        aria-modal="true"
        {...stylex.props(styles.manualDriveReview)}
        data-testid="manual-drive-review"
        role="dialog"
        tabIndex={-1}
      >
        <div {...stylex.props(styles.divFlex)}>
          <span {...stylex.props(styles.spanFlexIcon)}>
            <Route aria-hidden="true" {...stylex.props(styles.routeIcon)} />
          </span>
          <div {...stylex.props(styles.div)}>
            <p {...stylex.props(styles.manualDrive)}>
              Manual drive
            </p>
            <h2 {...stylex.props(styles.manualDriveReviewTitle)} id="manual-drive-review-title">
              Review the take for {actorLabel}
            </h2>
          </div>
          <button
            aria-label="Discard take"
            {...stylex.props(styles.discardTakeButton)}
            onClick={recorder.discardReview}
            type="button"
          >
            <X aria-hidden="true" {...stylex.props(styles.xIcon)} />
          </button>
        </div>

        <div {...stylex.props(styles.manualDriveReviewDescription)} id="manual-drive-review-description">
          <dl {...stylex.props(styles.dlGrid)}>
            <div>
              <dt {...stylex.props(styles.dtFlexUppercase)}>
                <Timer aria-hidden="true" {...stylex.props(styles.clipTimer)} /> Clip
              </dt>
              <dd {...stylex.props(styles.manualDriveReviewClip)} data-testid="manual-drive-review-clip">
                {review.recording.clipSeconds}s
              </dd>
            </div>
            <div>
              <dt {...stylex.props(styles.dtFlexUppercase2)}>
                <Route aria-hidden="true" {...stylex.props(styles.drivenRoute)} /> Driven
              </dt>
              <dd {...stylex.props(styles.manualDriveReviewDistance)} data-testid="manual-drive-review-distance">
                {summary.distanceM.toFixed(0)} m
              </dd>
            </div>
            <div>
              <dt {...stylex.props(styles.dtFlexUppercase3)}>
                <Gauge aria-hidden="true" {...stylex.props(styles.peakGauge)} /> Peak
              </dt>
              <dd {...stylex.props(styles.manualDriveReviewSpeed)} data-testid="manual-drive-review-speed">
                {summary.maxSpeedKph.toFixed(0)} km/h
              </dd>
            </div>
          </dl>
          <p {...stylex.props(styles.manualDriveReviewSamples)} data-testid="manual-drive-review-samples">
            {review.recording.samples.length} poses captured from the simulation clock, from 0s to {review.recording.clipSeconds}s.
            Playback follows these recorded poses and their timing exactly.
          </p>
          {refusal ? (
            <div
              className="flex gap-3 border border-red-400/40 bg-red-500/10 p-3 text-sm leading-6 text-red-100"
              data-testid="manual-drive-review-refusal"
              role="alert"
            >
              <AlertTriangle aria-hidden="true" {...stylex.props(styles.alerttriangleIcon)} />
              <p>
                This take cannot be saved: {refusal} {actorLabel} keeps the motion it has now.
              </p>
            </div>
          ) : (
            <div {...stylex.props(styles.manualDriveReviewReplacement)} data-testid="manual-drive-review-replacement">
              <p>
                {replacing
                  ? <>Saving replaces {actorLabel}&rsquo;s motion for the whole clip &mdash; {replacing}.</>
                  : <>Saving makes this take {actorLabel}&rsquo;s motion for the whole clip.</>}
              </p>
              {review.replaces.otherMotion.length > 0 ? (
                <p {...stylex.props(styles.it)}>
                  It {replacing ? "also " : ""}removes {review.replaces.otherMotion.length === 1 ? "one other motion action" : `${review.replaces.otherMotion.length} other motion actions`} on this actor:{" "}
                  <strong {...stylex.props(styles.strongSemibold)}>
                    {review.replaces.otherMotion.map((interaction) => interaction.label ?? interaction.verb).join(", ")}
                  </strong>.
                </p>
              ) : null}
              <p {...stylex.props(styles.lights)}>
                Lights, horn and other state actions on this actor, and every other actor, stay as they are.
                Save is one undo step.
              </p>
            </div>
          )}
          {failure ? (
            <p {...stylex.props(styles.manualDriveReviewFailure)} data-testid="manual-drive-review-failure" role="alert">
              {failure}
            </p>
          ) : null}
        </div>

        <div {...stylex.props(styles.divFlex2)}>
          <button
            {...stylex.props(styles.manualDriveReviewDiscardButton)}
            data-testid="manual-drive-review-discard"
            onClick={recorder.discardReview}
            type="button"
          >
            Discard
          </button>
          <button
            {...stylex.props(styles.manualDriveReviewRerecordButton)}
            data-testid="manual-drive-review-rerecord"
            onClick={() => run(recorder.rerecord)}
            type="button"
          >
            Drive again
          </button>
          <button
            autoFocus={!refusal}
            {...stylex.props(styles.manualDriveReviewSaveButton)}
            data-testid="manual-drive-review-save"
            disabled={Boolean(refusal)}
            onClick={() => run(recorder.saveReview)}
            type="button"
          >
            Save take
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}
