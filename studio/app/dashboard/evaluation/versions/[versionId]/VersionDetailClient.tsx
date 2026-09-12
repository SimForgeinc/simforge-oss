"use client";
import * as stylex from "@stylexjs/stylex";

import { ArrowLeft, ShieldAlert, ShieldCheck } from "lucide-react";
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
  ModelEndpointRecord,
  ModelRunRecord,
  ModelVersionRecord,
} from "@/app/lib/models/contracts";
import { PanelMessage, StatusBadge, useJsonFetch } from "../../shared";
import { styles } from "../../route-residuals.stylex";

type PromotionResult =
  | { kind: "promoted"; runId: string }
  | { kind: "refused"; runId: string; reason: string };

export function VersionDetailClient({ versionId }: { versionId: string }) {
  useSetPageTitle("Evaluation");
  const [refreshKey, setRefreshKey] = useState(0);
  const [pendingRunId, setPendingRunId] = useState<string | null>(null);
  const [result, setResult] = useState<PromotionResult | null>(null);

  const version = useJsonFetch<{ version: ModelVersionRecord; endpoints: ModelEndpointRecord[] }>(
    `/api/models/versions/${versionId}`,
    refreshKey,
  );
  const runs = useJsonFetch<{ runs: ModelRunRecord[] }>(
    `/api/models/runs?modelVersionId=${encodeURIComponent(versionId)}`,
    refreshKey,
  );

  async function promote(runId: string) {
    setPendingRunId(runId);
    setResult(null);
    try {
      const response = await fetch(`/api/models/versions/${versionId}/promote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId }),
      });
      if (response.ok) {
        setResult({ kind: "promoted", runId });
        setRefreshKey((key) => key + 1);
        return;
      }
      const body = (await response.json().catch(() => null)) as {
        error?: string;
        detail?: string;
      } | null;
      setResult({
        kind: "refused",
        runId,
        reason: body?.detail ?? body?.error ?? `HTTP ${response.status}`,
      });
    } catch (error) {
      setResult({
        kind: "refused",
        runId,
        reason: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPendingRunId(null);
    }
  }

  if (version.kind === "loading") return <PanelMessage>Loading model version…</PanelMessage>;
  if (version.kind === "error") {
    return <PanelMessage>Failed to load version: {version.message}</PanelMessage>;
  }
  const record = version.data.version;

  return (
    <div {...stylex.props(styles.shell)} >
      <PageHeader
        eyebrow={record.family}
        title={record.name}
        description={`Model version ${record.id}`}
        actions={
          <>
            <StatusBadge status={record.status} />
            <Button asChild variant="outline" size="sm">
              <Link href="/dashboard/evaluation">
                <ArrowLeft {...stylex.props(styles.icon)} />
                Evaluation
              </Link>
            </Button>
          </>
        }
      />
      <div {...stylex.props(styles.content)} >
        <Card>
          <CardHeader>
            <CardTitle {...stylex.props(styles.cardTitle)} >Version</CardTitle>
          </CardHeader>
          <CardContent>
            <dl {...stylex.props(styles.dlProvenance)} >
              {(
                [
                  ["Source", record.source],
                  ["Quant", record.quant],
                  ["License", record.license],
                  ["Checkpoint digest", `${record.checkpointDigest.slice(0, 16)}…`],
                  ["Promoted run", record.promotedRunId ?? "—"],
                  ["Registered", new Date(record.createdAt).toLocaleString()],
                ] as const
              ).map(([label, value]) => (
                <div key={label}>
                  <dt {...stylex.props(styles.label)} >{label}</dt>
                  <dd {...stylex.props(styles.monoSmall)} >{value}</dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>

        {result ? (
          <div
            data-testid="promotion-result"
            {...stylex.props(
              styles.resultBox,
              result.kind === "promoted" ? styles.promoted : styles.refused,
            )}
          >
            {result.kind === "promoted" ? (
              <ShieldCheck {...stylex.props(styles.iconBare)} />
            ) : (
              <ShieldAlert {...stylex.props(styles.iconBare)} />
            )}
            <span>
              {result.kind === "promoted"
                ? `Promoted on evidence of run ${result.runId}.`
                : `Promotion refused for run ${result.runId}: ${result.reason}`}
            </span>
          </div>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle {...stylex.props(styles.cardTitle)} >Eval runs</CardTitle>
            <CardDescription>
              The promotion gate requires a succeeded openloop or policy_episode run of this
              version — the database trigger is the arbiter, refusals surface here.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {runs.kind === "loading" ? <PanelMessage>Loading runs…</PanelMessage> : null}
            {runs.kind === "error" ? (
              <PanelMessage>Failed to load runs: {runs.message}</PanelMessage>
            ) : null}
            {runs.kind === "ready" && runs.data.runs.length === 0 ? (
              <PanelMessage>No eval runs recorded for this version.</PanelMessage>
            ) : null}
            {runs.kind === "ready" && runs.data.runs.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Run</TableHead>
                    <TableHead>Kind</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead {...stylex.props(styles.numeric)} >Attempts</TableHead>
                    <TableHead {...stylex.props(styles.numeric)} >Created</TableHead>
                    <TableHead {...stylex.props(styles.numeric)} >Promote</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {runs.data.runs.map((run) => (
                    <TableRow key={run.id} data-testid={`model-run-${run.id}`}>
                      <TableCell {...stylex.props(styles.monoSmall)} >{run.id}</TableCell>
                      <TableCell>
                        <Badge variant="secondary">{run.kind}</Badge>
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={run.status} />
                      </TableCell>
                      <TableCell {...stylex.props(styles.numeric)} >
                        {run.attemptCount}/{run.maxAttempts}
                      </TableCell>
                      <TableCell {...stylex.props(styles.numericTinyMuted)} >
                        {new Date(run.createdAt).toLocaleTimeString()}
                      </TableCell>
                      <TableCell {...stylex.props(styles.numeric)} >
                        {record.promotedRunId === run.id ? (
                          <Badge {...stylex.props(styles.promotedBadge)}>
                            promoted
                          </Badge>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={pendingRunId !== null}
                            data-testid={`promote-${run.id}`}
                            onClick={() => void promote(run.id)}
                          >
                            {pendingRunId === run.id ? "Promoting…" : "Promote"}
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
