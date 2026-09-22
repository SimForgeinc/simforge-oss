"use client";

import { CloudLoadingSurface } from "../components/CloudLoadingSurface";
import { RouteErrorState } from "../components/state-frames";

type RouteErrorProps = { error: Error & { digest?: string }; reset: () => void };

export function ScenarioIndexLoading() {
  return <ScenarioRouteLoading detail="Loading your scenarios…" label="scenarios" priority={11} />;
}
export function ScenarioDatasetLoading() {
  return <ScenarioRouteLoading detail="Loading dataset scenarios…" label="scenarios" priority={12} />;
}
export function ScenarioEditorLoading() {
  return <ScenarioRouteLoading detail="Preparing the editor…" label="scenario editor" priority={12} />;
}
export function ScenarioReviewLoading() {
  return <ScenarioRouteLoading detail="Loading scenarios to review…" label="review queue" priority={12} />;
}
function ScenarioRouteLoading({ detail, label, priority }: { detail: string; label: string; priority: number }) {
  return <CloudLoadingSurface detail={`Opening ${label} in your workspace.`} priority={priority} progress={null} scope="screen" title={detail} />;
}
function ScenarioError({ error, reset, title, exitHref = "/dashboard/scenario", exitLabel = "Back to datasets" }: RouteErrorProps & { title: string; exitHref?: string; exitLabel?: string }) {
  return <RouteErrorState title={title} description={error.message || "The scenario workspace is temporarily unavailable."} details={error.digest ? `Reference: ${error.digest}` : undefined} onRetry={reset} exitHref={exitHref} exitLabel={exitLabel} />;
}
export function ScenarioSegmentError(props: RouteErrorProps) {
  return <ScenarioError {...props} title="Scenario workspace failed to load" exitHref="/dashboard/apps" exitLabel="Back to Apps" />;
}
export function ScenarioDatasetError(props: RouteErrorProps) {
  return <ScenarioError {...props} title="This dataset could not be loaded" />;
}
export function ScenarioReviewError(props: RouteErrorProps) {
  return <ScenarioError {...props} title="Failed to open the scenario review queue" />;
}
