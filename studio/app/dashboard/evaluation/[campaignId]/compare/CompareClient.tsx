"use client";

import { ArrowLeft, ChevronDown } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useSetPageTitle } from "@simforge-oss/studio-ui/components/TopBarSlot";
import { Badge } from "@simforge-oss/studio-ui/components/ui/badge";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@simforge-oss/studio-ui/components/ui/card";
import { PageHeader } from "@simforge-oss/studio-ui/components/ui/page-header";
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
import { cn } from "@simforge-oss/studio-ui/lib/utils";
import { formatScore, PanelMessage, useJsonFetch } from "../../shared";

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
  incomparable: "Not comparable",
};

const VERDICT_CLASS: Record<EvalComparabilityVerdict, string> = {
  matched: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-transparent",
  "sensor-different": "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-transparent",
  "runtime-different": "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-transparent",
  "incomplete-identity": "bg-muted text-muted-foreground border-transparent",
  incomparable: "bg-muted text-muted-foreground border-transparent",
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
  incomparable: "not comparable",
};

function VerdictBadge({ verdict }: { verdict: EvalComparabilityVerdict }) {
  return (
    <Badge variant="outline" className={cn("text-[10px]", VERDICT_CLASS[verdict])}>
      {VERDICT_LABEL[verdict]}
    </Badge>
  );
}

/** Human first: the model and its rig in a sentence, hashes behind a toggle. */
function ColumnCard({
  index,
  campaignId,
  policy,
  sample,
}: {
  index: number;
  campaignId: string;
  policy: EvalPolicySummary;
  sample: EvalComparisonCell | null;
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
      <CardHeader className="pb-2">
        <CardDescription>
          {index === 0 ? "Baseline" : `Column ${String(index + 1)}`}
        </CardDescription>
        <CardTitle className="text-base">
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
      <CardContent className="space-y-2 text-sm">
        <dl className="grid grid-cols-2 gap-2">
          <div>
            <dt className="text-xs text-muted-foreground">Episodes</dt>
            <dd className="font-mono">{policy.episodes}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Mean score (all)</dt>
            <dd className="font-mono">{formatScore(policy.meanScore)}</dd>
          </div>
        </dl>
        {rig?.cadenceDividesExactly === false ? (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            Camera history was resampled; up to{" "}
            {rig.worstResampleErrorS !== null
              ? `${(rig.worstResampleErrorS * 1000).toFixed(1)} ms`
              : "one frame"}{" "}
            of timing jitter. Not ranked against a run rendered on cadence.
          </p>
        ) : null}
        <button
          type="button"
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setShowAdvanced((value) => !value)}
        >
          <ChevronDown className={cn("h-3 w-3 transition-transform", showAdvanced ? "rotate-180" : null)} />
          {showAdvanced ? "Hide" : "Show"} exact identity
        </button>
        {showAdvanced ? (
          <dl className="grid grid-cols-1 gap-1 border-t pt-2 text-[11px]">
            {(
              [
                ["Policy", policy.policyId],
                ["Revision", identity?.revision ?? null],
                ["Checkpoint", identity?.checkpointDigest ?? null],
                ["Rig profile version", rig?.profileVersion ?? null],
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
                <div key={term} className="flex items-baseline justify-between gap-2">
                  <dt className="text-muted-foreground">{term}</dt>
                  <dd className="truncate font-mono" title={value}>
                    {value}
                  </dd>
                </div>
              ))}
            <div className="pt-1">
              <Link
                className="hover:underline"
                href={`/dashboard/evaluation/${campaignId}/policies/${policy.policyId}`}
              >
                Open column run
              </Link>
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
    <div className="space-y-1 border-b py-3 last:border-b-0">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-sm font-medium">{label}</span>
        {ranking.orderable ? null : (
          <Badge variant="outline" className="bg-amber-500/15 text-[10px] text-amber-700 border-transparent dark:text-amber-400">
            readings only, not ranked
          </Badge>
        )}
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        {ranking.columns.map((column) => (
          <div key={column.columnIndex} className="text-sm">
            <div className="text-xs text-muted-foreground">
              {columns[column.columnIndex]?.policyId ?? `column ${String(column.columnIndex + 1)}`}
            </div>
            <div className="font-mono">
              {column.mean === null ? "unavailable" : formatScore(column.mean)}
              <span className="ml-1 text-[10px] text-muted-foreground">
                {column.rows === 0 ? "no comparable rows" : `over ${String(column.rows)} rows`}
              </span>
            </div>
          </div>
        ))}
      </div>
      {excludedCounts.size > 0 ? (
        <p className="text-[11px] text-muted-foreground">
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
  if (!cell || !cell.episodeId) return <span className="text-muted-foreground">no run</span>;
  if (cell.unavailable.includes(metricId)) {
    return <span className="text-muted-foreground" title="This run could not assess this metric">unavailable</span>;
  }
  const value = cell.metrics[metricId];
  if (typeof value !== "number") {
    return (
      <span className="text-muted-foreground" title={cell.unscoredReason ?? undefined}>
        {cell.unscoredReason ? "unscored" : "\u2014"}
      </span>
    );
  }
  return <span>{formatScore(value)}</span>;
}

export function CompareClient({
  campaignId,
  policies,
}: {
  campaignId: string;
  policies: readonly string[];
}) {
  useSetPageTitle("Evaluation");
  const query = policies.map((policy) => `policy=${encodeURIComponent(policy)}`).join("&");
  const url = policies.length >= 2 ? `/api/evaluation/campaigns/${campaignId}/compare?${query}` : null;
  const state = useJsonFetch<EvalRunComparison>(url);

  if (policies.length < 2) {
    return (
      <PanelMessage>
        Pick at least two runs to compare: add <code>?policy=&lt;id&gt;&amp;policy=&lt;id&gt;</code>. The
        first is the baseline.
      </PanelMessage>
    );
  }
  if (state.kind === "loading") return <PanelMessage>Comparing runs…</PanelMessage>;
  if (state.kind === "error") return <PanelMessage>Failed to compare: {state.message}</PanelMessage>;
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
    <div className="flex h-full flex-col overflow-y-auto">
      <PageHeader
        eyebrow={campaignId}
        title="Model comparison"
        description={`${String(columnCount)} runs · baseline ${comparison.columns[0]?.policyId ?? "?"} · divergence threshold ${String(comparison.divergenceThresholdM)} m`}
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href="/dashboard/evaluation">
              <ArrowLeft className="mr-1.5 h-4 w-4" />
              All campaigns
            </Link>
          </Button>
        }
      />
      <div className="flex flex-col gap-5 px-5 py-5 sm:px-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {comparison.columns.map((policy, index) => (
            <ColumnCard
              key={`${policy.policyId}-${String(index)}`}
              index={index}
              campaignId={campaignId}
              policy={policy}
              sample={firstCellByColumn[index] ?? null}
            />
          ))}
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Metrics</CardTitle>
            <CardDescription>
              A metric is ranked only over rows where every column matched the baseline and defined
              it. Where a run saw different cameras or ran on a different runtime, its numbers are
              shown as readings and not ordered — the difference would not be the model&apos;s. A
              run that did not record its full identity is never treated as matching another:
              two unknowns are not an agreement.
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-0">
            {comparison.rankings.map((ranking) => (
              <MetricRow key={ranking.metricId} ranking={ranking} columns={comparison.columns} />
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Per-scenario</CardTitle>
            <CardDescription>
              Divergence is the first trace step where a column&apos;s ego drifts more than{" "}
              {String(comparison.divergenceThresholdM)} m from the baseline&apos;s.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {comparison.episodes.length === 0 ? (
              <PanelMessage>No overlapping scenario+seed episodes between these runs.</PanelMessage>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Scenario</TableHead>
                    <TableHead className="text-right">Seed</TableHead>
                    {comparison.columns.map((policy, index) => (
                      <TableHead key={`head-${String(index)}`} className="text-right">
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
                      <TableCell className="font-medium">{episode.scenarioId}</TableCell>
                      <TableCell className="text-right font-mono">{episode.seed}</TableCell>
                      {episode.cells.map((cell, index) => (
                        <TableCell key={`cell-${String(index)}`} className="text-right font-mono">
                          {cell?.episodeId ? (
                            <Link
                              className="hover:underline"
                              href={`/dashboard/evaluation/${campaignId}/episodes/${cell.episodeId}`}
                            >
                              <CellValue cell={cell} metricId="drivingScore" />
                            </Link>
                          ) : (
                            <CellValue cell={cell} metricId="drivingScore" />
                          )}
                        </TableCell>
                      ))}
                      <TableCell className="space-x-1">
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
                          <span className="font-mono text-[10px] text-muted-foreground">
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
                          <span className="text-xs text-muted-foreground">none</span>
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
    </div>
  );
}
