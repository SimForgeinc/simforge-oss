"use client";

/**
 * One run executed on this machine.
 *
 * Deliberately a different screen from the cloud run detail, because the two
 * are genuinely different: a local run has attempts against a local endpoint
 * and writes its output to this filesystem, so there is no artifact id, no
 * presigned grant and no cost. What it does share is the result document —
 * `worker/model-run.ts` writes the same `simforge.eval-result-manifest/v1`
 * the cloud worker writes — so the metrics and provenance shown here mean the
 * same thing they mean on a cloud run.
 */

import Link from "next/link";
import { useCallback, useState } from "react";
import { ArrowLeft, Loader2 } from "lucide-react";
import { readEvalResultManifest, RefusalNotice } from "@simforge-oss/studio-ui/evaluation";
import type { EvalResultManifest } from "@simforge-oss/studio-ui/evaluation";
import { Badge } from "@simforge-oss/studio-ui/components/ui/badge";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import { PageHeader } from "@simforge-oss/studio-ui/components/ui/page-header";
import { useSetPageTitle } from "@simforge-oss/studio-ui/components/TopBarSlot";
import { useVisiblePolling } from "@simforge-oss/studio-ui/lib/use-visible-polling";

type LocalRun = {
  id: string;
  kind: string;
  status: "queued" | "running" | "succeeded" | "failed";
  modelVersionId: string;
  endpointId: string;
  seed: number;
  metrics: Record<string, unknown> | null;
  outputRefs: unknown[];
  attemptCount: number;
  maxAttempts: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

const POLL_MS = 2000;

export function LocalRunClient({ runId }: { runId: string }) {
  useSetPageTitle("Local run");
  const [run, setRun] = useState<LocalRun | null>(null);
  const [manifest, setManifest] = useState<EvalResultManifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manifestProblem, setManifestProblem] = useState<string | null>(null);

  const refresh = useCallback(
    async (signal: AbortSignal) => {
      try {
        const response = await fetch(`/api/models/runs/${encodeURIComponent(runId)}`, {
          cache: "no-store",
          signal,
        });
        if (response.status === 404) {
          setError("This run does not exist on this machine.");
          return;
        }
        if (!response.ok) throw new Error(`status ${response.status}`);
        // POST /api/models/runs and this GET both return the run row itself,
        // not a wrapper.
        const row = (await response.json()) as LocalRun;
        setRun(row);
        setError(null);

        // The run row's `metrics` is a summary; the manifest is the result. Read
        // it through the same reader the cloud screen uses, so a document this
        // build cannot understand is reported rather than silently skipped.
        if (row.status === "succeeded" || row.status === "failed") {
          const manifestResponse = await fetch(
            `/api/simforge/local-runs/${encodeURIComponent(runId)}/result`,
            { cache: "no-store", signal },
          );
          if (manifestResponse.ok) {
            const read = readEvalResultManifest(await manifestResponse.json());
            if (read.ok) {
              setManifest(read.value);
              setManifestProblem(null);
            } else {
              setManifestProblem(`This run's result.json could not be displayed: ${read.reason}`);
            }
          } else if (manifestResponse.status !== 404) {
            setManifestProblem(
              `This run's result.json could not be read (${manifestResponse.status}).`,
            );
          }
        }
      } catch (cause) {
        if (signal.aborted) return;
        setError(`The run could not be read: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    },
    [runId],
  );

  const live = run === null || run.status === "queued" || run.status === "running";
  useVisiblePolling(refresh, POLL_MS, live, runId);

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <PageHeader
        title="Local run"
        description="Executed on this machine by the local model-run worker, using the same result contract as a cloud run."
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href="/dashboard/evaluation">
              <ArrowLeft aria-hidden="true" />
              All runs
            </Link>
          </Button>
        }
      />
      <div className="space-y-6 px-5 py-5 sm:px-6">
        {error ? <RefusalNotice title="Local run" reasons={[error]} /> : null}
        {manifestProblem ? (
          <RefusalNotice tone="warn" title="Result document" reasons={[manifestProblem]} />
        ) : null}

        {run ? (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <Badge variant="outline">{run.status}</Badge>
              <Badge variant="outline">on this machine</Badge>
              {manifest ? <Badge variant="outline">{manifest.mode}</Badge> : null}
              {manifest && !manifest.scored ? <Badge variant="outline">not scored</Badge> : null}
              {manifest?.truncation ? (
                <Badge variant="outline">truncated: {manifest.truncation}</Badge>
              ) : null}
              <span className="font-mono text-xs text-muted-foreground">{run.id}</span>
              {live ? (
                <Loader2 aria-hidden="true" className="size-3.5 animate-spin text-muted-foreground" />
              ) : null}
            </div>

            <dl className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">Kind</dt>
                <dd className="text-foreground">{run.kind}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">Attempts</dt>
                <dd className="text-foreground">
                  {run.attemptCount} of {run.maxAttempts}
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">Seed</dt>
                <dd className="text-foreground">{run.seed}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">Model version</dt>
                <dd className="min-w-0 truncate font-mono text-xs text-foreground">
                  {run.modelVersionId}
                </dd>
              </div>
            </dl>

            {run.status === "failed" ? (
              <RefusalNotice
                title="This run failed"
                reasons={[
                  `The local worker exhausted ${run.attemptCount} of ${run.maxAttempts} attempts. A failed local run keeps its output for diagnosis; it is not a scored result.`,
                ]}
              />
            ) : null}

            {manifest ? (
              <section className="space-y-2">
                <h2 className="text-sm font-semibold text-foreground">Result</h2>
                <dl className="grid gap-x-8 gap-y-1 text-xs sm:grid-cols-3">
                  {Object.entries(manifest.metrics).map(([field, value]) => (
                    <div key={field}>
                      <dt className="uppercase tracking-wide text-muted-foreground">{field}</dt>
                      <dd className="min-w-0 truncate font-mono text-foreground">
                        {typeof value === "object" ? JSON.stringify(value) : String(value)}
                      </dd>
                    </div>
                  ))}
                </dl>
                <p className="text-xs leading-5 text-muted-foreground">
                  {manifest.scored
                    ? "Scored against this input's own reference. These are SimForge metric definitions, not an NVIDIA or AlpaSim benchmark number."
                    : "This run is not scored: no reference future was available, so the numbers above are not a driving score."}
                </p>
              </section>
            ) : null}

            {!manifest && run.metrics && Object.keys(run.metrics).length > 0 ? (
              <section className="space-y-2">
                <h2 className="text-sm font-semibold text-foreground">Metrics (run summary)</h2>
                <dl className="grid gap-x-8 gap-y-1 text-xs sm:grid-cols-3">
                  {Object.entries(run.metrics).map(([field, value]) => (
                    <div key={field}>
                      <dt className="uppercase tracking-wide text-muted-foreground">{field}</dt>
                      <dd className="min-w-0 truncate font-mono text-foreground">
                        {typeof value === "object" ? JSON.stringify(value) : String(value)}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            ) : null}

            {run.outputRefs.length > 0 ? (
              <section className="space-y-2">
                <h2 className="text-sm font-semibold text-foreground">Output on this machine</h2>
                <ul className="divide-y divide-border border border-border text-xs">
                  {run.outputRefs.map((ref, index) => (
                    <li key={index} className="px-3 py-2 font-mono text-muted-foreground">
                      {typeof ref === "string" ? ref : JSON.stringify(ref)}
                    </li>
                  ))}
                </ul>
                <p className="text-xs leading-5 text-muted-foreground">
                  The run writes `result.json` (simforge.eval-result-manifest/v1) last, as its
                  completion marker — the same document a cloud run produces.
                </p>
              </section>
            ) : live ? (
              <p className="inline-flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 aria-hidden="true" className="size-4 animate-spin" />
                Waiting for the local worker to lease and execute this run. Closing this page does
                not stop it.
              </p>
            ) : null}
          </>
        ) : error === null ? (
          <p className="inline-flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 aria-hidden="true" className="size-4 animate-spin" />
            Loading run…
          </p>
        ) : null}
      </div>
    </div>
  );
}
