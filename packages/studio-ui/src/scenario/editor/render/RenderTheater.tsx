"use client";

import { useStudioHost } from "../../../host";
import type { PresignedArtifact } from "@simforge-oss/studio-host";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Camera, CircleStop, EyeOff } from "lucide-react";
import { CloudActivityIndicator } from "../../../components/CloudLoadingSurface";
import { useVisiblePolling } from "../../../lib/use-visible-polling";
import { WorkspacePaneLoading } from "../../../components/WorkspacePaneLoading";
import { RenderArtifactList } from "./RenderArtifactList";
import { RenderParityEvidencePanel } from "./RenderParityEvidence";
import { PostprocessPanel } from "./PostprocessPanel";
import { RenderStateChip } from "./RenderStatePieces";
import { VideoPreviewModal } from "./VideoPreviewModal";
import {
  formatCostCents,
  formatElapsed,
  formatTimestamp,
  humanizeCode,
  isPlayableVideo,
  isPostprocessMode,
  jobFailureMessage,
  renderJobLabel,
  renderStateVisual,
  shortDigest,
} from "./render-view-model";
import type { ScenarioRenderJobDetailDto } from "@simforge-oss/studio-host";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./RenderTheater.stylex";
import { motionStyles } from "../../../stylex/motion.stylex";

/**
 * The detail sections beside the player.
 *
 * "Videos" is gone as a tab: the video is the view now, playing at full width, and a tab that
 * swapped it out for a file table was the old dialog's compromise for having no room.
 */
const RAIL_TABS = ["files", "behavior", "log", "config"] as const;
type RailTab = (typeof RAIL_TABS)[number];
const RAIL_TAB_LABELS: Record<RailTab, string> = {
  files: "Files",
  behavior: "Behavior",
  log: "Log",
  config: "Config",
};

const POLL_INTERVAL_MS = 5000;

/**
 * One render, filling the render pane.
 *
 * This replaces a centred dialog. A render is a video, and a video wants width — the dialog capped it
 * at 5xl over a dimmed backdrop, on a surface that was itself a panel over the scene, so the author
 * ended up looking at a small picture inside three frames. Here the scenario list slides away, the
 * player takes the freed width, and the run's files, behaviour evidence, log and configuration sit in
 * a rail beside it instead of behind tabs that hid the video.
 *
 * Going back is `onBack`, not a close: the gallery it returns to is the same surface, one level up.
 */
export function RenderTheater({
  jobId,
  onBack,
  onHiddenChange,
}: {
  jobId: string;
  /** Returns to the gallery. */
  onBack: () => void;
  onHiddenChange: () => void;
}) {
  const studioHost = useStudioHost();
  const [tab, setTab] = useState<RailTab>("files");
  const [detail, setDetail] = useState<ScenarioRenderJobDetailDto | null>(null);
  const [downloads, setDownloads] = useState<PresignedArtifact[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [preview, setPreview] = useState<PresignedArtifact | null>(null);
  const [heroArtifactId, setHeroArtifactId] = useState<string | null>(null);

  const live = detail ? renderStateVisual(detail.jobState).live : true;

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const next = await studioHost.jobs.getRenderJobDetail(jobId, signal);
        if (signal?.aborted) return;
        setDetail(next);
        setError(null);
        if (next.artifacts.length > 0) {
          // Signing is per request and scoped to this job; refreshing alongside the detail poll keeps
          // the video sources valid while the view stays open.
          const items = await studioHost.jobs.listDownloads(jobId, signal);
          if (!signal?.aborted) setDownloads(items);
        }
      } catch (cause) {
        if (signal?.aborted) return;
        setError(cause instanceof Error ? humanizeCode(cause.message) : "render_detail_failed");
      }
    },
    [jobId, studioHost],
  );

  useEffect(() => {
    setDetail(null);
    setDownloads([]);
    setTab("files");
    setHeroArtifactId(null);
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const poll = useCallback(() => load(), [load]);
  useVisiblePolling(poll, POLL_INTERVAL_MS, live);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onBack();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onBack]);

  const videos = useMemo(() => downloads.filter(isPlayableVideo), [downloads]);
  /**
   * The video on the big player.
   *
   * Falls back to the first video rather than pinning an id on load: the poll re-signs the artifacts
   * while a render is still producing them, and the author's pick has to survive that.
   */
  const hero = useMemo(
    () => videos.find((artifact) => artifact.id === heroArtifactId) ?? videos[0] ?? null,
    [heroArtifactId, videos],
  );
  const failure = detail ? jobFailureMessage(detail) : null;
  const cancellable = detail ? renderStateVisual(detail.jobState).live : false;
  const latestAttempt = detail?.attempts.at(-1) ?? null;

  async function cancel() {
    if (!window.confirm("Cancel this render?")) return;
    setActionBusy(true);
    try {
      await studioHost.jobs.cancelRenderJob(jobId);
      await load();
      onHiddenChange();
    } catch {
      setError("The render could not be cancelled.");
    } finally {
      setActionBusy(false);
    }
  }

  async function hide() {
    setActionBusy(true);
    try {
      await studioHost.jobs.setRenderJobHidden(jobId, true);
      onHiddenChange();
      onBack();
    } catch {
      setError("The render could not be hidden.");
    } finally {
      setActionBusy(false);
    }
  }

  return (
    <section
      aria-label="Render run details"
      className={`${stylex.props(styles.flexColFill).className} render-view-enter`}
      data-testid="scenario-render-theater"
      data-render-job-id={jobId}
    >
      <header {...stylex.props(styles.flexColTight)}>
        <div {...stylex.props(styles.flexCenterGap3)}>
          <button
            aria-label="Back to the render gallery"
            className={stylex.props(styles.gridCenteredTight, motionStyles.editorMotion).className}
            data-testid="scenario-render-theater-back"
            onClick={onBack}
            type="button"
          >
            <ArrowLeft aria-hidden="true" className={stylex.props(styles.size4).className} />
          </button>
          <div {...stylex.props(styles.fillNarrowable)}>
            <h2 {...stylex.props(styles.smInkSemibold)}>
              {detail ? renderJobLabel(detail) : "Render"} ·{" "}
              {formatTimestamp(detail?.createdAt ?? null)}
            </h2>
            <div {...stylex.props(styles.flexCenterWrap)}>
              <span>{formatElapsed(detail?.startedAt ?? null, detail?.completedAt ?? null)}</span>
              <span>{detail ? formatCostCents(detail.estimatedCostCents) : "—"}</span>
              <span {...stylex.props(styles.inlineFlexCenterGap1)}>
                <Camera aria-hidden="true" className={stylex.props(styles.size3).className} />
                {videos.length} {videos.length === 1 ? "video" : "videos"}
              </span>
              {detail && detail.attemptCount > 1 ? <span>attempt {detail.attemptCount}</span> : null}
            </div>
          </div>
          {detail ? <RenderStateChip state={detail.jobState} /> : null}
          {cancellable ? (
            <button
              aria-label="Cancel this render"
              className={stylex.props(styles.inlineFlexCenterTight, motionStyles.editorMotion).className}
              disabled={actionBusy}
              onClick={() => void cancel()}
              type="button"
            >
              {actionBusy ? (
                <CloudActivityIndicator />
              ) : (
                <CircleStop aria-hidden="true" className={stylex.props(styles.size3).className} />
              )}
              Cancel
            </button>
          ) : (
            <button
              aria-label="Hide this render from the gallery"
              className={stylex.props(styles.inlineFlexCenterTight2, motionStyles.editorMotion).className}
              disabled={actionBusy}
              onClick={() => void hide()}
              type="button"
            >
              {actionBusy ? (
                <CloudActivityIndicator />
              ) : (
                <EyeOff aria-hidden="true" className={stylex.props(styles.size3).className} />
              )}
              Hide
            </button>
          )}
        </div>
        {failure ? (
          <p {...stylex.props(styles.xsDanger)} role="alert">
            {failure}
            {detail?.failureDetail ? ` — ${detail.failureDetail}` : ""}
          </p>
        ) : null}
        {error ? (
          <p {...stylex.props(styles.xsDanger)} role="alert">
            {error}
          </p>
        ) : null}
      </header>

      {!detail ? (
        <WorkspacePaneLoading
          xstyle={styles.fillShrinkable}
          hint="Reading the render job, its attempts and its files."
          message="Loading render…"
        />
      ) : (
        <div {...stylex.props(styles.gridFillClip)}>
          <div {...stylex.props(styles.flexColScrollY)}>
            {hero ? (
              <figure {...stylex.props(styles.flexColBordered)} key={hero.id}>
                {/* Render artifacts are served through the local object-store URL. */}
                <video
                  autoPlay
                  {...stylex.props(styles.wideVideoContain)}
                  controls
                  loop
                  muted
                  playsInline
                  preload="metadata"
                  src={hero.url ?? undefined}
                >
                  <track kind="captions" />
                </video>
                <figcaption {...stylex.props(styles.flexBetweenBaseline)}>
                  <span {...stylex.props(styles.xsInkMedium)}>
                    {hero.artifactKind}
                  </span>
                  <span {...stylex.props(styles.tightCapsMicro)}>
                    {hero.mediaType}
                  </span>
                </figcaption>
              </figure>
            ) : (
              <div {...stylex.props(styles.flexColCenter)}>
                <Camera aria-hidden="true" className={stylex.props(styles.size6TextMutedForeground50).className} strokeWidth={1.5} />
                <span>
                  {live ? "Videos will appear here when the render finishes." : "This render has no videos."}
                </span>
              </div>
            )}

            {/* Only worth a strip when there is a choice to make. */}
            {videos.length > 1 ? (
              <div
                aria-label="Videos in this render"
                {...stylex.props(styles.flexWrapTight)}
                role="tablist"
              >
                {videos.map((artifact) => {
                  const active = hero?.id === artifact.id;
                  return (
                    <button
                      aria-selected={active}
                      className={stylex.props(active ? styles.relTightBordered : styles.relTightBordered2, motionStyles.editorMotion).className}
                      key={artifact.id}
                      onClick={() => setHeroArtifactId(artifact.id)}
                      role="tab"
                      type="button"
                    >
                      <video
                        aria-hidden="true"
                        {...stylex.props(styles.wideVideoCover)}
                        muted
                        playsInline
                        preload="metadata"
                        src={artifact.url ?? undefined}
                      >
                        <track kind="captions" />
                      </video>
                      <span {...stylex.props(styles.blockCapsMicro)}>
                        {artifact.artifactKind}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>

          <div {...stylex.props(styles.flexColShrinkable)}>
            <div
              aria-label="Render details sections"
              {...stylex.props(styles.flexCenterTight)}
              role="tablist"
            >
              {RAIL_TABS.map((id) => {
                const active = tab === id;
                return (
                  <button
                    aria-controls="scenario-render-rail-panel"
                    aria-selected={active}
                    id={`scenario-render-rail-tab-${id}`}
                    className={stylex.props(active ? styles.xsInkMedium2 : styles.xsMutedMedium, motionStyles.editorMotion).className}
                    key={id}
                    onClick={() => setTab(id)}
                    role="tab"
                    type="button"
                  >
                    {RAIL_TAB_LABELS[id]}
                  </button>
                );
              })}
            </div>
            <div
              aria-labelledby={`scenario-render-rail-tab-${tab}`}
              {...stylex.props(styles.fillScrollYShrinkable)}
              id="scenario-render-rail-panel"
              role="tabpanel"
            >
              {tab === "files" ? (
                <div {...stylex.props(styles.flexColGap5)}>
                  <RenderArtifactList
                    artifacts={downloads.length > 0 ? downloads : detail.artifacts}
                    emptyMessage="This render has produced no files yet."
                    onPreview={setPreview}
                    signed={downloads.length > 0}
                  />
                  {/* A postprocess job hangs off a succeeded render, so it never offers to postprocess
                      itself. */}
                  {isPostprocessMode(detail.jobMode) ? null : (
                    <PostprocessPanel
                      artifacts={downloads.length > 0 ? downloads : []}
                      parentJobId={detail.id}
                      parentState={detail.jobState}
                    />
                  )}
                </div>
              ) : tab === "behavior" ? (
                <div {...stylex.props(styles.pad3)}>
                  <RenderParityEvidencePanel
                    artifacts={downloads}
                    executionPackageControlSha256={detail.executionPackageControlSha256}
                    executionPackageId={detail.executionPackageId}
                    jobId={detail.id}
                  />
                </div>
              ) : tab === "log" ? (
                <div {...stylex.props(styles.monoMicroPad3)}>
                  {detail.events.length === 0 ? (
                    <div {...stylex.props(styles.flexCenterMid)}>
                      No events recorded yet.
                    </div>
                  ) : (
                    detail.events.map((event) => (
                      <div {...stylex.props(styles.flexGap3)} key={event.eventOrdinal}>
                        <span {...stylex.props(styles.tightMuted)}>
                          {formatTimestamp(event.createdAt)}
                        </span>
                        <span {...stylex.props(styles.breakAll)}>{humanizeCode(event.eventKind)}</span>
                      </div>
                    ))
                  )}
                </div>
              ) : (
                <div {...stylex.props(styles.pad3)}>
                  <dl {...stylex.props(styles.gridXs)}>
                    <ConfigRow label="Mode" value={renderJobLabel(detail)} />
                    <ConfigRow label="Status" value={renderStateVisual(detail.jobState).label} />
                    <ConfigRow label="Created" value={formatTimestamp(detail.createdAt)} />
                    <ConfigRow label="Started" value={formatTimestamp(detail.startedAt)} />
                    <ConfigRow label="Completed" value={formatTimestamp(detail.completedAt)} />
                    <ConfigRow
                      label="Attempts"
                      value={`${detail.attemptCount}/${detail.maxAttempts}`}
                    />
                    <ConfigRow label="Estimated cost" value={formatCostCents(detail.estimatedCostCents)} />
                    <ConfigRow label="Worker" value={latestAttempt?.workerNodeId ?? "—"} />
                    <ConfigRow
                      label="Runtime"
                      value={
                        latestAttempt?.runtimeVersion && latestAttempt.imageDigest
                          ? `${latestAttempt.runtimeVersion} · ${shortDigest(latestAttempt.imageDigest)}`
                          : latestAttempt ? "local process" : "—"
                      }
                    />
                    <ConfigRow label="Revision" value={detail.revisionId} mono />
                    <ConfigRow label="Execution package" value={detail.executionPackageId} mono />
                    <ConfigRow
                      label="Package digest"
                      value={shortDigest(detail.executionPackageControlSha256)}
                      mono
                    />
                    <ConfigRow label="Render spec digest" value={shortDigest(detail.renderSpecSha256)} mono />
                    <ConfigRow label="Job ID" value={detail.id} mono />
                  </dl>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <VideoPreviewModal
        mediaType={preview?.mediaType ?? "video/mp4"}
        onClose={() => setPreview(null)}
        open={preview != null}
        title={preview?.artifactKind ?? "Preview"}
        url={preview?.url ?? null}
      />
    </section>
  );
}

function ConfigRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <>
      <dt {...stylex.props(styles.capsMicroMuted)}>{label}</dt>
      <dd {...stylex.props(mono ? styles.monoMicroInk : styles.inkNarrowableBreakAll)}>
        {value}
      </dd>
    </>
  );
}
