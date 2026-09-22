"use client";
import { EmptyState } from "@simforge-oss/studio-ui/components/ui/empty-state";
import { CloudLoadingSurface } from "@simforge-oss/studio-ui/components/CloudLoadingSurface";
import { ListSkeleton } from "@simforge-oss/studio-ui/components/ListSkeleton";
import { PaneErrorState } from "@simforge-oss/studio-ui/components/state-frames";
import * as stylex from "@stylexjs/stylex";

import { ShieldAlert, ShieldCheck } from "lucide-react";
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
  ModelEndpointRecord,
  ModelRunRecord,
  ModelVersionRecord,
} from "@/app/lib/models/contracts";
import { StatusBadge, useJsonFetch } from "../shared";
import { styles } from "../route-residuals.stylex";

type PromotionResult =
  | { kind: "promoted"; runId: string }
  | { kind: "refused"; runId: string; reason: string };

export function VersionDetailClient({ versionId }: { versionId: string }) {
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

  if (version.kind === "loading") return <CloudLoadingSurface scope="pane" title="Loading model version…" />;
  if (version.kind === "error") {
    return <PaneErrorState title="Could not load model version" description={version.message} onRetry={version.retry} exitHref="/dashboard/evaluation" exitLabel="Back to evaluation" />;
  }
  const record = version.data.version;

  return (
    <div {...stylex.props(styles.content)} >
      <Card>
        <CardHeader xstyle={styles.cardHeaderTight}>
          <CardDescription>{record.family}</CardDescription>
          <CardTitle >{record.name}</CardTitle>
          <CardDescription>
            <StatusBadge status={record.status} /> Model version {record.id}
          </CardDescription>
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
                <dt {...stylex.props(styles.labelMedium)} >{label}</dt>
                <dd {...stylex.props(styles.monoSmall, styles.ddBreakAll)} >{value}</dd>
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
            <ShieldCheck {...stylex.props(styles.iconTopShrink)} />
          ) : (
            <ShieldAlert {...stylex.props(styles.iconTopShrink)} />
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
          <CardTitle >Eval runs</CardTitle>
          <CardDescription>
            The promotion gate requires a succeeded openloop or policy_episode run of this
            version — the database trigger is the arbiter, refusals surface here.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {runs.kind === "loading" ? <ListSkeleton label="Loading runs" /> : null}
          {runs.kind === "error" ? (
            <PaneErrorState title="Could not load runs" description={runs.message} onRetry={runs.retry} />
          ) : null}
          {runs.kind === "ready" && runs.data.runs.length === 0 ? (
            <EmptyState title="No eval runs recorded for this version." />
          ) : null}
          {runs.kind === "ready" && runs.data.runs.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Run</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead xstyle={styles.numeric} >Attempts</TableHead>
                  <TableHead xstyle={styles.numeric} >Created</TableHead>
                  <TableHead xstyle={styles.numeric} >Promote</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.data.runs.map((run) => (
                  <TableRow key={run.id} data-testid={`model-run-${run.id}`}>
                    <TableCell xstyle={styles.monoSmall} >{run.id}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{run.kind}</Badge>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={run.status} />
                    </TableCell>
                    <TableCell xstyle={styles.numeric} >
                      {run.attemptCount}/{run.maxAttempts}
                    </TableCell>
                    <TableCell xstyle={styles.numericTinyMuted} >
                      {new Date(run.createdAt).toLocaleTimeString()}
                    </TableCell>
                    <TableCell xstyle={styles.numeric} >
                      {record.promotedRunId === run.id ? (
                        <Badge xstyle={styles.promotedBadge}>
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
  );
}
