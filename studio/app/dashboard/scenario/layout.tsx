import type { ReactNode } from "react";
import { ScenarioWorkspaceStatusProvider } from "@simforge-oss/studio-ui/scenario/editor/status";

// The segment owns the status stream; the dashboard owns the retained world.
export const instant = false;

/** Mount once per scenario segment: duplicate providers would duplicate docks and blockers. */
export default function ScenarioLayout({ children }: { children: ReactNode }) {
  return <ScenarioWorkspaceStatusProvider>{children}</ScenarioWorkspaceStatusProvider>;
}
