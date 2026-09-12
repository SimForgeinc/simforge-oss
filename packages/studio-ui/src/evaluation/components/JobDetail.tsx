"use client";

/**
 * One run's result, in both hosts.
 *
 * What this screen refuses to do is as important as what it shows:
 * - A prediction with no reference future is labelled unscored; it never shows
 *   a zero error.
 * - `partial` and `failed` runs show their retained evidence, its retention
 *   deadline, and the fact that it is not a scored result.
 * - Metrics are always printed with their horizon, sample count, reference kind
 *   and coordinate convention, because ADE without those is not a number
 *   anybody can compare.
 * - An `authored` or `reference-policy` reference is never called ground truth.
 */
import { AlertTriangle, Ban, Download, Loader2 } from "lucide-react";
import * as stylex from "@stylexjs/stylex";
import { cn } from "../../lib/utils";
import { styles as s } from "./evaluation-components.stylex";
import { Badge } from "../../components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import type { HorizonMetrics, OpenLoopItem, TrajectoryProjection, UploadedVideoProvenance } from "../contracts";
import { horizonMetrics, overlayProjection, readUploadedVideoProvenance } from "../contracts";
import type { EvaluationGateway } from "../gateway";
import { formatBytes, formatCents, formatSeconds, jobStatusPresentation } from "../presentation";
import { useJobResult } from "../useJobResult";
import { FrameOverlay } from "./FrameOverlay";
import { JobStatusBadge } from "./JobHistory";
import { RefusalNotice } from "./RefusalNotice";
import { TrajectoryPlot } from "./TrajectoryPlot";

const RECORDED_HUMAN_REFERENCE_KINDS = ["dataset", "recorded-replay"];

const REFUSAL_TITLES: Record<string, string> = {
  missing_fields: "Refused: required driving inputs are missing",
  camera_set_invalid: "Refused: camera set does not match the model",
  calibration_invalid: "Refused: calibration is unusable",
  reference_missing: "Refused: no reference future to score against",
  unsupported_op: "Refused: this model cannot perform that operation",
  input_error: "Refused: the input could not be read",
};

function HorizonTable({ label, metrics }: { label: string; metrics: HorizonMetrics }) {
  // Whatever horizons the producer actually wrote, in ascending order — a
  // horizon this build predates is shown rather than dropped.
  const horizons = Object.entries(metrics)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number")
    .sort((left, right) => Number(left[0]) - Number(right[0]));
  if (horizons.length === 0) return null;
  return (
    <div>
      <p {...stylex.props(s.textXs, s.uppercaseWide, s.textMuted)}>{label}</p>
      <dl {...stylex.props(s.stack1)} style={{ marginTop: "0.25rem", display: "flex", flexWrap: "wrap", columnGap: "1.5rem", rowGap: "0.25rem" }}>
        {horizons.map(([horizon, metric]) => (
          <div key={horizon} {...stylex.props(s.textSm)}>
            <dt {...stylex.props(s.textXs, s.textMuted)}>{horizon}s</dt>
            <dd {...stylex.props(s.tabular, s.textFg)}>{metric.toFixed(3)} m</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** Provenance values are free-form; render them readably without asserting a shape. */
function formatProvenanceValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (Array.isArray(value)) return value.length > 0 ? value.map(String).join(", ") : "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Name the field that marks this run's runtime as unqualified, or null.
 *
 * A run executed on an unpinned interpreter is deliberately stamped by the
 * producer so its numbers cannot become a published envelope. Surfacing that
 * stamp is the whole point of it existing: an unqualified measurement shown
 * without its caveat is how a pending quantization gets quietly promoted.
 */
function unqualifiedRuntimeStamp(runtime: Record<string, unknown> | null): string | null {
  if (!runtime) return null;
  for (const [field, value] of Object.entries(runtime)) {
    if (typeof value !== "string") continue;
    const lowered = value.toLowerCase();
    if (lowered === "pending" || lowered === "unqualified" || lowered === "qualification-pending") {
      return `${field}: ${value}`;
    }
  }
  return null;
}

function ItemCard({
  item,
  videoUrl,
  frameUrls,
  projection,
  uploadedVideo,
}: {
  item: OpenLoopItem;
  videoUrl: string | null;
  frameUrls: string[];
  projection: TrajectoryProjection | null;
  uploadedVideo: boolean;
}) {
  const referenceKind = item.reference.kind;
  const recordedHuman = RECORDED_HUMAN_REFERENCE_KINDS.includes(referenceKind);
  const minADE = uploadedVideo ? null : horizonMetrics(item.metrics, "minADE_k");
  const minFDE = uploadedVideo ? null : horizonMetrics(item.metrics, "minFDE_k");
  const reasoning = item.reasoning.filter((entry): entry is string => Boolean(entry));
  const predictionSeconds =
    item.input.t0Us === null || item.input.t0Us === undefined ? null : item.input.t0Us / 1_000_000;

  return (
    <Card data-testid={`result-item-${item.itemId}`}>
      <CardHeader>
        <CardTitle {...stylex.props(s.cardTitle)}>
          <span {...stylex.props(s.mono)}>{uploadedVideo && predictionSeconds !== null
            ? `Prediction at ${predictionSeconds.toFixed(3)} s`
            : item.itemId}</span>
          {item.status === "ok" ? null : (
            <Badge variant="outline" {...stylex.props(s.borderAmber)}>
              {item.status}
            </Badge>
          )}
          {item.latencyMs !== null && item.latencyMs !== undefined ? (
            <span {...stylex.props(s.textXs, s.textNormal, s.textMuted)}>
              {Math.round(item.latencyMs)} ms inference
            </span>
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent {...stylex.props(s.space4)}>
        {item.status === "refused" && item.refusal ? (
          <RefusalNotice
            title={REFUSAL_TITLES[item.refusal.code ?? ""] ?? "Refused"}
            reasons={item.refusal.message ? [item.refusal.message] : []}
            missingFieldPaths={item.refusal.missingFields}
          />
        ) : null}
        {item.status === "error" && item.error ? (
          <RefusalNotice
            title="This item failed"
            reasons={[item.error.message ?? item.error.code ?? "No detail was recorded."]}
          />
        ) : null}

        {item.text ? (
          <div {...stylex.props(s.space1)}>
            <p {...stylex.props(s.textXs, s.uppercaseWide, s.textMuted)}>Model answer</p>
            <p {...stylex.props(s.whitespace, s.textSm, s.leading6, s.textFg)}>{item.text}</p>
            <p {...stylex.props(s.textXs, s.textMuted)}>
              Text analysis, not a trajectory evaluation. No ADE/FDE is produced from it.
            </p>
          </div>
        ) : null}

        {item.status === "ok" && item.points.length > 0 ? (
          <div {...stylex.props(uploadedVideo ? s.max3xl : s.resultsGrid)}>
            <TrajectoryPlot item={item} />
            {!uploadedVideo && projection && (videoUrl || frameUrls.length > 0) ? (
              <FrameOverlay
                item={item}
                projection={projection}
                source={
                  frameUrls.length > 0
                    ? { kind: "frames", urls: frameUrls, timestampsUs: [] }
                    : { kind: "video", url: videoUrl as string }
                }
              />
            ) : !uploadedVideo && (videoUrl || frameUrls.length > 0) ? (
              <div {...stylex.props(s.space3)}>
                <video src={videoUrl ?? frameUrls[0]} controls playsInline {...stylex.props(s.video)} />
                <p {...stylex.props(s.textXs, s.leading5, s.textMuted)}>
                  No image-space overlay: this input carried no camera calibration, so drawing the
                  path on the frames would assert a correspondence that was never measured. The
                  metric plot beside it is the real result.
                </p>
              </div>
            ) : null}
          </div>
        ) : null}

        {minADE || minFDE ? (
          <div {...stylex.props(s.flexGap8)}>
            {minADE ? <HorizonTable label={`minADE (k=${item.points.length})`} metrics={minADE} /> : null}
            {minFDE ? <HorizonTable label={`minFDE (k=${item.points.length})`} metrics={minFDE} /> : null}
          </div>
        ) : null}

        <p {...stylex.props(s.textXs, s.leading5, s.textMuted)}>
          {uploadedVideo
            ? `Unscored exploratory prediction${item.convention ? ` · ${item.convention} frame` : ""}${item.dtS ? ` · ${item.dtS}s trajectory step` : ""}${item.horizonS ? ` · ${item.horizonS}s horizon` : ""}.`
            : `Reference: ${referenceKind}${
                referenceKind === "none"
                  ? " — prediction only, not scored."
                  : recordedHuman
                    ? " — a recorded future."
                    : " — a generated reference, not human ground truth."
              }${item.convention ? ` · ${item.convention} frame` : ""}${item.dtS ? ` · ${item.dtS}s step` : ""}${item.horizonS ? ` · ${item.horizonS}s horizon` : ""}`}
        </p>

        {reasoning.length > 0 ? (
          <div {...stylex.props(s.spaceY2, s.textSm)}>
            <p {...stylex.props(s.textXs, s.uppercaseWide, s.textMuted)}>
              Model reasoning
              {predictionSeconds !== null ? ` at ${predictionSeconds.toFixed(3)} s` : ""}
            </p>
            <ol {...stylex.props(s.space2)}>
              {reasoning.map((entry, index) => (
                <li key={index} {...stylex.props(s.whitespace, s.leading6, s.textFg)}>
                  {reasoning.length > 1 ? (
                    <span {...stylex.props(s.mr2, s.textXs, s.textMuted)}>Sample {index + 1}</span>
                  ) : null}
                  {entry}
                </li>
              ))}
            </ol>
          </div>
        ) : item.status === "ok" && uploadedVideo ? (
          <p {...stylex.props(s.textXs, s.textMuted)}>The model returned no reasoning text at this timestamp.</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function UploadedVideoResult({
  overlayVideoUrl,
  provenance,
}: {
  overlayVideoUrl: string | null;
  provenance: UploadedVideoProvenance;
}) {
  const assumptions = provenance.assumptions;
  return (
    <section {...stylex.props(s.space4)} data-testid="uploaded-video-result">
      <div {...stylex.props(s.flexCenterBetween)}>
        <div>
          <h2 {...stylex.props(s.textSm, s.fontSemibold, s.textFg)}>Prediction and reasoning overlay</h2>
          <p {...stylex.props(s.mt1, s.textXs, s.leading5, s.textMuted)}>
            The rendered trajectory changes only at the model inference timestamps shown below.
          </p>
        </div>
        {overlayVideoUrl ? (
          <a
            href={overlayVideoUrl}
            download="prediction-overlay.mp4"
            {...stylex.props(s.downloadLink)}
          >
            <Download aria-hidden="true" {...stylex.props(s.icon)} />
            Download overlay video
          </a>
        ) : null}
      </div>
      {overlayVideoUrl ? (
        <video
          src={overlayVideoUrl}
          controls
          playsInline
          preload="metadata"
          {...stylex.props(s.videoWide)}
          aria-label="Predicted trajectory and model reasoning overlay"
        />
      ) : (
        <RefusalNotice
          tone="warn"
          title="The overlay video is unavailable"
          reasons={[
            "The prediction document is retained below, but this run did not store a playable overlay-video artifact.",
          ]}
        />
      )}
      <div {...stylex.props(s.borderMutedP4)}>
        <p {...stylex.props(s.textXs, s.fontSemibold, s.uppercaseWide, s.textMuted)}>
          Approximate input assumptions
        </p>
        <p {...stylex.props(s.mt2, s.textSm, s.leading6, s.textFg)}>
          Pinhole camera · {assumptions.horizontalFovDeg}° horizontal FOV ·{" "}
          {assumptions.cameraHeightM} m camera height · constant-speed straight ego history at{" "}
          {assumptions.egoSpeedMps} m/s. Camera starts were{" "}
          {assumptions.synchronizedStarts ? "declared synchronized" : "aligned with the offsets below"}.
        </p>
        <p {...stylex.props(s.mt1, s.textXs, s.leading5, s.textMuted)}>
          These are declared approximations, not measured calibration or vehicle telemetry. This
          exploratory output is unscored and has no reference trajectory.
        </p>
      </div>
      <details {...stylex.props(s.details)}>
        <summary {...stylex.props(s.summary)}>
          Source cameras and inference timestamps
        </summary>
        <div {...stylex.props(s.detailsBody)}>
          <ul {...stylex.props(s.listMuted)}>
            {provenance.sources.map((source) => (
              <li key={source.inputIndex}>
                Input {source.inputIndex + 1} → camera {source.cameraId} · {source.width}×
                {source.height} · {source.durationSeconds.toFixed(3)} s · offset{" "}
                {source.offsetSeconds.toFixed(3)} s
              </li>
            ))}
          </ul>
          <div>
            <p {...stylex.props(s.uppercaseWide, s.textMuted)}>
              Inference timestamps ({provenance.inferenceTimestampsUs.length})
            </p>
            <p {...stylex.props(s.mt1, s.mono, s.leading5, s.textFg)}>
              {provenance.inferenceTimestampsUs
                .map((timestampUs) => `${(timestampUs / 1_000_000).toFixed(3)}s`)
                .join(", ") || "none"}
            </p>
          </div>
        </div>
      </details>
    </section>
  );
}

export function JobDetail({
  gateway,
  jobId,
  className,
}: {
  gateway: EvaluationGateway;
  jobId: string;
  className?: string;
}) {
  const {
    job,
    manifest,
    openLoop,
    trajectories,
    videoUrl,
    overlayVideoUrl,
    frameUrls,
    loading,
    problems,
  } = useJobResult(gateway, jobId);

  if (loading && !job) {
    return (
      <p className={cn(stylex.props(s.inlineFlex, s.rowTight, s.textSm, s.textMuted).className, className)} style={stylex.props(s.inlineFlex, s.rowTight, s.textSm, s.textMuted).style}>
        <Loader2 aria-hidden="true" {...stylex.props(s.icon, s.spinner)} />
        Loading run…
      </p>
    );
  }

  if (!job) {
    return (
      <RefusalNotice
        className={className}
        title="This run is not available"
        reasons={[
          "It does not exist, or it belongs to a workspace you are not a member of. Access is checked on every request.",
        ]}
      />
    );
  }

  const presentation = jobStatusPresentation(job.status);
  const aggregate = openLoop?.aggregate;
  const provenanceModel = manifest?.provenance.model ?? null;
  const provenanceInput = manifest?.provenance.input ?? null;
  // The runtime block is where an unpinned-interpreter run is stamped, so it is
  // rendered rather than hidden behind the model fields.
  const runtimeEntries = manifest?.provenance.runtime ?? null;
  const provenanceRuntime =
    runtimeEntries && Object.keys(runtimeEntries).length > 0 ? runtimeEntries : null;
  const unqualifiedRuntime = unqualifiedRuntimeStamp(provenanceRuntime);
  const videoProvenanceCandidate = openLoop?.provenance.video;
  const videoProvenanceRead = readUploadedVideoProvenance(videoProvenanceCandidate);
  const uploadedVideoProvenance = videoProvenanceRead.ok ? videoProvenanceRead.value : null;
  const uploadedVideo = videoProvenanceCandidate !== undefined || overlayVideoUrl !== null;

  return (
    <div className={cn(stylex.props(s.section6).className, className)} data-testid="job-detail">
      <header {...stylex.props(s.space3)}>
        <div {...stylex.props(s.flexCenterGap3)}>
          <JobStatusBadge job={job} />
          <span {...stylex.props(s.mono, s.textXs, s.textMuted)}>{job.id}</span>
          <Badge variant="outline">{job.origin}</Badge>
          {manifest?.mode ? <Badge variant="outline">{manifest.mode}</Badge> : null}
          {job.scored === false || manifest?.scored === false ? (
            <Badge variant="outline">not scored</Badge>
          ) : null}
        </div>
        {presentation.detail ? (
          <p {...stylex.props(s.max2xl, s.textSm, s.leading6, s.textMuted)}>{presentation.detail}</p>
        ) : null}
        <dl {...stylex.props(s.gridMeta)}>
          <div>
            <dt {...stylex.props(s.textXs, s.uppercaseWide, s.textMuted)}>Model</dt>
            <dd {...stylex.props(s.textFg)}>
              {job.model.family} · {job.model.quant}
            </dd>
          </div>
          <div>
            <dt {...stylex.props(s.textXs, s.uppercaseWide, s.textMuted)}>Submitted by</dt>
            <dd {...stylex.props(s.textFg)}>{job.submittedByEmail ?? job.submittedByUserId}</dd>
          </div>
          <div>
            <dt {...stylex.props(s.textXs, s.uppercaseWide, s.textMuted)}>Queued / ran</dt>
            <dd {...stylex.props(s.textFg)}>
              {formatSeconds(job.queuedSeconds)} / {formatSeconds(
                job.startedAt && job.finishedAt
                  ? (Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 1000
                  : null,
              )}
            </dd>
          </div>
          <div>
            <dt {...stylex.props(s.textXs, s.uppercaseWide, s.textMuted)}>Cost</dt>
            <dd {...stylex.props(s.textFg)}>
              {job.settledCents !== null
                ? `${formatCents(job.settledCents)} settled`
                : `${formatCents(job.reservedCents)} reserved`}
            </dd>
          </div>
        </dl>
      </header>

      {problems.length > 0 ? (
        <RefusalNotice tone="warn" title="Some parts of this result could not be read" reasons={problems} />
      ) : null}

      {job.status === "partial" ? (
        <RefusalNotice
          tone="warn"
          title="Partial run — retained evidence, not a result"
          reasons={[
            "This run did not complete. What is shown below is retained evidence for diagnosis and is not scored or comparable.",
            job.result?.evidenceRetainedUntil
              ? `The evidence is retained until ${new Date(job.result.evidenceRetainedUntil).toLocaleString()}.`
              : "The evidence is retained under the workspace's retention policy.",
          ]}
        />
      ) : null}

      {manifest?.truncation ? (
        <RefusalNotice
          tone="warn"
          title={
            manifest.truncation === "envelope_exceeded"
              ? "Truncated: the run left the input's validity envelope"
              : "Truncated: the run hit its deadline budget"
          }
          reasons={[
            "Results are reported up to the truncation point. A truncated run is not a successful model result and is not promotable.",
          ]}
        />
      ) : null}

      {job.error ? (
        <RefusalNotice
          title="This run failed"
          reasons={[
            job.error.message,
            job.error.retryable
              ? "The failure is retryable: submitting again is safe and will not double-charge, because settlement is idempotent."
              : "The failure is not retryable as submitted; change the input or configuration.",
          ]}
        />
      ) : null}

      {uploadedVideoProvenance ? (
        <UploadedVideoResult
          overlayVideoUrl={overlayVideoUrl}
          provenance={uploadedVideoProvenance}
        />
      ) : null}
      {overlayVideoUrl && !uploadedVideoProvenance ? (
        <section {...stylex.props(s.space3)}>
          <div {...stylex.props(s.flexCenterBetween)}>
            <h2 {...stylex.props(s.textSm, s.fontSemibold, s.textFg)}>
              Prediction and reasoning overlay
            </h2>
            <a
              href={overlayVideoUrl}
              download="prediction-overlay.mp4"
              {...stylex.props(s.downloadLink)}
            >
              <Download aria-hidden="true" {...stylex.props(s.icon)} />
              Download overlay video
            </a>
          </div>
          <video
            src={overlayVideoUrl}
            controls
            playsInline
            preload="metadata"
            {...stylex.props(s.videoWide)}
            aria-label="Predicted trajectory and model reasoning overlay"
          />
          <RefusalNotice
            tone="warn"
            title="Video assumptions could not be read"
            reasons={[videoProvenanceRead.ok ? "" : videoProvenanceRead.reason]}
          />
        </section>
      ) : null}


      {aggregate && !uploadedVideo ? (
        <section {...stylex.props(s.space3)}>
          <h2 {...stylex.props(s.textSm, s.fontSemibold, s.textFg)}>Aggregate</h2>
          <div {...stylex.props(s.flexGap8)}>
            {Object.keys(aggregate.minADE).length > 0 ? (
              <HorizonTable label="minADE" metrics={aggregate.minADE} />
            ) : null}
            {Object.keys(aggregate.minFDE).length > 0 ? (
              <HorizonTable label="minFDE" metrics={aggregate.minFDE} />
            ) : null}
            <div>
              <p {...stylex.props(s.textXs, s.uppercaseWide, s.textMuted)}>Items</p>
              <p {...stylex.props(s.mt1, s.textSm, s.textFg)}>
                {aggregate.okItems} of {aggregate.itemCount} returned a prediction
                {aggregate.refusedItems > 0 ? ` · ${aggregate.refusedItems} refused` : ""}
                {aggregate.failedItems > 0 ? ` · ${aggregate.failedItems} failed` : ""}
              </p>
              {Object.keys(aggregate.scoredItems).length > 0 ? (
                <p {...stylex.props(s.mt1, s.textXs, s.textMuted)}>
                  scored per horizon:{" "}
                  {Object.entries(aggregate.scoredItems)
                    .map(([horizon, count]) => `${horizon}s: ${count}`)
                    .join(", ")}
                </p>
              ) : null}
            </div>
          </div>
          {aggregate.refusedItems > 0 ? (
            <p {...stylex.props(s.flexStartGap2, s.textXs, s.leading5, s.textMuted)}>
              <AlertTriangle aria-hidden="true" {...stylex.props(s.mt1, s.iconSm)} />
              Refused items are excluded from the aggregate. They are listed below with the fields
              they were missing; nothing was substituted for them.
            </p>
          ) : null}
        </section>
      ) : null}

      {provenanceModel || provenanceInput || provenanceRuntime ? (
        <section {...stylex.props(s.space3)}>
          <h2 {...stylex.props(s.textSm, s.fontSemibold, s.textFg)}>Provenance</h2>
          {unqualifiedRuntime ? (
            <RefusalNotice
              tone="warn"
              title="This run was produced on an unqualified runtime"
              reasons={[
                `The runtime stamped ${unqualifiedRuntime}. Numbers from an unqualified runtime are signal, not a published envelope: they cannot promote a quantization from pending to supported, and they are not comparable with results measured on the pinned release runtime.`,
              ]}
            />
          ) : null}
          <dl {...stylex.props(s.gridMeta3)}>
            {provenanceModel
              ? Object.entries(provenanceModel).map(([field, value]) => (
                  <div key={field}>
                    <dt {...stylex.props(s.uppercaseWide, s.textMuted)}>{field}</dt>
                    <dd {...stylex.props(s.min0, s.truncate, s.mono, s.textFg)}>
                      {formatProvenanceValue(value)}
                    </dd>
                  </div>
                ))
              : null}
            {provenanceInput
              ? Object.entries(provenanceInput).map(([field, value]) => (
                  <div key={`input-${field}`}>
                    <dt {...stylex.props(s.uppercaseWide, s.textMuted)}>input.{field}</dt>
                    <dd {...stylex.props(s.min0, s.truncate, s.mono, s.textFg)}>
                      {formatProvenanceValue(value)}
                    </dd>
                  </div>
                ))
              : null}
            {provenanceRuntime
              ? Object.entries(provenanceRuntime).map(([field, value]) => (
                  <div key={`runtime-${field}`}>
                    <dt {...stylex.props(s.uppercaseWide, s.textMuted)}>runtime.{field}</dt>
                    <dd {...stylex.props(s.min0, s.truncate, s.mono, s.textFg)}>
                      {formatProvenanceValue(value)}
                    </dd>
                  </div>
                ))
              : null}
          </dl>
          <p {...stylex.props(s.textXs, s.leading5, s.textMuted)}>
            Same seed alone is not proof of reproducibility across GPUs: the model revision,
            checkpoint digest, quantization, runtime and RNG provenance above are what pin this
            result.
            {provenanceModel?.determinismScope
              ? ` The producer records its determinism scope as ${provenanceModel.determinismScope}.`
              : ""}
          </p>
        </section>
      ) : null}

      {openLoop ? (
        <section {...stylex.props(s.space4)}>
          <h2 {...stylex.props(s.textSm, s.fontSemibold, s.textFg)}>
            {uploadedVideo ? "Timestamped predictions" : "Items"} ({openLoop.items.length})
          </h2>
          <div {...stylex.props(s.space4)}>
            {openLoop.items.map((item) => (
              <ItemCard
                key={item.itemId}
                item={item}
                videoUrl={videoUrl}
                frameUrls={frameUrls}
                projection={overlayProjection(item, trajectories)}
                uploadedVideo={uploadedVideo}
              />
            ))}
          </div>
        </section>
      ) : presentation.live ? (
        <p {...stylex.props(s.inlineFlex, s.rowTight, s.textSm, s.textMuted)}>
          <Loader2 aria-hidden="true" {...stylex.props(s.icon, s.spinner)} />
          Results appear here when the run finishes. Closing this page does not stop it.
        </p>
      ) : job.status === "cancelled" ? (
        <p {...stylex.props(s.inlineFlex, s.rowTight, s.textSm, s.textMuted)}>
          <Ban aria-hidden="true" {...stylex.props(s.icon)} />
          This run was cancelled. Cost settles from the provider&apos;s actual accounting, so a
          cancelled run is not automatically free.
        </p>
      ) : null}

      {job.result && job.result.artifacts.length > 0 ? (
        <section {...stylex.props(s.space2)}>
          <h2 {...stylex.props(s.textSm, s.fontSemibold, s.textFg)}>Stored artifacts</h2>
          <ul {...stylex.props(s.artifactList)}>
            {job.result.artifacts.map((artifact) => (
              <li key={artifact.artifactId} {...stylex.props(s.artifactItem)}>
                <span {...stylex.props(s.artifactRole)}>{artifact.role}</span>
                <span {...stylex.props(s.artifactHash)}>
                  {artifact.sha256.slice(0, 16)}
                </span>
                <span {...stylex.props(s.artifactSize)}>
                  {formatBytes(artifact.bytes)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
