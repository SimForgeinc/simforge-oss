"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Button } from "../components/ui/button";
import { RouteLoading } from "../components/ui/sim-loader";
import { CopyableErrorMessage } from "./list/CopyableErrorMessage";
import { ScenarioWorkspaceErrorState } from "./editor/status";

/**
 * Everything a host's `loading.tsx` / `error.tsx` under `/dashboard/scenario`
 * renders. Hosts keep the Next route files themselves (they own auth and
 * segment config) and mount these so both products fail and load identically.
 */

type RouteErrorProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

export function ScenarioIndexLoading() {
  return <RouteLoading label="Scenarios" detail="Loading your scenarios…" />;
}

export function ScenarioDatasetLoading() {
  return <RouteLoading depth={2} label="Scenarios" detail="Loading dataset scenarios…" />;
}

export function ScenarioEditorLoading() {
  return <RouteLoading depth={2} label="Scenario editor" detail="Preparing the editor…" />;
}

export function ScenarioReviewLoading() {
  return <RouteLoading depth={2} label="Review queue" detail="Loading scenarios to review…" />;
}

/**
 * Segment-root error boundary — manifest item 171.
 *
 * Two things happen here, and they are not redundant. The visible block is what a user reads and acts
 * on. `ScenarioWorkspaceErrorState` renders nothing: it publishes the same failure into the workspace
 * status stream as a blocking error, which is what the boot gate paints and what any other surface
 * listening to the stream can see.
 *
 * `statusKey` is stable per boundary rather than derived from the message, so a retry that fails again
 * replaces the entry instead of stacking a second one that says the same thing.
 */
export function ScenarioSegmentError({ error, reset }: RouteErrorProps) {
  const detail = error.message || "The scenario workspace is temporarily unavailable.";

  return (
    <div className="mx-auto flex min-h-64 max-w-3xl flex-col items-center justify-center px-6 text-center">
      <ScenarioWorkspaceErrorState
        statusKey="scenario:segment-error"
        label="Scenario workspace failed to load"
        detail={detail}
        actionHref={null}
      />
      <h2 className="text-lg font-semibold">Scenario workspace failed to load</h2>
      <p className="mt-2 text-sm text-muted-foreground">{detail}</p>
      {/*
        `error.digest` is the only handle on the server-side stack, and it is the one thing a user can
        usefully quote in a report. Rendered only when present — an empty "Reference:" line reads as
        something having gone wrong with the error page itself.
      */}
      {error.digest ? (
        <p className="mt-1 font-mono text-micro text-muted-foreground">Reference: {error.digest}</p>
      ) : null}
      <Button className="mt-5" type="button" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}

/**
 * The dataset list's own error boundary.
 *
 * Without one, a throw in the server read escapes to the dashboard boundary, which knows nothing about
 * this route and offers no way back to the dataset index. The `digest` is the only handle a bug report
 * can use to find the server-side trace, so it is copyable.
 */
export function ScenarioDatasetError({ error, reset }: RouteErrorProps) {
  useEffect(() => {
    console.error("[scenario] dataset list failed", error);
  }, [error]);

  return (
    <section className="flex h-full min-h-0 flex-col items-center justify-center gap-4 bg-background p-6 text-foreground">
      <div className="w-full max-w-lg space-y-3">
        <h1 className="font-display text-lg font-semibold">This dataset could not be loaded.</h1>
        <CopyableErrorMessage
          message={error.message || "The scenario list failed to load."}
          copyText={error.digest ? `${error.message}\ndigest: ${error.digest}` : error.message}
        />
        <div className="flex gap-2">
          <Button type="button" onClick={reset}>
            Try again
          </Button>
          <Button asChild variant="outline">
            <Link href="/dashboard/scenario">Back to datasets</Link>
          </Button>
        </div>
      </div>
    </section>
  );
}

export function ScenarioReviewError({ error, reset }: RouteErrorProps) {
  return (
    <div className="mx-auto flex min-h-64 max-w-3xl flex-col items-center justify-center px-6 text-center">
      <h2 className="text-lg font-semibold">Failed to open the scenario review queue</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        {error.message || "The review queue is temporarily unavailable."}
      </p>
      <Button className="mt-5" type="button" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
