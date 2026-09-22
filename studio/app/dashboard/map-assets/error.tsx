"use client";

import { RouteErrorState } from "@simforge-oss/studio-ui/components/state-frames";

export default function MapAssetsError({ error, reset }: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteErrorState title="Failed to load map assets" description={error.message || "Could not fetch map asset data."} details={error.digest} onRetry={reset} />;
}
