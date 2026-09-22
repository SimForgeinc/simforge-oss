"use client";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./DigitalTwinLayersPanel.stylex";

import { useCallback, useState } from "react";
import { Building2, Check, Sun, Trash2, TreePine } from "lucide-react";
import { clearMapAssetCache } from "@simforge-oss/studio-ui/lib/maps/frontend/map-asset-cache";
import {
  readRenderingPreference,
  saveRenderingPreference,
  type RenderingPreference,
} from "@simforge-oss/studio-ui/components/rendering-preference";

const QUALITY_OPTIONS: Array<{ value: RenderingPreference; label: string }> = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
];

/** Controls shared authoring quality for the packaged @simforge-oss/viewer. */
export function DigitalTwinLayersPanel() {
  const [quality, setQuality] = useState<RenderingPreference>(
    () => readRenderingPreference() ?? "low",
  );
  const [cacheState, setCacheState] = useState<"idle" | "clearing" | "cleared">("idle");

  const handleClearCache = useCallback(async () => {
    setCacheState("clearing");
    await clearMapAssetCache();
    setCacheState("cleared");
    window.setTimeout(() => setCacheState("idle"), 2500);
  }, []);

  const chooseQuality = (next: RenderingPreference) => {
    setQuality(next);
    saveRenderingPreference(next);
  };

  return (
    <div {...stylex.props(styles.panel)}>
      {/* `space-y-1.5` lives on the children here: the label is an inline
          `<span>`, so a flex column would blockify it and change its line box. */}
      <div>
        <span {...stylex.props(styles.qualityLabel)}>Render quality</span>
        <div {...stylex.props(styles.qualityOptions, styles.stackY1_5)}>
          {QUALITY_OPTIONS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              onClick={() => chooseQuality(value)}
              {...stylex.props(
                  styles.qualitySegment,
                  quality === value ? styles.qualitySegmentActive : styles.qualitySegmentInactive,
                )}
            >
              {label}
            </button>
          ))}
        </div>
        <p {...stylex.props(styles.qualityDescription, styles.stackY1_5)}>
          Changes apply to the shared scenario-editor and digital-twin viewer on reload.
        </p>
      </div>

      <div {...stylex.props(styles.layerStatusList)}>
        <LayerStatus icon={Building2} label="Streamed city geometry and road surface" />
        <LayerStatus icon={TreePine} label="Distance-admitted vegetation" />
        <LayerStatus icon={Sun} label="Sky, sun shadows, and street luminaires" />
      </div>

      <button
        type="button"
        onClick={handleClearCache}
        disabled={cacheState === "clearing"}
        {...stylex.props(styles.clearCacheButton)}
      >
        <Trash2 {...stylex.props(styles.clearCacheIcon)} />
        {cacheState === "clearing"
          ? "Clearing cache…"
          : cacheState === "cleared"
            ? "Cache cleared"
            : "Clear downloaded map cache"}
      </button>
    </div>
  );
}

function LayerStatus({
  icon: Icon,
  label,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}) {
  return (
    <div {...stylex.props(styles.layerStatusRow)}>
      <Icon {...stylex.props(styles.layerIcon)} />
      <span {...stylex.props(styles.layerLabel)}>{label}</span>
      <Check {...stylex.props(styles.layerCheckIcon)} />
    </div>
  );
}
