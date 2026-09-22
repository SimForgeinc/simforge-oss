import * as stylex from "@stylexjs/stylex";
import { colors, layers, layout, motion, radii, space, stroke, text } from "../stylex/tokens.stylex";

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
  diagnostics: { position: "relative", marginTop: space.s3 },
  wrap: { position: "relative", zIndex: layers.raised, display: "grid", minHeight: "100%", placeItems: "center", paddingInline: space.s5, paddingBlock: space.s10 },
  paneWrap: { padding: space.s4 },
  paneContent: { width: "100%", maxWidth: "540px" },
  fullContent: { width: "min(540px, calc(100vw - 2rem))", paddingInline: space.s7, paddingBlock: space.s7, "@media (min-width: 640px)": { paddingInline: space.s10, paddingBlock: "2.25rem" } },
  row: { display: "flex", alignItems: "flex-start", gap: space.s5 },
  icon: { display: "grid", width: "3rem", height: "3rem", flexShrink: 0, placeItems: "center", color: colors.accent },
  spin: { width: "1.625rem", height: "1.625rem", animationName: { default: spin, [layout.reducedMotion]: "none" }, animationDuration: motion.durSpin, animationTimingFunction: motion.easeLinear, animationIterationCount: "infinite" },
  body: { minWidth: 0, flex: 1 },
  title: { fontWeight: text.weightSemibold, letterSpacing: text.trackingTight, color: colors.ink },
  titlePane: { fontSize: text.sizeSm, lineHeight: text.lineNormal, marginTop: 0 },
  titleFull: { fontSize: "1.5625rem", lineHeight: text.lineXl, marginTop: space.s2 },
  detail: { marginTop: space.s2_5, fontSize: "1.0625rem", lineHeight: text.lineBase, color: "rgb(255 255 255 / 55%)" },
  progressWrap: { marginTop: "1.875rem" },
  progressTrack: { height: "0.5rem", overflow: "hidden", borderRadius: radii.none, backgroundColor: colors.fillStrong },
  progressFill: { height: "100%", backgroundColor: colors.accent, transitionProperty: "width", transitionDuration: "300ms", transitionTimingFunction: motion.easeOut },
  shimmer: { height: "100%", width: { default: "33.333%", [layout.reducedMotion]: "100%" }, backgroundColor: colors.accent, animationName: { default: shimmer, [layout.reducedMotion]: "none" }, animationDuration: "1.5s", animationTimingFunction: motion.easeInOut, animationIterationCount: "infinite" },
  progressMeta: { marginTop: space.s2_5, display: "flex", justifyContent: "flex-end", fontFamily: text.fontMono, fontSize: "12px", textTransform: "uppercase", letterSpacing: text.trackingMetaTight, color: colors.inkFaint },
  telemetry: { marginTop: space.s5, borderRadius: "0.75rem", borderWidth: stroke.hairline, paddingInline: space.s4, paddingBlock: space.s3, fontFamily: text.fontMono, fontSize: "13px", color: "rgb(255 255 255 / 65%)", backgroundColor: "rgb(0 0 0 / 15%)", borderColor: colors.hairline },
  telemetryStalled: { borderColor: "rgb(252 211 77 / 25%)", backgroundColor: colors.warningWash, color: "rgb(254 243 199)" },
  telemRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: space.s4 },
  telemGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(7.5rem, 1fr))", gap: "0.5rem 1rem", marginTop: space.s3, marginBottom: 0, paddingTop: space.s3, borderTopWidth: stroke.hairline, borderTopStyle: "solid", borderTopColor: colors.hairline },
  telemMetric: { display: "flex", flexDirection: "column", gap: space.s0_5, minWidth: 0 },
  telemLabel: { fontSize: "10px", textTransform: "uppercase", letterSpacing: text.trackingMetaNarrow, color: "rgb(255 255 255 / 40%)" },
  telemValue: { margin: 0, fontSize: "13px", fontVariantNumeric: "tabular-nums", color: "rgb(255 255 255 / 85%)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  telemText: { marginTop: space.s2, fontSize: "12px", textTransform: "uppercase", letterSpacing: text.trackingMetaNarrow, color: colors.inkMuted },
  telemWarn: { marginTop: space.s2, fontSize: "12px", textTransform: "uppercase", letterSpacing: text.trackingMetaNarrow, color: "rgb(254 243 199 / 70%)" },
  activity: { display: "inline-flex", alignItems: "center", gap: space.s2 },
  activityIcon: { width: "0.875rem", height: "0.875rem", flexShrink: 0, color: colors.accent, animationName: { default: spin, [layout.reducedMotion]: "none" }, animationDuration: motion.durSpin, animationTimingFunction: motion.easeLinear, animationIterationCount: "infinite" },
});
