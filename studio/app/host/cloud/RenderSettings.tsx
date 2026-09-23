"use client";

import * as stylex from "@stylexjs/stylex";
import { DEFAULT_RENDERING_PREFERENCE, useRenderingPreference, saveRenderingPreference } from "@simforge-oss/studio-ui/components/rendering-preference";
import { MapAssetCacheStorage } from "@simforge-oss/studio-ui/components/MapAssetCacheStorage";
import { RenderSelectionPanel } from "@simforge-oss/studio-ui/render-selection/RenderSelectionPanel";
import { styles } from "@/app/components/render-settings.stylex";
import type { RenderSettingsProps } from "@/app/host/contract";

/**
 * Browser graphics and this browser's map cache (usage, budget and an explicit
 * clear); managed job quality is independent.
 */
export function RenderSettings(_props: RenderSettingsProps) {
  const preference = useRenderingPreference();
  return (
    <div {...stylex.props(styles.root)} data-testid="render-settings-panel">
      <RenderSelectionPanel
        currentQuality={preference ?? DEFAULT_RENDERING_PREFERENCE}
        onChoose={saveRenderingPreference}
        titleId="render-settings-title"
        descriptionId="render-settings-description"
        footer={<MapAssetCacheStorage compact refreshKey={preference} />}
      />
    </div>
  );
}
