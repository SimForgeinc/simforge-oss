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
import type { EvalPolicyDetail } from "@/app/lib/evaluation/contracts";
import { formatScore, PanelMessage, StatusBadge, useJsonFetch } from "../../../shared";
import { styles } from "../../../route-residuals.stylex";

function ProvenanceCard({ detail }: { detail: EvalPolicyDetail }) {
  const provenance = detail.provenanceSample;
  if (!provenance) {
    return (
      <Card>
        <CardHeader>
          <CardTitle {...stylex.props(styles.cardTitle)} >Provenance</CardTitle>
        </CardHeader>
        <CardContent>
          <PanelMessage>No provenance.json recorded for this policy.</PanelMessage>
        </CardContent>
      </Card>
    );
  }
  const rows: Array<[string, React.ReactNode]> = [
    ["Policy kind", provenance.policy.kind ?? "—"],
    ["Adapter", provenance.policy.adapterVersion ?? "—"],
    [
      "Checkpoint digest",
      provenance.policy.checkpointDigest
        ? `${provenance.policy.checkpointDigest.slice(0, 16)}…`
        : "—",
    ],
    ["Seed", String(provenance.seed)],
    ["Decision rate", provenance.decisionHz ? `${provenance.decisionHz} Hz` : "—"],
    [
      "Model version",
      detail.policy.modelVersionId ? (
        <Link {...stylex.props(styles.monoSmall, styles.link)} href={`/dashboard/evaluation/versions/${detail.policy.modelVersionId}`}>
          {detail.policy.modelVersionId}
        </Link>
      ) : (
        "not in registry"
      ),
    ],
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle {...stylex.props(styles.cardTitle)} >Provenance</CardTitle>
        <CardDescription>From the first completed episode of this policy</CardDescription>
      </CardHeader>
      <CardContent>
        <dl {...stylex.props(styles.dlProvenance)} >
          {rows.map(([label, value]) => (
            <div key={label}>
              <dt {...stylex.props(styles.labelMedium)} >{label}</dt>
              <dd {...stylex.props(styles.textSmall)} >{value}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

export function PolicyDetailClient({
  campaignId,
  policyId,
}: {
  campaignId: string;
  policyId: string;
}) {
  useSetPageTitle("Evaluation");
  const state = useJsonFetch<EvalPolicyDetail>(
    `/api/evaluation/campaigns/${campaignId}/policies/${policyId}`,
  );

  if (state.kind === "loading") return <PanelMessage>Loading policy run…</PanelMessage>;
  if (state.kind === "error") {
    return <PanelMessage>Failed to load policy run: {state.message}</PanelMessage>;
  }
  const detail = state.data;
  const infractionsTotal = detail.episodes.reduce(
    (sum, episode) =>
      sum +
      Object.values(episode.score?.infractions ?? {}).reduce((inner, count) => inner + count, 0),
    0,
  );

  return (
    <div {...stylex.props(styles.shell)} >
      <PageHeader
        eyebrow={campaignId}
        title={policyId}
        description="Policy run — one column of the campaign"
        actions={
          <>
            <StatusBadge status="complete" />
            <Button asChild variant="outline" size="sm">
              <Link href="/dashboard/evaluation">
                <ArrowLeft {...stylex.props(styles.icon)} />
                All campaigns
              </Link>
            </Button>
          </>
        }
      />
      <div {...stylex.props(styles.content)} >
        <div {...stylex.props(styles.grid4)} >
          {(
            [
              ["Mean driving score", formatScore(detail.policy.meanScore)],
              ["Mean route completion", formatScore(detail.policy.meanRouteCompletion)],
              ["Episodes", String(detail.policy.episodes)],
              ["Infractions", String(infractionsTotal)],
            ] as const
          ).map(([label, value]) => (
            <Card key={label}>
              <CardHeader {...stylex.props(styles.cardHeaderTight)} >
                <CardDescription>{label}</CardDescription>
                <CardTitle {...stylex.props(styles.cardTitleLarge)} >{value}</CardTitle>
              </CardHeader>
            </Card>
          ))}
        </div>

        <ProvenanceCard detail={detail} />

        <Card>
          <CardHeader>
            <CardTitle {...stylex.props(styles.cardTitle)} >Episodes</CardTitle>
            <CardDescription>Per-scenario scores and infractions</CardDescription>
          </CardHeader>
          <CardContent>
            {detail.episodes.length === 0 ? (
              <PanelMessage>No completed episodes in the ledger yet.</PanelMessage>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Scenario</TableHead>
                    <TableHead {...stylex.props(styles.numeric)} >Seed</TableHead>
                    <TableHead {...stylex.props(styles.numeric)} >Driving score</TableHead>
                    <TableHead {...stylex.props(styles.numeric)} >Route</TableHead>
                    <TableHead {...stylex.props(styles.numeric)} >Steps</TableHead>
                    <TableHead>Infractions</TableHead>
                    <TableHead {...stylex.props(styles.numeric)} >Completed</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.episodes.map((episode) => (
                    <TableRow key={episode.episodeId}>
                      <TableCell>
                        <Link {...stylex.props(styles.linkMedium)} href={`/dashboard/evaluation/${campaignId}/episodes/${episode.episodeId}`}>
                          {episode.scenarioId}
                        </Link>
                      </TableCell>
                      <TableCell {...stylex.props(styles.numeric)} >{episode.seed}</TableCell>
                      <TableCell {...stylex.props(styles.numeric)} >
                        {formatScore(episode.score?.drivingScore ?? episode.ledgerScore)}
                      </TableCell>
                      <TableCell {...stylex.props(styles.numeric)} >
                        {formatScore(episode.score?.routeCompletion ?? episode.ledgerRouteCompletion)}
                      </TableCell>
                      <TableCell {...stylex.props(styles.numeric)} >
                        {episode.score?.steps ?? "—"}
                      </TableCell>
                      <TableCell>
                        {Object.keys(episode.score?.infractions ?? {}).length === 0 ? (
                          <span {...stylex.props(styles.tinyMuted)} >none</span>
                        ) : (
                          <div style={{ display: "flex", flexWrap: "wrap", gap: ".25rem" }} >
                            {Object.entries(episode.score?.infractions ?? {}).map(
                              ([type, count]) => (
                                <Badge
                                  key={type}
                                  variant="destructive"
                                  {...stylex.props(styles.infractionBadge)}
                                >
                                  {type}
                                  {count > 1 ? ` ×${count}` : ""}
                                </Badge>
                              ),
                            )}
                          </div>
                        )}
                      </TableCell>
                      <TableCell {...stylex.props(styles.numericTinyMuted)} >
                        {new Date(episode.completedAt).toLocaleTimeString()}
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
