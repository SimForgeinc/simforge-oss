"use client";

import { ScenarioReviewError } from "@simforge-oss/studio-ui/scenario/route-states";

export default function ScenarioReviewRouteError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <ScenarioReviewError {...props} />;
}
