/**
 * StyleX primitives.
 *
 * Additive: nothing here replaces a Tailwind component. Each primitive takes
 * `className` and `style`, so it drops into a Tailwind-classed tree unchanged,
 * and an `xstyle` prop for callers that have gone over to StyleX.
 *
 * Two panels anchor the surface axis — `GlassPanel` (expressive: glass, blur,
 * elevation) and `TechnicalPanel` (technical: opaque, hairline-ruled) — and
 * the content primitives carry the same `surface` prop so a readout or a rule
 * matches whichever pane it lands in.
 *
 * Colours come from `../../stylex/tokens.stylex`; runtime numbers travel as
 * the `--sfx-*` custom properties declared in `./surface`.
 */

export { GlassPanel, type GlassPanelProps, type GlassElevation } from "./GlassPanel";
export {
  TechnicalPanel,
  type TechnicalPanelProps,
  type PanelDensity,
} from "./TechnicalPanel";
export { MetaLabel, type MetaLabelProps, type MetaLabelElement } from "./MetaLabel";
export {
  MetricReadout,
  type MetricReadoutProps,
  type MetricSize,
} from "./MetricReadout";
export { Hairline, type HairlineProps } from "./Hairline";
export {
  StatusIndicator,
  type StatusIndicatorProps,
  type Status,
} from "./StatusIndicator";
export { Progress, type ProgressProps, type ProgressSize } from "./Progress";
export {
  WorldOverlay,
  type WorldOverlayProps,
  type OverlayPlacement,
} from "./WorldOverlay";
export {
  clampFraction,
  cssVars,
  mergeStyleProps,
  type PadStep,
  type SurfaceVariant,
  type Tone,
  type XStyle,
} from "./surface";
