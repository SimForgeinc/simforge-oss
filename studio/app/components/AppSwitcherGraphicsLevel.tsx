"use client";

import * as stylex from "@stylexjs/stylex";
import { MonitorCog } from "lucide-react";
import {
  saveRenderingPreference,
  useRenderingPreference,
} from "@simforge-oss/studio-ui/components/rendering-preference";
import { SCENARIO_AUTHORING_QUALITY_CHOICES } from "@simforge-oss/studio-ui/lib/scenario/contracts";
import { styles } from "@/app/components/AppSwitcherOverlay.stylex";

/**
 * The graphics level, right in the app switcher: one button per level, the
 * saved one lit. Choosing writes the shared preference, which every open
 * viewport follows live (scene, editor and drive all subscribe), so the level
 * changes where the user is rather than on the next page.
 */
export function AppSwitcherGraphicsLevel() {
  const preference = useRenderingPreference() ?? "high";
  return (
    <div {...stylex.props(styles.graphics)} data-testid="app-switcher-graphics-level">
      <div {...stylex.props(styles.graphicsHead)}>
        <MonitorCog {...stylex.props(styles.workspaceIcon)} aria-hidden="true" />
        <p {...stylex.props(styles.workspaceLabel, styles.graphicsLabel)}>Graphics level</p>
      </div>
      <div
        aria-label="Graphics level"
        role="radiogroup"
        {...stylex.props(styles.utilities, styles.utilityColumns(SCENARIO_AUTHORING_QUALITY_CHOICES.length))}
      >
        {SCENARIO_AUTHORING_QUALITY_CHOICES.map((choice) => {
          const active = choice.id === preference;
          return (
            <button
              aria-checked={active}
              {...stylex.props(styles.utility, active ? styles.utilityActive : styles.utilityIdle)}
              data-quality={choice.id}
              key={choice.id}
              onClick={() => {
                if (!active) saveRenderingPreference(choice.id);
              }}
              role="radio"
              title={choice.gpuMemoryGuidance}
              type="button"
            >
              {choice.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
