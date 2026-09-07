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

import { AlertTriangle, Ban, Loader2 } from "lucide-react";
import { cn } from "../../lib/utils";
import { Badge } from "../../components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import type { HorizonMetrics, OpenLoopItem, TrajectoryProjection } from "../contracts";
import { horizonMetrics, overlayProjection } from "../contracts";
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
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <dl className="mt-1 flex flex-wrap gap-x-6 gap-y-1">
        {horizons.map(([horizon, metric]) => (
          <div key={horizon} className="text-sm">
            <dt className="text-xs text-muted-foreground">{horizon}s</dt>
            <dd className="tabular-nums text-foreground">{metric.toFixed(3)} m</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function ItemCard({
  item,
  videoUrl,
  frameUrls,
  projection,
}: {
  item: OpenLoopItem;
  videoUrl: string | null;
  frameUrls: string[];
  projection: TrajectoryProjection | null;
}) {
  const referenceKind = item.reference.kind;
  const recordedHuman = RECORDED_HUMAN_REFERENCE_KINDS.includes(referenceKind);
  // `metrics` is a free-form record on the wire: which buckets exist depends on
  // the run, so each is read and shape-checked rather than assumed.
  const minADE = horizonMetrics(item.metrics, "minADE_k");
  const minFDE = horizonMetrics(item.metrics, "minFDE_k");
  // One entry per sampled trajectory; nulls are samples that produced none.
  const reasoning = item.reasoning.filter((entry): entry is string => Boolean(entry));

  return (
    <Card data-testid={`result-item-${item.itemId}`}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-mono">{item.itemId}</span>
          {item.status === "ok" ? null : (
            <Badge variant="outline" className="border-amber-500/50 text-amber-600 dark:text-amber-500">
              {item.status}
            </Badge>
          )}
          {item.latencyMs !== undefined ? (
            <span className="text-xs font-normal text-muted-foreground">
              {Math.round(item.latencyMs)} ms
            </span>
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
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
          <div className="space-y-1">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Model answer</p>
            <p className="whitespace-pre-wrap text-sm leading-6 text-foreground">{item.text}</p>
            <p className="text-xs text-muted-foreground">
              Text analysis, not a trajectory evaluation. No ADE/FDE is produced from it.
            </p>
          </div>
        ) : null}

        {item.status === "ok" && item.points.length > 0 ? (
          <div className="grid gap-6 lg:grid-cols-2">
            <TrajectoryPlot item={item} />
            {projection && (videoUrl || frameUrls.length > 0) ? (
              <FrameOverlay
                item={item}
                projection={projection}
                source={
                  frameUrls.length > 0
                    ? { kind: "frames", urls: frameUrls, timestampsUs: [] }
                    : { kind: "video", url: videoUrl as string }
                }
              />
            ) : videoUrl || frameUrls.length > 0 ? (
              <div className="space-y-3">
                <video src={videoUrl ?? frameUrls[0]} controls playsInline className="w-full bg-black" />
                <p className="text-xs leading-5 text-muted-foreground">
                  No image-space overlay: this input carried no camera calibration, so drawing the
                  path on the frames would assert a correspondence that was never measured. The
                  metric plot beside it is the real result.
                </p>
              </div>
            ) : null}
          </div>
        ) : null}

        {minADE || minFDE ? (
          <div className="flex flex-wrap gap-8">
            {minADE ? (
              <HorizonTable label={`minADE (k=${item.points.length})`} metrics={minADE} />
            ) : null}
            {minFDE ? (
              <HorizonTable label={`minFDE (k=${item.points.length})`} metrics={minFDE} />
            ) : null}
          </div>
        ) : null}

        <p className="text-xs leading-5 text-muted-foreground">
          Reference: {referenceKind}
          {referenceKind === "none"
            ? " — prediction only, not scored."
            : recordedHuman
              ? " — a recorded future."
              : " — a generated reference, not human ground truth."}
          {item.convention ? ` · ${item.convention} frame` : ""}
          {item.dtS ? ` · ${item.dtS}s step` : ""}
          {item.horizonS ? ` · ${item.horizonS}s horizon` : ""}
        </p>

        {reasoning.length > 0 ? (
          <details className="text-sm">
            <summary className="cursor-pointer text-xs uppercase tracking-wide text-muted-foreground">
              Model reasoning ({reasoning.length === 1 ? "1 sample" : `${reasoning.length} samples`})
            </summary>
            <ol className="mt-2 space-y-2">
              {reasoning.map((entry, index) => (
                <li key={index} className="whitespace-pre-wrap leading-6 text-muted-foreground">
                  {reasoning.length > 1 ? (
                    <span className="mr-2 text-xs text-muted-foreground/70">#{index + 1}</span>
                  ) : null}
                  {entry}
                </li>
              ))}
            </ol>
          </details>
        ) : null}
      </CardContent>
    </Card>
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
  const { job, manifest, openLoop, trajectories, videoUrl, frameUrls, loading, problems } =
    useJobResult(gateway, jobId);

  if (loading && !job) {
    return (
      <p className={cn("inline-flex items-center gap-2 text-sm text-muted-foreground", className)}>
        <Loader2 aria-hidden="true" className="size-4 animate-spin" />
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

  return (
    <div className={cn("space-y-6", className)} data-testid="job-detail">
      <header className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <JobStatusBadge job={job} />
          <span className="font-mono text-xs text-muted-foreground">{job.id}</span>
          <Badge variant="outline">{job.origin}</Badge>
          {manifest?.mode ? <Badge variant="outline">{manifest.mode}</Badge> : null}
          {job.scored === false || manifest?.scored === false ? (
            <Badge variant="outline">not scored</Badge>
          ) : null}
        </div>
        {presentation.detail ? (
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground">{presentation.detail}</p>
        ) : null}
        <dl className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Model</dt>
            <dd className="text-foreground">
              {job.model.family} · {job.model.quant}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Submitted by</dt>
            <dd className="text-foreground">{job.submittedByEmail ?? job.submittedByUserId}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Queued / ran</dt>
            <dd className="text-foreground">
              {formatSeconds(job.queuedSeconds)} / {formatSeconds(
                job.startedAt && job.finishedAt
                  ? (Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 1000
                  : null,
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Cost</dt>
            <dd className="text-foreground">
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

      {aggregate ? (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-foreground">Aggregate</h2>
          <div className="flex flex-wrap gap-8">
            {Object.keys(aggregate.minADE).length > 0 ? (
              <HorizonTable label="minADE" metrics={aggregate.minADE} />
            ) : null}
            {Object.keys(aggregate.minFDE).length > 0 ? (
              <HorizonTable label="minFDE" metrics={aggregate.minFDE} />
            ) : null}
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Items</p>
              <p className="mt-1 text-sm text-foreground">
                {aggregate.okItems} of {aggregate.itemCount} returned a prediction
                {aggregate.refusedItems > 0 ? ` · ${aggregate.refusedItems} refused` : ""}
                {aggregate.failedItems > 0 ? ` · ${aggregate.failedItems} failed` : ""}
              </p>
              {Object.keys(aggregate.scoredItems).length > 0 ? (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  scored per horizon:{" "}
                  {Object.entries(aggregate.scoredItems)
                    .map(([horizon, count]) => `${horizon}s: ${count}`)
                    .join(", ")}
                </p>
              ) : null}
            </div>
          </div>
          {aggregate.refusedItems > 0 ? (
            <p className="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
              <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
              Refused items are excluded from the aggregate. They are listed below with the fields
              they were missing; nothing was substituted for them.
            </p>
          ) : null}
        </section>
      ) : null}

      {provenanceModel || provenanceInput ? (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-foreground">Provenance</h2>
          <dl className="grid gap-x-8 gap-y-2 text-xs sm:grid-cols-3">
            {provenanceModel
              ? Object.entries(provenanceModel).map(([field, value]) => (
                  <div key={field}>
                    <dt className="uppercase tracking-wide text-muted-foreground">{field}</dt>
                    <dd className="min-w-0 truncate font-mono text-foreground">{String(value)}</dd>
                  </div>
                ))
              : null}
            {provenanceInput
              ? Object.entries(provenanceInput).map(([field, value]) => (
                  <div key={`input-${field}`}>
                    <dt className="uppercase tracking-wide text-muted-foreground">input.{field}</dt>
                    <dd className="min-w-0 truncate font-mono text-foreground">
                      {Array.isArray(value) ? value.join(", ") : String(value)}
                    </dd>
                  </div>
                ))
              : null}
          </dl>
          <p className="text-xs leading-5 text-muted-foreground">
            Same seed alone is not proof of reproducibility across GPUs: the model revision,
            checkpoint digest, quantization, runtime and RNG provenance above are what pin this
            result.
          </p>
        </section>
      ) : null}

      {openLoop ? (
        <section className="space-y-4">
          <h2 className="text-sm font-semibold text-foreground">
            Items ({openLoop.items.length})
          </h2>
          <div className="space-y-4">
            {openLoop.items.map((item) => (
              <ItemCard
                key={item.itemId}
                item={item}
                videoUrl={videoUrl}
                frameUrls={frameUrls}
                projection={overlayProjection(item, trajectories)}
              />
            ))}
          </div>
        </section>
      ) : presentation.live ? (
        <p className="inline-flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 aria-hidden="true" className="size-4 animate-spin" />
          Results appear here when the run finishes. Closing this page does not stop it.
        </p>
      ) : job.status === "cancelled" ? (
        <p className="inline-flex items-center gap-2 text-sm text-muted-foreground">
          <Ban aria-hidden="true" className="size-4" />
          This run was cancelled. Cost settles from the provider&apos;s actual accounting, so a
          cancelled run is not automatically free.
        </p>
      ) : null}

      {job.result && job.result.artifacts.length > 0 ? (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-foreground">Stored artifacts</h2>
          <ul className="divide-y divide-border border border-border text-sm">
            {job.result.artifacts.map((artifact) => (
              <li key={artifact.artifactId} className="flex items-center gap-3 px-3 py-2">
                <span className="w-36 shrink-0 text-muted-foreground">{artifact.role}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                  {artifact.sha256.slice(0, 16)}
                </span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
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
