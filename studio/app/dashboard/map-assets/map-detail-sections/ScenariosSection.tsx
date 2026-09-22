"use client";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./ScenariosSection.stylex";

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
import { hairline, motionRecipe, textLayout, typography } from "@simforge-oss/studio-ui/stylex/recipes.stylex";

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
      <div {...stylex.props(styles.sectionHeader)}>
        <button
          type="button"
          onClick={onToggleOpen}
          {...stylex.props([motionRecipe.colors, [typography.caps, styles.scenarioToggle]])}
          aria-expanded={open}
        >
          <ChevronRight
            {...stylex.props([motionRecipe.transform, styles.chevron], open && styles.rotate90)}
          />
          Scenarios ({scenarios.length})
        </button>
        {primaryEditorHref && (
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Link
                  href={primaryEditorHref}
                  {...stylex.props([motionRecipe.colors, styles.editorLink])}
                  aria-label="Open latest scenario in editor"
                >
                  <SquarePen {...stylex.props(styles.editorIcon)} />
                </Link>
              </TooltipTrigger>
              <TooltipContent side="left" xstyle={styles.editorTooltip}>
                Open latest scenario in editor
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>
      {open &&
        (scenarios.length === 0 ? (
          <p {...stylex.props(styles.emptyState)}>No scenarios yet.</p>
        ) : (
          <ul {...stylex.props(styles.scenarioList)}>
            {scenarios.map((scenario) => (
              <li
                key={scenario.id}
                {...stylex.props([hairline.all, styles.scenarioItem])}
              >
                <div {...stylex.props(styles.scenarioDetails)}>
                  <Link
                    href={buildDashboardScenarioEditorHref({
                      scenarioId: scenario.id,
                      mapName,
                    })}
                    {...stylex.props([textLayout.truncate, styles.scenarioLink])}
                  >
                    {scenario.displayName}
                  </Link>
                  <span
                    {...stylex.props(styles.scenarioTimestamp)}
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
