"use client";
import * as stylex from "@stylexjs/stylex";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
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
import type { EvalPolicySummary, EvalRunComparison } from "@/app/lib/evaluation/contracts";
import { formatDelta, formatScore, PanelMessage, useJsonFetch } from "../../shared";
import { styles } from "../../route-residuals.stylex";

function PolicySummaryCard({
  label,
  campaignId,
  policy,
}: {
  label: "A" | "B";
  campaignId: string;
  policy: EvalPolicySummary;
}) {
  return (
    <Card data-testid={`compare-${label}`}>
      <CardHeader xstyle={styles.cardHeaderTight} >
        <CardDescription>Policy {label}</CardDescription>
        <CardTitle xstyle={styles.cardTitle} >
          <Link {...stylex.props(styles.link)} href={`/dashboard/evaluation/${campaignId}/policies/${policy.policyId}`}>
            {policy.policyId}
          </Link>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <dl {...stylex.props(styles.dl3)} >
          {(
            [
              ["Score", formatScore(policy.meanScore)],
              ["Route", formatScore(policy.meanRouteCompletion)],
              ["Episodes", String(policy.episodes)],
            ] as const
          ).map(([term, value]) => (
            <div key={term}>
              <dt {...stylex.props(styles.tinyMuted)} >{term}</dt>
              <dd {...stylex.props(styles.mono)} >{value}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

export function CompareClient({
  campaignId,
  a,
  b,
}: {
  campaignId: string;
  a: string | null;
  b: string | null;
}) {
  useSetPageTitle("Evaluation");
  const url =
    a && b
      ? `/api/evaluation/campaigns/${campaignId}/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`
      : null;
  const state = useJsonFetch<EvalRunComparison>(url);

  if (!a || !b) {
    return <PanelMessage>Pick two policies to compare: ?a=&lt;policyId&gt;&amp;b=&lt;policyId&gt;</PanelMessage>;
  }
  if (state.kind === "loading") return <PanelMessage>Comparing runs…</PanelMessage>;
  if (state.kind === "error") {
    return <PanelMessage>Failed to compare: {state.message}</PanelMessage>;
  }
  const comparison = state.data;

  return (
    <div {...stylex.props(styles.shell)} >
      <PageHeader
        eyebrow={campaignId}
        title="A/B comparison"
        description={`${a} vs ${b} · divergence threshold ${comparison.divergenceThresholdM} m`}
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href="/dashboard/evaluation">
              <ArrowLeft {...stylex.props(styles.icon)} />
              All campaigns
            </Link>
          </Button>
        }
      />
      <div {...stylex.props(styles.content)} >
        <div {...stylex.props(styles.grid2)} >
          <PolicySummaryCard label="A" campaignId={campaignId} policy={comparison.a} />
          <PolicySummaryCard label="B" campaignId={campaignId} policy={comparison.b} />
        </div>

        <Card>
          <CardHeader>
            <CardTitle xstyle={styles.cardTitle} >Per-scenario deltas</CardTitle>
            <CardDescription>
              Score delta is B − A. Divergence is the first trace step where the ego positions
              drift apart by more than {comparison.divergenceThresholdM} m.
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
                    <TableHead xstyle={styles.numeric} >Seed</TableHead>
                    <TableHead xstyle={styles.numeric} >A score</TableHead>
                    <TableHead xstyle={styles.numeric} >B score</TableHead>
                    <TableHead xstyle={styles.numeric} >Δ</TableHead>
                    <TableHead>Divergence</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {comparison.episodes.map((episode) => (
                    <TableRow key={`${episode.scenarioId}-${episode.seed}`}>
                      <TableCell xstyle={styles.linkMedium} >{episode.scenarioId}</TableCell>
                      <TableCell xstyle={styles.numeric} >{episode.seed}</TableCell>
                      <TableCell xstyle={styles.numeric} >
                        {episode.aEpisodeId ? (
                          <Link {...stylex.props(styles.link)} href={`/dashboard/evaluation/${campaignId}/episodes/${episode.aEpisodeId}`}>
                            {formatScore(episode.aScore)}
                          </Link>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell xstyle={styles.numeric} >
                        {episode.bEpisodeId ? (
                          <Link {...stylex.props(styles.link)} href={`/dashboard/evaluation/${campaignId}/episodes/${episode.bEpisodeId}`}>
                            {formatScore(episode.bScore)}
                          </Link>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell
                        xstyle={[
                          styles.delta,
                          episode.scoreDelta !== null && episode.scoreDelta > 0
                            ? styles.deltaPositive
                            : episode.scoreDelta !== null && episode.scoreDelta < 0
                              ? styles.deltaNegative
                              : null,
                        ]}
                      >
                        {formatDelta(episode.scoreDelta)}
                      </TableCell>
                      <TableCell>
                        {episode.divergenceStep !== null ? (
                          <Badge variant="secondary" xstyle={styles.monoTiny} >
                            step {episode.divergenceStep} · {episode.divergenceTS?.toFixed(1)}s
                          </Badge>
                        ) : (
                          <span {...stylex.props(styles.tinyMuted)} >
                            {episode.aEpisodeId && episode.bEpisodeId ? "none" : "incomplete pair"}
                          </span>
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
