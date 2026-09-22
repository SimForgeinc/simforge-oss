import * as stylex from "@stylexjs/stylex";
import { colors, layers, radii, space, text } from "../stylex/tokens.stylex";

const spin = stylex.keyframes({ from: { transform: "rotate(0deg)" }, to: { transform: "rotate(360deg)" } });
const shimmer = stylex.keyframes({ "0%": { transform: "translateX(-100%)" }, "100%": { transform: "translateX(400%)" } });

/**
 * One loading plate: spinner, title, detail, progress. Sized so the title is
 * the first thing read on a full screen; the pane scope uses the same
 * proportions at the same size, and the plate never exceeds the viewport.
 */
export const styles = stylex.create({
  root: { isolation: "isolate", overflow: "hidden", minWidth: 0, minHeight: 0, backgroundColor: colors.panelSolid, color: colors.ink },
  screen: { position: "fixed", inset: 0, zIndex: layers.loading, minHeight: "100dvh" },
  pane: { position: "relative", height: "100%", minHeight: 0, minWidth: 0, width: "100%" },
  embedded: { position: "absolute", inset: 0 },
  /** Anchors the diagnostics dropdown under the telemetry plate. */
  diagnostics: { position: "relative", marginTop: "0.75rem" },
  wrap: { position: "relative", zIndex: 10, display: "grid", minHeight: "100%", placeItems: "center", paddingInline: "1.25rem", paddingBlock: "2.5rem" },
  paneWrap: { padding: space.s4 },
  paneContent: { width: "100%", maxWidth: "540px" },
  fullContent: { width: "min(540px, calc(100vw - 2rem))", paddingInline: "1.75rem", paddingBlock: "1.75rem", "@media (min-width: 640px)": { paddingInline: "2.5rem", paddingBlock: "2.25rem" } },
  row: { display: "flex", alignItems: "flex-start", gap: "1.25rem" },
  icon: { display: "grid", width: "3rem", height: "3rem", flexShrink: 0, placeItems: "center", color: colors.accent },
  spin: { width: "1.625rem", height: "1.625rem", animationName: { default: spin, "@media (prefers-reduced-motion: reduce)": "none" }, animationDuration: "1s", animationTimingFunction: "linear", animationIterationCount: "infinite" },
  body: { minWidth: 0, flex: 1 },
  title: { fontWeight: 600, letterSpacing: "-0.025em", color: "white" },
  titlePane: { fontSize: text.sizeSm, lineHeight: text.lineNormal, marginTop: 0 },
  titleFull: { fontSize: "1.5625rem", lineHeight: "2rem", marginTop: "0.5rem" },
  detail: { marginTop: "0.625rem", fontSize: "1.0625rem", lineHeight: "1.5rem", color: "rgb(255 255 255 / 55%)" },
  progressWrap: { marginTop: "1.875rem" },
  progressTrack: { height: "0.5rem", overflow: "hidden", borderRadius: radii.none, backgroundColor: colors.fillStrong },
  progressFill: { height: "100%", backgroundColor: colors.accent, transitionProperty: "width", transitionDuration: "300ms", transitionTimingFunction: "ease-out" },
  shimmer: { height: "100%", width: { default: "33.333%", "@media (prefers-reduced-motion: reduce)": "100%" }, backgroundColor: colors.accent, animationName: { default: shimmer, "@media (prefers-reduced-motion: reduce)": "none" }, animationDuration: "1.5s", animationTimingFunction: "ease-in-out", animationIterationCount: "infinite" },
  progressMeta: { marginTop: "0.625rem", display: "flex", justifyContent: "flex-end", fontFamily: text.fontMono, fontSize: "12px", textTransform: "uppercase", letterSpacing: "0.12em", color: "rgb(255 255 255 / 35%)" },
  telemetry: { marginTop: "1.25rem", borderRadius: "0.75rem", borderWidth: 1, paddingInline: "1rem", paddingBlock: "0.75rem", fontFamily: text.fontMono, fontSize: "13px", color: "rgb(255 255 255 / 65%)", backgroundColor: "rgb(0 0 0 / 15%)", borderColor: "rgb(255 255 255 / 8%)" },
  telemetryStalled: { borderColor: "rgb(252 211 77 / 25%)", backgroundColor: "rgb(252 211 77 / 10%)", color: "rgb(254 243 199)" },
  telemRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem" },
  telemGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(7.5rem, 1fr))", gap: "0.5rem 1rem", marginTop: "0.75rem", marginBottom: 0, paddingTop: "0.75rem", borderTopWidth: 1, borderTopStyle: "solid", borderTopColor: "rgb(255 255 255 / 8%)" },
  telemMetric: { display: "flex", flexDirection: "column", gap: "0.125rem", minWidth: 0 },
  telemLabel: { fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.1em", color: "rgb(255 255 255 / 40%)" },
  telemValue: { margin: 0, fontSize: "13px", fontVariantNumeric: "tabular-nums", color: "rgb(255 255 255 / 85%)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  telemText: { marginTop: "0.5rem", fontSize: "12px", textTransform: "uppercase", letterSpacing: "0.1em", color: "rgb(255 255 255 / 45%)" },
  telemWarn: { marginTop: "0.5rem", fontSize: "12px", textTransform: "uppercase", letterSpacing: "0.1em", color: "rgb(254 243 199 / 70%)" },
  activity: { display: "inline-flex", alignItems: "center", gap: "0.5rem" },
  activityIcon: { width: "0.875rem", height: "0.875rem", flexShrink: 0, color: colors.accent, animationName: { default: spin, "@media (prefers-reduced-motion: reduce)": "none" }, animationDuration: "1s", animationTimingFunction: "linear", animationIterationCount: "infinite" },
});
