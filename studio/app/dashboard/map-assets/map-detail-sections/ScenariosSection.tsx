"use client";
import * as stylex from "@stylexjs/stylex";
import { styles } from "../map-assets.stylex";

import { ChevronRight, SquarePen } from "lucide-react";
import Link from "next/link";
import { ScenarioStatusBadge } from "@/app/components/ScenarioStatusBadge";
import { formatRelativeTime } from "@/app/lib/media-utils";
import { buildDashboardScenarioEditorHref } from "@/app/lib/scenario/routes";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@simforge-oss/studio-ui/components/ui/tooltip";
import type { ScenarioSummary } from "@/app/lib/scenarios";

/** Props for the ScenariosSection component. */
type ScenariosSectionProps = {
  open: boolean;
  onToggleOpen: () => void;
  scenarios: ScenarioSummary[];
  variant: "view" | "select-for-simulation";
  mapName?: string | null;
};

/** Display related scenarios for a map asset with links and status badges. */
export function ScenariosSection({
  open,
  onToggleOpen,
  scenarios,
  variant,
  mapName,
}: ScenariosSectionProps) {
  const primaryEditorHref =
    variant === "view" && scenarios.length > 0
      ? buildDashboardScenarioEditorHref({ scenarioId: scenarios[0]!.id, mapName })
      : null;

  return (
    <section>
      <div className={stylex.props(styles.s_961).className}>
        <button
          type="button"
          onClick={onToggleOpen}
          className={stylex.props(styles.s_962).className}
          aria-expanded={open}
        >
          <ChevronRight
            className={stylex.props(styles.chevron, open && styles.rotate90).className}
          />
          Scenarios ({scenarios.length})
        </button>
        {primaryEditorHref && (
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Link
                  href={primaryEditorHref}
                  className={stylex.props(styles.s_388).className}
                  aria-label="Open latest scenario in editor"
                >
                  <SquarePen className={stylex.props(styles.s_927).className} />
                </Link>
              </TooltipTrigger>
              <TooltipContent side="left" xstyle={styles.s_948}>
                Open latest scenario in editor
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>
      {open &&
        (scenarios.length === 0 ? (
          <p className={stylex.props(styles.s_818).className}>No scenarios yet.</p>
        ) : (
          <ul className={stylex.props(styles.s_819).className}>
            {scenarios.map((scenario) => (
              <li
                key={scenario.id}
                className={stylex.props(styles.s_393).className}
              >
                <div className={stylex.props(styles.s_919).className}>
                  <Link
                    href={buildDashboardScenarioEditorHref({
                      scenarioId: scenario.id,
                      mapName,
                    })}
                    className={stylex.props(styles.s_395).className}
                  >
                    {scenario.displayName}
                  </Link>
                  <span
                    className={stylex.props(styles.s_973).className}
                    title={new Date(scenario.createdAt).toLocaleString(undefined, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  >
                    {formatRelativeTime(scenario.createdAt)}
                  </span>
                </div>
                <ScenarioStatusBadge status={scenario.status} />
              </li>
            ))}
          </ul>
        ))}
    </section>
  );
}
