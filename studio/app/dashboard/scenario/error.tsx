"use client";

import { ScenarioSegmentError } from "@simforge-oss/studio-ui/scenario/route-states";

export default function ScenarioError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <ScenarioSegmentError {...props} />;
}
