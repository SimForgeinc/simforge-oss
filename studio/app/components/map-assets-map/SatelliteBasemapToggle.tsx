"use client";
import * as stylex from "@stylexjs/stylex";
import { C } from "./map-layer-constants";
import { styles } from "./map-canvas.stylex";
type SatelliteBasemapToggleProps = { satelliteEnabled: boolean; onChange: (enabled: boolean) => void };
export default function SatelliteBasemapToggle({ satelliteEnabled, onChange }: SatelliteBasemapToggleProps) {
  return <div {...stylex.props(styles.control, styles.satelliteControl, styles.modeControl)}>
    {[{ label: "Map", satellite: false }, { label: "Satellite", satellite: true }].map((option) => {
      const isActive = option.satellite === satelliteEnabled;
      return <button key={option.label} type="button" onClick={() => onChange(option.satellite)} aria-pressed={isActive}
        {...stylex.props(styles.modeButton)}
        style={{ fontWeight: isActive ? 600 : 400, cursor: isActive ? "default" : "pointer", background: isActive ? C.fg : `${C.bg}f2`, color: isActive ? C.bg : C.fg }}>
        {option.label}
      </button>;
    })}
  </div>;
}
