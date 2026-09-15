"use client";

import * as stylex from "@stylexjs/stylex";
import { SignalHigh, SignalLow, SignalMedium, SignalZero } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  saveRenderingPreference,
  useRenderingPreference,
} from "@simforge-oss/studio-ui/components/rendering-preference";
import {
  SCENARIO_AUTHORING_QUALITY_CHOICES,
  type ScenarioAuthoringQuality,
} from "@simforge-oss/studio-ui/lib/scenario/contracts";
import { styles } from "@/app/components/AppSwitcherOverlay.stylex";

/**
 * One icon for the four levels, lowest to highest, so the button shows where
 * the preference sits without spending a row on labels.
 */
const LEVEL_ICONS: Record<ScenarioAuthoringQuality, LucideIcon> = {
  "roads-only": SignalZero,
  "ultra-low-3d": SignalLow,
  minimal: SignalMedium,
  high: SignalHigh,
};

/**
 * The graphics level as a single button: it shows the saved level and clicking
 * advances to the next one, wrapping at the top. Writing the shared preference
 * is what every open viewport follows live (scene, editor and drive all
 * subscribe), so the level changes where the user is rather than on the next
 * page.
 */
export function AppSwitcherGraphicsLevel() {
  const preference = useRenderingPreference() ?? "high";
  const levels = SCENARIO_AUTHORING_QUALITY_CHOICES;
  const at = levels.findIndex((choice) => choice.id === preference);
  const current = levels[at] ?? levels[0];
  const next = levels[(Math.max(at, 0) + 1) % levels.length] ?? levels[0];
  const Icon = LEVEL_ICONS[current.id];

  return (
    <button
      aria-label={`Graphics level: ${current.label}. Switch to ${next.label}.`}
      {...stylex.props(styles.graphicsButton)}
      data-quality={current.id}
      data-testid="app-switcher-graphics-level"
      onClick={() => saveRenderingPreference(next.id)}
      title={`Graphics level: ${current.label} — ${current.gpuMemoryGuidance}. Click for ${next.label}.`}
      type="button"
    >
      <Icon {...stylex.props(styles.graphicsIcon)} aria-hidden="true" />
    </button>
  );
}
