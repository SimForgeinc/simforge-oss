import * as stylex from "@stylexjs/stylex";
import { colors, text } from "../stylex/tokens.stylex";

const spin = stylex.keyframes({ from: { transform: "rotate(0deg)" }, to: { transform: "rotate(360deg)" } });
const shimmer = stylex.keyframes({ "0%": { transform: "translateX(-100%)" }, "100%": { transform: "translateX(400%)" } });

/**
 * One loading plate: spinner, title, detail, progress. Sized so the title is
 * the first thing read on a full screen; the pane scope uses the same
 * proportions at the same size, and the plate never exceeds the viewport.
 */
export const styles = stylex.create({
  root: { isolation: "isolate", overflow: "hidden", backgroundColor: "black", color: "white" },
  screen: { position: "fixed", inset: 0, zIndex: 240, minHeight: "100dvh" },
  pane: { position: "relative", height: "100%", minHeight: "14rem", width: "100%" },
  embedded: { position: "absolute", inset: 0 },
  withDiagnostics: { display: "flex", flexDirection: "column", overflow: "auto" },
  diagnosticsWrap: { flex: "1 0 auto", minHeight: 0 },
  wrap: { position: "relative", zIndex: 10, display: "grid", minHeight: "100%", placeItems: "center", paddingInline: "1.25rem", paddingBlock: "2.5rem" },
  paneContent: { width: "100%", maxWidth: "540px", paddingInline: "1.5rem", paddingBlock: "1.75rem" },
  fullContent: { width: "min(540px, calc(100vw - 2rem))", paddingInline: "1.75rem", paddingBlock: "1.75rem", "@media (min-width: 640px)": { paddingInline: "2.5rem", paddingBlock: "2.25rem" } },
  row: { display: "flex", alignItems: "flex-start", gap: "1.25rem" },
  icon: { display: "grid", width: "3rem", height: "3rem", flexShrink: 0, placeItems: "center", color: colors.accent },
  spin: { width: "1.625rem", height: "1.625rem", animationName: { default: spin, "@media (prefers-reduced-motion: reduce)": "none" }, animationDuration: "1s", animationTimingFunction: "linear", animationIterationCount: "infinite" },
  body: { minWidth: 0, flex: 1 },
  title: { fontWeight: 600, letterSpacing: "-0.025em", color: "white" },
  titlePane: { fontSize: "1.375rem", lineHeight: "1.875rem", marginTop: "0.5rem" },
  titleFull: { fontSize: "1.5625rem", lineHeight: "2rem", marginTop: "0.5rem" },
  detail: { marginTop: "0.625rem", fontSize: "1.0625rem", lineHeight: "1.5rem", color: "rgb(255 255 255 / 55%)" },
  progressWrap: { marginTop: "1.875rem" },
  progressTrack: { height: "0.5rem", overflow: "hidden", borderRadius: "9999px", backgroundColor: "rgb(255 255 255 / 10%)" },
  progressFill: { height: "100%", borderRadius: "9999px", backgroundColor: colors.accent, transitionProperty: "width", transitionDuration: "300ms", transitionTimingFunction: "ease-out" },
  shimmer: { height: "100%", width: { default: "33.333%", "@media (prefers-reduced-motion: reduce)": "100%" }, borderRadius: "9999px", backgroundColor: colors.accent, animationName: { default: shimmer, "@media (prefers-reduced-motion: reduce)": "none" }, animationDuration: "1.5s", animationTimingFunction: "ease-in-out", animationIterationCount: "infinite" },
  progressMeta: { marginTop: "0.625rem", display: "flex", justifyContent: "flex-end", fontFamily: text.fontMono, fontSize: "12px", textTransform: "uppercase", letterSpacing: "0.12em", color: "rgb(255 255 255 / 35%)" },
  telemetry: { marginTop: "1.25rem", borderRadius: "0.75rem", borderWidth: 1, paddingInline: "1rem", paddingBlock: "0.75rem", fontFamily: text.fontMono, fontSize: "13px", color: "rgb(255 255 255 / 65%)", backgroundColor: "rgb(0 0 0 / 15%)", borderColor: "rgb(255 255 255 / 8%)" },
  telemetryStalled: { borderColor: "rgb(252 211 77 / 25%)", backgroundColor: "rgb(252 211 77 / 10%)", color: "rgb(254 243 199)" },
  telemRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem" },
  telemText: { marginTop: "0.5rem", fontSize: "12px", textTransform: "uppercase", letterSpacing: "0.1em", color: "rgb(255 255 255 / 45%)" },
  telemWarn: { marginTop: "0.5rem", fontSize: "12px", textTransform: "uppercase", letterSpacing: "0.1em", color: "rgb(254 243 199 / 70%)" },
  activity: { display: "inline-flex", alignItems: "center", gap: "0.5rem" },
  activityIcon: { width: "0.875rem", height: "0.875rem", flexShrink: 0, color: colors.accent, animationName: { default: spin, "@media (prefers-reduced-motion: reduce)": "none" }, animationDuration: "1s", animationTimingFunction: "linear", animationIterationCount: "infinite" },
});
