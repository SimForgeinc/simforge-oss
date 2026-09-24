"use client";

import { useStudioHost } from "../../../host";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Check, CircleDashed, Play, TriangleAlert } from "lucide-react";
import { CloudActivityIndicator } from "../../../components/CloudLoadingSurface";
import { useVisiblePolling } from "../../../lib/use-visible-polling";
import { RenderProgressBar, RenderStateChip } from "./RenderStatePieces";
import {
  activeRetry,
  artifactDisplayName,
  formatBytes,
  formatElapsed,
  formatTimestamp,
  jobFailureMessage,
  renderJobLabel,
  renderPipelineStages,
  renderStateVisual,
  shortDigest,
} from "./render-view-model";
import type { ScenarioRenderJobDetailDto } from "@simforge-oss/studio-host";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./RenderProgressView.stylex";
import { motionStyles } from "../../../stylex/motion.stylex";
import { focus, textLayout, typography } from "../../../stylex/recipes.stylex";

/** Faster than the gallery's 5s: this view exists to be watched, so it should keep up. */
const DETAIL_POLL_MS = 2000;

/**
 * What a submitted render is doing, while it does it.
 *
 * Submitting used to drop the author straight into the theater, which is built for finished footage:
 * a queued CARLA job showed a chip, an empty video frame and nothing else for minutes. The complaint
 * that follows is always the same — it looks like nothing is happening.
 *
 * So everything the control plane actually exposes is on screen, and something visibly moves every
 * second even though the worker reports coarsely and the poll is every two:
 *
 *  - the pipeline's real stages, ticked off from the job's own event stream, with the one being
 *    waited on called out rather than left as an unmarked gap;
 *  - `progressPercent` when a worker has reported one, and an honest indeterminate bar when not;
 *  - elapsed time and time-since-last-event, recomputed on a local clock so the surface stays alive
 *    between polls instead of freezing for two seconds at a time;
 *  - which worker claimed it and on which attempt, because "a machine has this" is the single most
 *    reassuring fact available and it was previously buried in a details tab;
 *  - artifacts as they land, each with its size, so output arriving is visible before the job ends.
 *
 * Nothing here is derived from a timer pretending to be progress. Every number and every tick comes
 * from the job, and when the job says nothing the surface says that too.
 */
export function RenderProgressView({
  jobId,
  onBack,
  onWatch,
}: {
  jobId: string;
  onBack: () => void;
  /** Offered once there is something to play. Never automatic: it would yank the view mid-read. */
  onWatch: (jobId: string) => void;
}) {
  const studioHost = useStudioHost();
  const [detail, setDetail] = useState<ScenarioRenderJobDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // A local clock, so elapsed and "last heard" advance every second rather than every poll.
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const next = await studioHost.jobs.getRenderJobDetail(jobId, signal);
        if (signal?.aborted) return;
        setDetail(next);
        setError(null);
      } catch (cause) {
        if (signal?.aborted) return;
        setError(cause instanceof Error ? cause.message : "Could not read this render's status.");
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [jobId, studioHost],
  );

  useEffect(() => {
    const abort = new AbortController();
    void load(abort.signal);
    return () => abort.abort();
  }, [load]);

  const live = detail === null ? true : renderStateVisual(detail.jobState).live;
  useVisiblePolling(() => void load(), DETAIL_POLL_MS, live, jobId);

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);

  const progress = detail ? renderPipelineStages(detail) : null;
  const stages = progress?.stages ?? [];
  const attempt = detail?.attempts.at(-1) ?? null;
  const retry = detail ? activeRetry(detail) : null;
  const retryLabel = retry ? `Retrying · attempt ${retry.attempt} ${retry.phase}` : null;
  const failure = detail ? jobFailureMessage(detail) : null;
  const playable = detail?.artifacts.some(
    (artifact) => artifact.mediaType.startsWith("video/") && artifact.artifactState === "available",
  ) ?? false;
  // `now` is read through these so the interval above actually re-renders the elapsed figures.
  const sinceStart = detail
    ? formatElapsed(detail.startedAt ?? detail.createdAt, detail.completedAt ?? new Date(now).toISOString())
    : "—";
  const sinceEvent = progress ? formatElapsed(progress.updatedAt, new Date(now).toISOString()) : null;

  return (
    <section
      aria-label="Render progress"
      className={`${stylex.props(styles.flexColFill).className} render-view-enter`}
      data-render-job-id={jobId}
      data-render-state={detail?.jobState ?? "loading"}
      data-testid="render-progress-view"
    >
      <header {...stylex.props(styles.flexCenterTight)}>
        <button
          aria-label="Back to the render gallery"
          className={stylex.props([focus.ring, styles.gridCenteredTight], motionStyles.editorMotion).className}
          data-testid="render-progress-back"
          onClick={onBack}
          type="button"
        >
          <ArrowLeft aria-hidden="true" className={stylex.props(styles.size4).className} />
        </button>
        <div {...stylex.props(styles.fillNarrowable)}>
          <p {...stylex.props([typography.eyebrow, styles.capsMonoMicro])}>
            {detail ? renderJobLabel(detail) : "Render"}
          </p>
          <h2 {...stylex.props([textLayout.truncate, styles.inkTruncateBase])}>
            {progress?.label ?? "Reading status…"}
            <span {...stylex.props(styles.monoXsMuted)}>{sinceStart}</span>
          </h2>
        </div>
        {detail ? <RenderStateChip state={detail.jobState} label={progress?.label} /> : <CloudActivityIndicator />}
        {playable ? (
          <button
            className={stylex.props([focus.ring, [typography.eyebrow, styles.inlineFlexCenterTight]], motionStyles.editorMotion).className}
            data-testid="render-progress-watch"
            onClick={() => onWatch(jobId)}
            type="button"
          >
            <Play aria-hidden="true" className={stylex.props(styles.size35).className} />
            Watch
          </button>
        ) : null}
      </header>

      <div {...stylex.props(styles.fillScrollYShrinkable)}>
        {error !== null && detail === null ? (
          <p {...stylex.props(styles.xsDangerBordered)}>{error}</p>
        ) : null}

        {detail ? (
          <>
            <RenderProgressBar
              xstyle={styles.mb1}
              label="Render progress"
              progressPercent={progress?.percent ?? null}
              state={detail.jobState}
            />
            <p {...stylex.props(styles.flexBaselineWrap)}>
              <span data-testid="render-progress-percent">
                {progress?.percent == null
                  ? "No percentage reported yet"
                  : `${Math.round(progress.percent)}% · ${progress.label}`}
              </span>
              {sinceEvent !== null ? (
                <span data-testid="render-progress-heartbeat">
                  Last update · {sinceEvent} ago
                </span>
              ) : (
                <span data-testid="render-progress-heartbeat">Waiting for worker progress</span>
              )}
              {error !== null ? <span {...stylex.props(styles.danger)}>Status read failed · retrying</span> : null}
            </p>

            <ol {...stylex.props(styles.gridGap0)} data-testid="render-progress-stages">
              {stages.map((stage) => (
                <li
                  {...stylex.props(
                    styles.flexBaselineXs,
                    stage.state === "done"
                      ? styles.stageDone
                      : stage.state === "active"
                        ? styles.stageActive
                        : styles.stageTodo,
                  )}
                  data-stage={stage.kind}
                  data-stage-state={stage.state}
                  key={stage.kind}
                >
                  <span aria-hidden="true" {...stylex.props(styles.tight)}>
                    {stage.state === "done" ? (
                      <Check className={stylex.props(styles.accent).className} />
                    ) : stage.state === "active" ? (
                      <CloudActivityIndicator iconXstyle={styles.size3Icon} />
                    ) : (
                      <CircleDashed className={stylex.props(styles.size3TextMutedForeground60).className} />
                    )}
                  </span>
                  <span {...stylex.props(styles.fillMediumNarrowable)}>
                    {stage.label}
                    <span {...stylex.props(styles.microMuted)}>{stage.hint}</span>
                  </span>
                  <span {...stylex.props(styles.tightMonoMicro)}>
                    {stage.at ? formatTimestamp(stage.at) : ""}
                  </span>
                </li>
              ))}
            </ol>

            {retryLabel ? (
              <p
                {...stylex.props(styles.flexCenterXs)}
                data-testid="render-progress-retry"
              >
                <CloudActivityIndicator iconXstyle={styles.size35} />
                <span>{retryLabel}</span>
              </p>
            ) : null}

            {failure !== null ? (
              <p
                {...stylex.props(styles.flexStartXs)}
                data-testid="render-progress-failure"
              >
                <TriangleAlert aria-hidden="true" className={stylex.props(styles.tight2).className} />
                <span>
                  {failure}
                  <span {...stylex.props(styles.monoMicro)}>({detail.failureCode})</span>
                </span>
              </p>
            ) : null}

            <dl {...stylex.props(styles.gridMicro)} data-testid="render-progress-facts">
              <Fact label="Attempt" value={`${detail.attemptCount} of ${detail.maxAttempts}`} />
              <Fact
                label="Worker"
                value={attempt ? `${attempt.workerClass} · ${attempt.workerNodeId}` : "Not claimed yet"}
              />
              <Fact label="Queued" value={formatTimestamp(detail.createdAt)} />
              <Fact label="Started" value={detail.startedAt ? formatTimestamp(detail.startedAt) : "Not yet"} />
              <Fact label="Runtime" value={attempt?.runtimeVersion ?? (attempt ? "local process" : "—")} />
              <Fact label="Controls" value={shortDigest(detail.executionPackageControlSha256)} />
              <Fact label="Engine" value={detail.rendererEngine ?? "—"} />
              {detail.render ? <Fact label="Preset" value={renderPresetFact(detail.render)} /> : null}
              <Fact label="Intent" value={detail.intentSha256 ? shortDigest(detail.intentSha256) : "—"} />
              <Fact
                label="Base image"
                value={attempt?.baseImageDigest ? shortDigest(attempt.baseImageDigest.replace(/^sha256:/, "")) : "—"}
              />
              <Fact
                label="linux/amd64"
                value={attempt?.baseImagePlatformDigest
                  ? shortDigest(attempt.baseImagePlatformDigest.replace(/^sha256:/, ""))
                  : "—"}
              />
            </dl>

            <div>
              <h3 {...stylex.props([typography.eyebrow, styles.capsMicroMuted])}>
                Artifacts
                <span {...stylex.props(styles.normalCase)}>
                  {detail.artifacts.length === 0
                    ? live ? "none yet" : "none"
                    : `${detail.artifacts.length} so far`}
                </span>
              </h3>
              {detail.artifacts.length === 0 ? (
                <p {...stylex.props(styles.microMuted2)}>
                  {live
                    ? "Output appears here as the worker uploads it."
                    : "This render produced no artifacts."}
                </p>
              ) : (
                <ul {...stylex.props(styles.gridGap05)} data-testid="render-progress-artifacts">
                  {detail.artifacts.map((artifact) => (
                    <li
                      {...stylex.props(styles.flexBetweenBaseline)}
                      key={artifact.id}
                    >
                      <span {...stylex.props([textLayout.truncate, styles.inkMediumTruncate])} title={artifactDisplayName(artifact)}>
                        {artifactDisplayName(artifact)}
                      </span>
                      <span {...stylex.props(styles.tightMonoMicro)}>
                        {formatBytes(artifact.byteLength)} · {artifact.artifactState}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        ) : loading ? (
          <p {...stylex.props(styles.flexCenterXs2)}>
            <CloudActivityIndicator />
            Reading this render&apos;s status…
          </p>
        ) : null}
      </div>
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div {...stylex.props(styles.flexBetweenBaseline2)}>
      <dt {...stylex.props(styles.tightCapsMuted)}>{label}</dt>
      <dd {...stylex.props([textLayout.truncate, styles.monoInkTruncate])}>{value}</dd>
    </div>
  );
}

/** The native preset a job recorded, with its overrides; a job from before presets were recorded says so. */
function renderPresetFact(render: NonNullable<ScenarioRenderJobDetailDto["render"]>): string {
  const overrides = Object.keys(render.set).length;
  const preset = render.preset === null ? "Not recorded" : render.preset === "training" ? "Training" : "Showcase";
  return overrides > 0 ? `${preset} · ${overrides} override${overrides === 1 ? "" : "s"}` : preset;
}
