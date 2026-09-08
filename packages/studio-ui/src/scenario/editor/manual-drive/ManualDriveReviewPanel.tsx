"use client";

import { AlertTriangle, Gauge, Route, Timer, X } from "lucide-react";
import { useState } from "react";
import { isUnrecordedManualDrive } from "@simforge-oss/editor";

import { summarizeRecording } from "./authoring";
import type { ManualDriveRecorder, ManualDriveTakeReview } from "./use-manual-drive-recorder";

/**
 * The one place a finished take can enter the document. It says, before Save,
 * exactly what the take replaces: the placeholder or previous recording on the
 * actor, and any other motion the actor still carried. Lights, horn, existence
 * and every other actor are untouched, and the dialog says so rather than
 * leaving the author to guess.
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
  const summary = summarizeRecording(review.recording);
  const refusal = review.check.ok ? null : review.check.reason;
  const current = review.replaces.current;
  const replacing = current === null
    ? null
    : isUnrecordedManualDrive(current)
      ? "its unrecorded placeholder (the actor was holding its starting pose)"
      : `its previous recording (${current.target.recording.samples.length} samples over ${current.target.recording.clipSeconds}s)`;

  const run = (action: () => string | null) => {
    setFailure(action());
  };

  return (
    <div
      className="fixed inset-0 z-[150] flex items-center justify-center bg-black/55 px-4 backdrop-blur-sm"
      data-testid="manual-drive-review-backdrop"
    >
      <section
        aria-describedby="manual-drive-review-description"
        aria-labelledby="manual-drive-review-title"
        aria-modal="true"
        className="w-full max-w-md border border-white/15 bg-[#111111]/95 p-5 text-white shadow-[0_24px_80px_rgba(0,0,0,0.7)]"
        data-testid="manual-drive-review"
        role="dialog"
      >
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center bg-[#E8E044] text-black">
            <Route aria-hidden="true" className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-[#E8E044]">
              Manual drive
            </p>
            <h2 className="mt-1 text-lg font-semibold" id="manual-drive-review-title">
              Review the take for {actorLabel}
            </h2>
          </div>
          <button
            aria-label="Discard take"
            className="flex size-8 shrink-0 items-center justify-center text-white/55 transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044]"
            onClick={recorder.discardReview}
            type="button"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        </div>

        <div className="mt-5 space-y-3" id="manual-drive-review-description">
          <dl className="grid grid-cols-3 gap-2 border-t border-white/10 pt-3 text-center">
            <div>
              <dt className="flex items-center justify-center gap-1 text-[9px] uppercase tracking-[0.14em] text-white/40">
                <Timer aria-hidden="true" className="size-3" /> Clip
              </dt>
              <dd className="mt-1 text-sm font-semibold" data-testid="manual-drive-review-clip">
                {review.recording.clipSeconds}s
              </dd>
            </div>
            <div>
              <dt className="flex items-center justify-center gap-1 text-[9px] uppercase tracking-[0.14em] text-white/40">
                <Route aria-hidden="true" className="size-3" /> Driven
              </dt>
              <dd className="mt-1 text-sm font-semibold" data-testid="manual-drive-review-distance">
                {summary.distanceM.toFixed(0)} m
              </dd>
            </div>
            <div>
              <dt className="flex items-center justify-center gap-1 text-[9px] uppercase tracking-[0.14em] text-white/40">
                <Gauge aria-hidden="true" className="size-3" /> Peak
              </dt>
              <dd className="mt-1 text-sm font-semibold" data-testid="manual-drive-review-speed">
                {summary.maxSpeedKph.toFixed(0)} km/h
              </dd>
            </div>
          </dl>
          <p className="border-t border-white/10 pt-3 text-sm leading-6 text-white/75" data-testid="manual-drive-review-samples">
            {review.recording.samples.length} poses captured from the simulation clock, from 0s to {review.recording.clipSeconds}s.
            Playback follows these recorded poses and their timing exactly.
          </p>
          {refusal ? (
            <div
              className="flex gap-3 border border-red-400/40 bg-red-500/10 p-3 text-sm leading-6 text-red-100"
              data-testid="manual-drive-review-refusal"
              role="alert"
            >
              <AlertTriangle aria-hidden="true" className="mt-1 size-4 shrink-0" />
              <p>
                This take cannot be saved: {refusal} {actorLabel} keeps the motion it has now.
              </p>
            </div>
          ) : (
            <div className="border-t border-white/10 pt-3 text-sm leading-6 text-white/75" data-testid="manual-drive-review-replacement">
              <p>
                Saving replaces {actorLabel}&rsquo;s motion for the whole clip
                {replacing ? <> &mdash; {replacing}</> : null}.
              </p>
              {review.replaces.otherMotion.length > 0 ? (
                <p className="mt-1">
                  It also removes {review.replaces.otherMotion.length === 1 ? "one other motion action" : `${review.replaces.otherMotion.length} other motion actions`} on this actor:{" "}
                  <strong className="font-semibold text-white">
                    {review.replaces.otherMotion.map((interaction) => interaction.label ?? interaction.verb).join(", ")}
                  </strong>.
                </p>
              ) : null}
              <p className="mt-1 text-white/55">
                Lights, horn and other state actions on this actor, and every other actor, stay as they are.
                Save is one undo step.
              </p>
            </div>
          )}
          {failure ? (
            <p className="text-sm leading-6 text-amber-200" data-testid="manual-drive-review-failure" role="alert">
              {failure}
            </p>
          ) : null}
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-end gap-2 border-t border-white/10 pt-4">
          <button
            className="h-10 px-4 text-xs font-semibold uppercase tracking-[0.12em] text-white/70 transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044]"
            data-testid="manual-drive-review-discard"
            onClick={recorder.discardReview}
            type="button"
          >
            Discard
          </button>
          <button
            className="h-10 border border-[#E8E044]/50 px-4 text-xs font-semibold uppercase tracking-[0.12em] text-[#E8E044] transition-colors hover:bg-[#E8E044]/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044]"
            data-testid="manual-drive-review-rerecord"
            onClick={() => run(recorder.rerecord)}
            type="button"
          >
            Drive again
          </button>
          <button
            autoFocus={!refusal}
            className="h-10 bg-[#E8E044] px-5 text-xs font-bold uppercase tracking-[0.12em] text-black transition-colors hover:bg-[#f4ed55] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:cursor-not-allowed disabled:opacity-40"
            data-testid="manual-drive-review-save"
            disabled={Boolean(refusal)}
            onClick={() => run(recorder.saveReview)}
            type="button"
          >
            Save take
          </button>
        </div>
      </section>
    </div>
  );
}
