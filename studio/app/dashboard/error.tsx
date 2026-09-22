"use client";

import { RouteErrorState } from "@simforge-oss/studio-ui/components/state-frames";

export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteErrorState title="This page couldn’t load" description={error.message || "An unexpected error occurred while opening this page."} details={error.digest ? `Reference: ${error.digest}` : undefined} onRetry={reset} />;
}
