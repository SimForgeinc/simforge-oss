"use client";
import { EmptyState } from "@simforge-oss/studio-ui/components/ui/empty-state";
import { CloudLoadingSurface } from "@simforge-oss/studio-ui/components/CloudLoadingSurface";
import { PaneErrorState } from "@simforge-oss/studio-ui/components/state-frames";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./CompareClient.stylex";

import { ComparisonLauncher } from "./ComparisonLauncher";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { Badge } from "@simforge-oss/studio-ui/components/ui/badge";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@simforge-oss/studio-ui/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@simforge-oss/studio-ui/components/ui/table";
import type {
  EvalComparabilityVerdict,
  EvalComparisonCell,
  EvalMetricRanking,
  EvalPolicySummary,
  EvalRunComparison,
} from "@/app/lib/evaluation/contracts";
import { formatScore, useJsonFetch } from "../shared";
import { styles as residual } from "../route-residuals.stylex";

/** Metric ids the page shows, with the label a person reads. */
const METRIC_LABELS: Record<string, string> = {
  drivingScore: "Driving score",
  routeCompletion: "Route completion",
};

const VERDICT_LABEL: Record<EvalComparabilityVerdict, string> = {
  matched: "Matched",
  "sensor-different": "Different cameras",
  "runtime-different": "Different runtime",
  "incomplete-identity": "Identity incomplete",
  "identity-integrity": "Identity does not match its label",
  incomparable: "Not comparable",
};

const VERDICT_STYLE = {
  matched: styles.verdictMatched,
  "sensor-different": styles.verdictDifferent,
  "runtime-different": styles.verdictDifferent,
  "incomplete-identity": styles.verdictUnknown,
  "identity-integrity": styles.verdictInvalid,
  incomparable: styles.verdictUnknown,
};

const UNRANKABLE_LABEL: Record<string, string> = {
  missing: "no run for this scenario",
  failed: "run failed",
  cancelled: "run cancelled",
  truncated: "run truncated",
  unscored: "not scored",
  "metric-unavailable": "metric unavailable",
  "sensor-different": "different cameras",
  "runtime-different": "different runtime",
  "incomplete-identity": "identity not fully recorded",
  "identity-integrity": "one revision, two different checkpoints",
  incomparable: "not comparable",
};

function VerdictBadge({ verdict }: { verdict: EvalComparabilityVerdict }) {
  return (
    <Badge variant="outline" xstyle={[styles.verdict, VERDICT_STYLE[verdict]]}>
      {VERDICT_LABEL[verdict]}
    </Badge>
  );
}

/** Human first: the model and its rig in a sentence, hashes behind a toggle. */
function ColumnCard({
  index,
  policy,
  sample,
  onSelectPolicy,
}: {
  index: number;
  policy: EvalPolicySummary;
  sample: EvalComparisonCell | null;
  onSelectPolicy: (policyId: string) => void;
}) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const identity = sample?.identity ?? null;
  const rig = identity?.rig ?? null;
  const cameraSummary =
    rig && rig.cameraIds.length > 0
      ? `${String(rig.cameraIds.length)} cameras [${rig.cameraIds.join(", ")}]`
      : "cameras not recorded";
  const resolution =
    rig?.resolution.width && rig.resolution.height
      ? `${String(rig.resolution.width)}\u00d7${String(rig.resolution.height)}`
      : null;

  return (
    <Card data-testid={`compare-column-${String(index)}`}>
      <CardHeader xstyle={residual.cardHeaderTight}>
        <CardDescription>
          {index === 0 ? "Baseline" : `Column ${String(index + 1)}`}
        </CardDescription>
        <CardTitle xstyle={residual.cardTitle}>
          {identity?.familyLabel ?? identity?.family ?? policy.policyId}
        </CardTitle>
        <CardDescription>
          {[
            identity?.quant ? `${identity.quant} precision` : null,
            rig?.profile ?? null,
            cameraSummary,
            resolution,
            rig?.cadenceHz ? `${String(rig.cadenceHz)} Hz cameras` : null,
            identity?.runtime.decisionHz ? `${String(identity.runtime.decisionHz)} Hz decisions` : null,
          ]
            .filter((part): part is string => part !== null)
            .join(" \u00b7 ")}
        </CardDescription>
      </CardHeader>
      <CardContent xstyle={residual.content4}>
        <dl {...stylex.props(styles.dlGrid)}>
          <div>
            <dt {...stylex.props(styles.episodes)}>Episodes</dt>
            <dd {...stylex.props(styles.ddMono)}>{policy.episodes}</dd>
          </div>
          <div>
            <dt {...stylex.props(styles.meanScore)}>Mean score (all)</dt>
            <dd {...stylex.props(styles.ddMono2)}>{formatScore(policy.meanScore)}</dd>
          </div>
        </dl>
        {rig?.cadenceDividesExactly === false ? (
          <p {...stylex.props(styles.cameraHistoryWasResampled)}>
            Camera history was resampled; up to{" "}
            {rig.worstResampleErrorS !== null
              ? `${(rig.worstResampleErrorS * 1000).toFixed(1)} ms`
              : "one frame"}{" "}
            of timing jitter. Not ranked against a run rendered on cadence.
          </p>
        ) : null}
        <button
          type="button"
          {...stylex.props(styles.buttonFlexXs)}
          onClick={() => setShowAdvanced((value) => !value)}
        >
          <ChevronDown {...stylex.props(styles.disclosureIcon, showAdvanced && styles.disclosureOpen)} />
          {showAdvanced ? "Hide" : "Show"} exact identity
        </button>
        {showAdvanced ? (
          <dl {...stylex.props(styles.dlGrid2)}>
            {(
              [
                ["Policy", policy.policyId],
                ["Revision", identity?.revision ?? null],
                ["Checkpoint", identity?.checkpointDigest ?? null],
                ["Capture version", rig?.captureVersion ?? null],
                ["Model requirement version", identity?.modelRequirementVersion ?? null],
                ["Rig intrinsics", rig?.intrinsicsSha256 ?? null],
                ["Rig extrinsics", rig?.extrinsicsSha256 ?? null],
                ["History", rig?.historyFrames !== null && rig?.historyFrames !== undefined ? `${String(rig.historyFrames)} frames @ ${String(rig.historyDtS ?? "?")} s` : null],
                ["Engine", identity?.runtime.engineVersion ?? null],
                ["Addon", identity?.runtime.addonSha256 ?? null],
                ["Policy seed", identity?.policySeed !== null && identity?.policySeed !== undefined ? String(identity.policySeed) : null],
              ] as const
            )
              .flatMap(([term, value]) => (typeof value === "string" ? [[term, value] as const] : []))
              .map(([term, value]) => (
                <div key={term} {...stylex.props(styles.divFlex)}>
                  <dt {...stylex.props(styles.dt)}>{term}</dt>
                  <dd {...stylex.props(styles.ddTruncateMono)} title={value}>
                    {value}
                  </dd>
                </div>
              ))}
            <div {...stylex.props(styles.div)}>
              <button
                type="button"
                {...stylex.props(styles.openColumnRunLink)}
                onClick={() => onSelectPolicy(policy.policyId)}
              >
                Open column run
              </button>
            </div>
          </dl>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * A metric across columns.
 *
 * When `orderable` is false the means are still shown, because "0.71 with four
 * cameras against 0.64 with two" is worth reading — but nothing is sorted and
 * the reason is stated, because ordering them would assert the difference was
 * the model's.
 */
function MetricRow({
  ranking,
  columns,
}: {
  ranking: EvalMetricRanking;
  columns: EvalPolicySummary[];
}) {
  const label = METRIC_LABELS[ranking.metricId] ?? ranking.metricId;
  const excludedCounts = new Map<string, number>();
  for (const entry of ranking.excluded) {
    excludedCounts.set(entry.reason, (excludedCounts.get(entry.reason) ?? 0) + 1);
  }
  return (
    <div {...stylex.props(styles.div2)}>
      <div {...stylex.props(styles.divFlex2)}>
        <span {...stylex.props(styles.spanSmMedium)}>{label}</span>
        {ranking.orderable ? null : (
          <Badge variant="outline" xstyle={styles.readingsOnlyBadge}>
            readings only, not ranked
          </Badge>
        )}
      </div>
      <div {...stylex.props(styles.divGrid)}>
        {ranking.columns.map((column) => (
          <div key={column.columnIndex} {...stylex.props(styles.divSm)}>
            <div {...stylex.props(styles.divXs)}>
              {columns[column.columnIndex]?.policyId ?? `column ${String(column.columnIndex + 1)}`}
            </div>
            <div {...stylex.props(styles.divMono)}>
              {column.mean === null ? "unavailable" : formatScore(column.mean)}
              <span {...stylex.props(styles.span)}>
                {column.rows === 0 ? "no comparable rows" : `over ${String(column.rows)} rows`}
              </span>
            </div>
          </div>
        ))}
      </div>
      {excludedCounts.size > 0 ? (
        <p {...stylex.props(styles.excluded)}>
          Excluded:{" "}
          {[...excludedCounts.entries()]
            .map(([reason, count]) => `${String(count)} ${UNRANKABLE_LABEL[reason] ?? reason}`)
            .join(", ")}
          . Nothing excluded is counted as zero.
        </p>
      ) : null}
    </div>
  );
}

function CellValue({ cell, metricId }: { cell: EvalComparisonCell | null; metricId: string }) {
  if (!cell || !cell.episodeId) return <span {...stylex.props(styles.noRun)}>no run</span>;
  if (cell.unavailable.includes(metricId)) {
    return <span {...stylex.props(styles.thisRunCouldNotAssessThisMet)} title="This run could not assess this metric">unavailable</span>;
  }
  const value = cell.metrics[metricId];
  if (typeof value !== "number") {
    return (
      <span {...stylex.props(styles.span2)} title={cell.unscoredReason ?? undefined}>
        {cell.unscoredReason ? "unscored" : "\u2014"}
      </span>
    );
  }
  return <span>{formatScore(value)}</span>;
}

export function CompareClient({
  campaignId,
  policies,
  onSelectPolicy,
  onSelectEpisode,
  onSelectCampaign,
}: {
  campaignId: string;
  policies: readonly string[];
  onSelectPolicy: (policyId: string) => void;
  onSelectEpisode: (episodeId: string) => void;
  /** Leave the comparison for the campaign it belongs to. */
  onSelectCampaign: (campaignId: string) => void;
}) {
  const query = policies.map((policy) => `policy=${encodeURIComponent(policy)}`).join("&");
  const url = policies.length >= 2 ? `/api/evaluation/campaigns/${campaignId}/compare?${query}` : null;
  const state = useJsonFetch<EvalRunComparison>(url);

  // With nothing selected the page is not empty: choosing models and STARTING a
  // comparison is the other half of this surface, and it is the half a person
  // reaches for when there is nothing to compare yet.
  if (policies.length < 2) {
    return (
      <div {...stylex.props(residual.content4)}>
        <EmptyState title="A comparison needs at least two policies. Pick them on the campaign, or start a new comparison here; the first column is the baseline." />
        <ComparisonLauncher campaignId={campaignId} onSelectCampaign={onSelectCampaign} />
      </div>
    );
  }
  if (state.kind === "loading") return <CloudLoadingSurface scope="pane" title="Comparing runs…" />;
  if (state.kind === "error") return <PaneErrorState title="Could not compare runs" description={state.message} onRetry={state.retry} exitHref="/dashboard/evaluation" exitLabel="Back to evaluation" />;
  const comparison = state.data;
  const columnCount = comparison.columns.length;
  const firstCellByColumn = comparison.columns.map((_, index) => {
    for (const episode of comparison.episodes) {
      const cell = episode.cells[index];
      if (cell) return cell;
    }
    return null;
  });

  return (
    <div {...stylex.props(residual.content)}>
      <p {...stylex.props(residual.xsMuted)}>
        {String(columnCount)} runs · baseline {comparison.columns[0]?.policyId ?? "?"} · divergence
        threshold {String(comparison.divergenceThresholdM)} m
      </p>
      <div {...stylex.props(residual.grid3)}>
        {comparison.columns.map((policy, index) => (
          <ColumnCard
            key={`${policy.policyId}-${String(index)}`}
            index={index}
            policy={policy}
            onSelectPolicy={onSelectPolicy}
            sample={firstCellByColumn[index] ?? null}
          />
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle xstyle={residual.cardTitle}>Metrics</CardTitle>
          <CardDescription>
            A metric is ranked only over rows where every column matched the baseline and defined
            it. Where a run saw different cameras or ran on a different runtime, its numbers are
            shown as readings and not ordered — the difference would not be the model&apos;s. A
            run that did not record its full identity is never treated as matching another:
            two unknowns are not an agreement.
          </CardDescription>
        </CardHeader>
        <CardContent xstyle={residual.content4}>
          {comparison.rankings.map((ranking) => (
            <MetricRow key={ranking.metricId} ranking={ranking} columns={comparison.columns} />
          ))}
        </CardContent>
      </Card>


      <Card>
        <CardHeader>
        <CardTitle xstyle={residual.cardTitle}>Per-scenario</CardTitle>
          <CardDescription>
            Divergence is the first trace step where a column&apos;s ego drifts more than{" "}
            {String(comparison.divergenceThresholdM)} m from the baseline&apos;s.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {comparison.episodes.length === 0 ? (
            <EmptyState title="No overlapping scenario+seed episodes between these runs." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Scenario</TableHead>
                  <TableHead xstyle={residual.numeric}>Seed</TableHead>
                  {comparison.columns.map((policy, index) => (
                    <TableHead key={`head-${String(index)}`} xstyle={residual.numeric}>
                      {index === 0 ? "Baseline" : `Col ${String(index + 1)}`}
                    </TableHead>
                  ))}
                  <TableHead>Comparability</TableHead>
                  <TableHead>Divergence</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {comparison.episodes.map((episode) => (
                  <TableRow key={`${episode.scenarioId}-${String(episode.seed)}`}>
                    <TableCell xstyle={styles.linkMedium}>{episode.scenarioId}</TableCell>
                    <TableCell xstyle={residual.numeric}>{episode.seed}</TableCell>
                    {episode.cells.map((cell, index) => (
                      <TableCell key={`cell-${String(index)}`} xstyle={residual.numeric}>
                        {cell?.episodeId ? (
                          <button
                            type="button"
                            {...stylex.props(residual.linkMedium)}
                            onClick={() => onSelectEpisode(cell.episodeId!)}
                          >
                            <CellValue cell={cell} metricId="drivingScore" />
                          </button>
                        ) : (
                          <CellValue cell={cell} metricId="drivingScore" />
                        )}
                      </TableCell>
                    ))}
                    <TableCell xstyle={styles.tablecell}>
                      {episode.verdicts.slice(1).map((verdict, index) => (
                        <span
                          key={`verdict-${String(index)}`}
                          title={episode.differing[index + 1]?.join(", ") ?? undefined}
                        >
                          <VerdictBadge verdict={verdict} />
                        </span>
                      ))}
                    </TableCell>
                    <TableCell>
                      {episode.divergenceStep.slice(1).some((step) => step !== null) ? (
                        <span {...stylex.props(styles.spanMono)}>
                          {episode.divergenceStep
                            .slice(1)
                            .map((step, index) =>
                              step === null
                                ? "\u2014"
                                : `step ${String(step)} (${(episode.divergenceTS[index + 1] ?? 0).toFixed(1)}s)`,
                            )
                            .join(" · ")}
                        </span>
                      ) : (
                        <span {...stylex.props(styles.none)}>none</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
