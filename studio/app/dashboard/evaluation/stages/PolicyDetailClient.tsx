"use client";
import * as stylex from "@stylexjs/stylex";

import { Badge } from "@simforge-oss/studio-ui/components/ui/badge";
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
import type { EvalPolicyDetail } from "@/app/lib/evaluation/contracts";
import { formatScore, PanelMessage, StatusBadge, useJsonFetch } from "../shared";
import { styles } from "../route-residuals.stylex";

function ProvenanceCard({
  detail,
  onSelectVersion,
}: {
  detail: EvalPolicyDetail;
  onSelectVersion: (versionId: string) => void;
}) {
  const provenance = detail.provenanceSample;
  if (!provenance) {
    return (
      <Card>
        <CardHeader>
          <CardTitle xstyle={styles.cardTitle} >Provenance</CardTitle>
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
        <button
          type="button"
          {...stylex.props(styles.monoSmall, styles.link)}
          onClick={() => onSelectVersion(detail.policy.modelVersionId!)}
        >
          {detail.policy.modelVersionId}
        </button>
      ) : (
        "not in registry"
      ),
    ],
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle xstyle={styles.cardTitle} >Provenance</CardTitle>
        <CardDescription>From the first completed episode of this policy</CardDescription>
      </CardHeader>
      <CardContent>
        <dl {...stylex.props(styles.dlProvenance)} >
          {rows.map(([label, value]) => (
            <div key={label}>
              <dt {...stylex.props(styles.labelMedium)} >{label}</dt>
              <dd {...stylex.props(styles.textSmall, styles.ddBreakAll)} >{value}</dd>
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
  onSelectEpisode,
  onSelectVersion,
}: {
  campaignId: string;
  policyId: string;
  onSelectEpisode: (episodeId: string) => void;
  onSelectVersion: (versionId: string) => void;
}) {
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
    <div {...stylex.props(styles.content)} >
      <div {...stylex.props(styles.flexWrap)}>
        <StatusBadge status="complete" />
        <span {...stylex.props(styles.monoSmall, styles.muted)}>
          {campaignId} · {policyId}
        </span>
      </div>
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
            <CardHeader xstyle={styles.cardHeaderTight} >
              <CardDescription>{label}</CardDescription>
              <CardTitle xstyle={styles.cardTitleLarge} >{value}</CardTitle>
            </CardHeader>
          </Card>
        ))}
      </div>

      <ProvenanceCard detail={detail} onSelectVersion={onSelectVersion} />

      <Card>
        <CardHeader>
          <CardTitle xstyle={styles.cardTitle} >Episodes</CardTitle>
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
                  <TableHead xstyle={styles.numeric} >Seed</TableHead>
                  <TableHead xstyle={styles.numeric} >Driving score</TableHead>
                  <TableHead xstyle={styles.numeric} >Route</TableHead>
                  <TableHead xstyle={styles.numeric} >Steps</TableHead>
                  <TableHead>Infractions</TableHead>
                  <TableHead xstyle={styles.numeric} >Completed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.episodes.map((episode) => (
                  <TableRow key={episode.episodeId}>
                    <TableCell>
                      <button
                        type="button"
                        {...stylex.props(styles.linkMedium)}
                        onClick={() => onSelectEpisode(episode.episodeId)}
                      >
                        {episode.scenarioId}
                      </button>
                    </TableCell>
                    <TableCell xstyle={styles.numeric} >{episode.seed}</TableCell>
                    <TableCell xstyle={styles.numeric} >
                      {formatScore(episode.score?.drivingScore ?? episode.ledgerScore)}
                    </TableCell>
                    <TableCell xstyle={styles.numeric} >
                      {formatScore(episode.score?.routeCompletion ?? episode.ledgerRouteCompletion)}
                    </TableCell>
                    <TableCell xstyle={styles.numeric} >
                      {episode.score?.steps ?? "—"}
                    </TableCell>
                    <TableCell>
                      {Object.keys(episode.score?.infractions ?? {}).length === 0 ? (
                        <span {...stylex.props(styles.xsMuted)} >none</span>
                      ) : (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: ".25rem" }} >
                          {Object.entries(episode.score?.infractions ?? {}).map(
                            ([type, count]) => (
                              <Badge
                                key={type}
                                variant="destructive"
                                xstyle={styles.infractionBadge}
                              >
                                {type}
                                {count > 1 ? ` ×${count}` : ""}
                              </Badge>
                            ),
                          )}
                        </div>
                      )}
                    </TableCell>
                    <TableCell xstyle={styles.numericTinyMuted} >
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
  );
}
