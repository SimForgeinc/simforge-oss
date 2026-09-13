"use client";

import { FlaskConical, GitCompareArrows } from "lucide-react";
import * as stylex from "@stylexjs/stylex";
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
import { EmptyState } from "@simforge-oss/studio-ui/components/ui/empty-state";
import { PageHeader } from "@simforge-oss/studio-ui/components/ui/page-header";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@simforge-oss/studio-ui/components/ui/table";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@simforge-oss/studio-ui/components/ui/tabs";
import type { EvalCampaignSummary } from "@/app/lib/evaluation/contracts";
import type { ModelVersionRecord } from "@/app/lib/models/contracts";
import { CloudRunsClient } from "./CloudRunsClient";
import { formatScore, PanelMessage, StatusBadge, useJsonFetch } from "./shared";
import { styles } from "./evaluation-page.stylex";

function CampaignCard({ campaign }: { campaign: EvalCampaignSummary }) {
  const [policyA, policyB] = campaign.policies;
  return (
    <Card data-testid={`campaign-${campaign.campaignId}`}>
      <CardHeader xstyle={styles.campaignHeader}>
        <div>
          <CardTitle xstyle={styles.cardTitle}>{campaign.name}</CardTitle>
          <CardDescription>
            {campaign.campaignId} · {campaign.episodes} episodes
            {campaign.createdAt ? ` · created ${new Date(campaign.createdAt).toLocaleString()}` : ""}
            {campaign.hasReport ? " · report ready" : ""}
          </CardDescription>
        </div>
        {policyA && policyB ? (
          <Button asChild variant="outline" size="sm">
            <Link
              href={{
                pathname: `/dashboard/evaluation/${campaign.campaignId}/compare`,
                query: { a: policyA.policyId, b: policyB.policyId },
              }}
            >
              <GitCompareArrows {...stylex.props(styles.icon)} />
              Compare A/B
            </Link>
          </Button>
        ) : null}
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Policy (run)</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Model version</TableHead>
              <TableHead xstyle={styles.right}>Driving score</TableHead>
              <TableHead xstyle={styles.right}>Route completion</TableHead>
              <TableHead xstyle={styles.right}>Episodes</TableHead>
              <TableHead xstyle={styles.right}>Last completed</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {campaign.policies.map((policy) => (
              <TableRow key={policy.policyId}>
                <TableCell>
                  <Link
                    {...stylex.props(styles.link)}
                    href={`/dashboard/evaluation/${campaign.campaignId}/policies/${policy.policyId}`}
                  >
                    {policy.policyId}
                  </Link>
                </TableCell>
                <TableCell>
                  <StatusBadge status="complete" />
                </TableCell>
                <TableCell>
                  {policy.modelVersionId ? (
                    <Link
                      {...stylex.props(styles.modelLink)}
                      href={`/dashboard/evaluation/versions/${policy.modelVersionId}`}
                    >
                      {policy.modelVersionId.slice(0, 12)}…
                    </Link>
                  ) : (
                    <span {...stylex.props(styles.muted)}>unregistered</span>
                  )}
                </TableCell>
                <TableCell xstyle={styles.numeric}>
                  {formatScore(policy.meanScore)}
                </TableCell>
                <TableCell xstyle={styles.numeric}>
                  {formatScore(policy.meanRouteCompletion)}
                </TableCell>
                <TableCell xstyle={styles.numeric}>{policy.episodes}</TableCell>
                <TableCell xstyle={styles.numericMuted}>
                  {policy.lastCompletedAt
                    ? new Date(policy.lastCompletedAt).toLocaleTimeString()
                    : "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function ModelVersionsCard({ versions }: { versions: ModelVersionRecord[] }) {
  return (
    <Card data-testid="model-versions">
      <CardHeader>
        <CardTitle xstyle={styles.cardTitle}>Model versions</CardTitle>
        <CardDescription>
          Registry state and promotion gates — promote from a version&apos;s detail page.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {versions.length === 0 ? (
          <PanelMessage>No registered model versions.</PanelMessage>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Version</TableHead>
                <TableHead>Family</TableHead>
                <TableHead>Quant</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Promoted run</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {versions.map((version) => (
                <TableRow key={version.id}>
                  <TableCell>
                    <Link
                      {...stylex.props(styles.link)}
                      href={`/dashboard/evaluation/versions/${version.id}`}
                    >
                      {version.name}
                    </Link>
                  </TableCell>
                  <TableCell>{version.family}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{version.quant}</Badge>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={version.status} />
                  </TableCell>
                  <TableCell xstyle={styles.promoted}>
                    {version.promotedRunId ? `${version.promotedRunId.slice(0, 12)}…` : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

export function EvaluationPageClient() {
  useSetPageTitle("Evaluation");
  const campaigns = useJsonFetch<{ campaigns: EvalCampaignSummary[] }>(
    "/api/evaluation/campaigns",
  );
  const versions = useJsonFetch<{ versions: ModelVersionRecord[] }>("/api/models/versions");
  return (
    <div {...stylex.props(styles.page)}>
      <PageHeader
        title="Video prediction"
        description="Upload one driving video or synchronized camera views for an unscored AlpaMayo trajectory and reasoning overlay."
      />
      <Tabs {...stylex.props(styles.tabs)} defaultValue="runs">
        <TabsList xstyle={styles.tabList}>
          <TabsTrigger value="runs">Video prediction</TabsTrigger>
          <TabsTrigger value="campaigns">Research campaigns</TabsTrigger>
        </TabsList>

        <TabsContent xstyle={styles.tabContent} value="runs">
          <CloudRunsClient />
        </TabsContent>

        <TabsContent value="campaigns">
          <div {...stylex.props(styles.campaignList)}>
            {campaigns.kind === "loading" ? <PanelMessage>Loading campaigns…</PanelMessage> : null}
            {campaigns.kind === "error" ? (
              <PanelMessage>Failed to load campaigns: {campaigns.message}</PanelMessage>
            ) : null}
            {campaigns.kind === "ready" && campaigns.data.campaigns.length === 0 ? (
              <EmptyState
                icon={<FlaskConical {...stylex.props(styles.emptyIcon)} />}
                title="No eval campaigns yet"
                description="Campaign ledgers are read from the runs root (simforge-assets/runs/<campaignId>/ledger.jsonl)."
              />
            ) : null}
            {campaigns.kind === "ready"
              ? campaigns.data.campaigns.map((campaign) => (
                  <CampaignCard key={campaign.campaignId} campaign={campaign} />
                ))
              : null}
            {versions.kind === "ready" ? (
              <ModelVersionsCard versions={versions.data.versions} />
            ) : null}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
