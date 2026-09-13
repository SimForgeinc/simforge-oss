"use client";

import * as stylex from "@stylexjs/stylex";
import { styles } from "./map-canvas.stylex";

type SatelliteBasemapToggleProps = {
  satelliteEnabled: boolean;
  onChange: (enabled: boolean) => void;
};

const OPTIONS = [
  { label: "Map", satellite: false },
  { label: "Satellite", satellite: true },
];

/**
 * Map / Satellite basemap switch, shown only when the viewed map asset has a
 * SimScene imagery tileset configured.
 */
export default function SatelliteBasemapToggle({
  satelliteEnabled,
  onChange,
}: SatelliteBasemapToggleProps) {
  return (
    <div {...stylex.props(styles.control, styles.basemapControl)}>
      {OPTIONS.map((option) => {
        const isActive = option.satellite === satelliteEnabled;
        return (
          <button
            key={option.label}
            type="button"
            onClick={() => onChange(option.satellite)}
            aria-pressed={isActive}
            {...stylex.props(
              styles.basemapButton,
              isActive ? styles.segmentActive : styles.segmentInactive,
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
