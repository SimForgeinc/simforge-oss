"use client";

import { ScenarioDatasetError } from "@simforge-oss/studio-ui/scenario/route-states";

export default function ScenarioDatasetRouteError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <ScenarioDatasetError {...props} />;
}
