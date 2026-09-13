"use client";
import * as stylex from "@stylexjs/stylex";
import { styles } from "../map-assets.stylex";

import { useCallback, useState } from "react";
import { Building2, Check, Sun, Trash2, TreePine } from "lucide-react";
import { clearMapAssetCache } from "@simforge-oss/studio-ui/lib/maps/frontend/map-asset-cache";
import {
  readRenderingPreference,
  saveRenderingPreference,
  type RenderingPreference,
} from "@simforge-oss/studio-ui/components/rendering-preference";

const QUALITY_OPTIONS: Array<{ value: RenderingPreference; label: string }> = [
  { value: "roads-only", label: "Roads" },
  { value: "ultra-low-3d", label: "Low" },
  { value: "minimal", label: "Balanced" },
  { value: "high", label: "High" },
];

/** Controls shared authoring quality for the packaged @simforge-oss/viewer. */
export function DigitalTwinLayersPanel() {
  const [quality, setQuality] = useState<RenderingPreference>(
    () => readRenderingPreference() ?? "minimal",
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
    <div className={stylex.props(styles.s_426).className}>
      {/* `space-y-1.5` lives on the children here: the label is an inline
          `<span>`, so a flex column would blockify it and change its line box. */}
      <div>
        <span className={stylex.props(styles.s_636).className}>Render quality</span>
        <div className={stylex.props(styles.s_429, styles.stackY1_5).className}>
          {QUALITY_OPTIONS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              onClick={() => chooseQuality(value)}
              className={
                stylex.props(
                  styles.qualitySegment,
                  quality === value ? styles.qualitySegmentActive : styles.qualitySegmentInactive,
                ).className
              }
            >
              {label}
            </button>
          ))}
        </div>
        <p className={stylex.props(styles.s_430, styles.stackY1_5).className}>
          Changes apply to the shared scenario-editor and digital-twin viewer on reload.
        </p>
      </div>

      <div className={stylex.props(styles.s_431).className}>
        <LayerStatus icon={Building2} label="Streamed city geometry and road surface" />
        <LayerStatus icon={TreePine} label="Distance-admitted vegetation" />
        <LayerStatus icon={Sun} label="Sky, sun shadows, and street luminaires" />
      </div>

      <button
        type="button"
        onClick={handleClearCache}
        disabled={cacheState === "clearing"}
        className={stylex.props(styles.s_432).className}
      >
        <Trash2 className={stylex.props(styles.s_927).className} />
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
    <div className={stylex.props(styles.s_434).className}>
      <Icon className={stylex.props(styles.s_435).className} />
      <span className={stylex.props(styles.s_436).className}>{label}</span>
      <Check className={stylex.props(styles.s_496).className} />
    </div>
  );
}
