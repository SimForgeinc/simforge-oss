"use client";

import * as stylex from "@stylexjs/stylex";
import { SignalLow, SignalHigh, SignalMedium } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  saveRenderingPreference,
  useRenderingPreference,
  RENDERING_PREFERENCE_CHOICES,
  type RenderingPreference,
} from "@simforge-oss/studio-ui/components/rendering-preference";
import { styles } from "@/app/components/AppSwitcherOverlay.stylex";

/**
 * One icon per level, lowest to highest, so the button shows where the
 * preference sits without spending a row on labels.
 */
const LEVEL_ICONS: Record<RenderingPreference, LucideIcon> = {
  "low-no-foliage": SignalLow,
  low: SignalMedium,
  medium: SignalHigh,
};

/**
 * The graphics level as a single button: it shows the saved level and clicking
 * advances to the next one, wrapping at the top. Writing the shared preference
 * is what every open viewport follows live (scene, editor and drive all
 * subscribe), so the level changes where the user is rather than on the next
 * page.
 */
export function AppSwitcherGraphicsLevel() {
  const preference = useRenderingPreference() ?? "low";
  const levels = RENDERING_PREFERENCE_CHOICES;
  const at = levels.findIndex((choice) => choice.id === preference);
  const current = levels.find((choice) => choice.id === preference)!;
  const next = levels[(Math.max(at, 0) + 1) % levels.length]!;
  const Icon = LEVEL_ICONS[current.id];

  return (
    <button
      aria-label={`Graphics level: ${current.label}. Switch to ${next.label}.`}
      {...stylex.props(styles.graphicsButton)}
      data-quality={current.id}
      data-testid="app-switcher-graphics-level"
      onClick={() => saveRenderingPreference(next.id)}
      title={`Graphics level: ${current.label} — ${current.description} Click for ${next.label}.`}
      type="button"
    >
      <Icon {...stylex.props(styles.graphicsIcon)} aria-hidden="true" />
    </button>
  );
}
