import * as stylex from "@stylexjs/stylex";
import { colors, layout, motion, space, stroke, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";
const MD = "@media (min-width: 768px)";

export const styles = stylex.create({
  shell: { display: "flex", height: "100%", minHeight: 0, minWidth: 0, overflow: "hidden", flexDirection: "column", backgroundColor: colors.bg },
  sidebar: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0, minWidth: 0, overflow: "hidden", backgroundColor: colors.bg },
  main: { height: "100%", minHeight: 0, minWidth: 0, overflowY: "auto", padding: { default: layout.gutterNarrow, [layout.bpLg]: layout.gutter } },
  selected: { borderWidth: stroke.hairline, borderStyle: "solid", borderColor: "hsl(var(--border) / .6)", backgroundColor: "hsl(var(--card) / .35)", padding: space.s4 },
  iconSmall: { width: "0.75rem", height: "0.75rem" },
  sidebarHeader: { flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between", borderBottomWidth: stroke.hairline, borderBottomStyle: "solid", borderBottomColor: "hsl(var(--border) / .7)", paddingInline: space.s4, paddingBlock: space.s3 },
  textMuted: { fontSize: text.sizeXs, lineHeight: text.lineXs, fontWeight: text.weightMedium, color: colors.mutedForeground },
  count: { fontFamily: text.fontMono, fontSize: "10px", color: "hsl(var(--muted-foreground) / .7)" },
  datasetScroll: { flex: "1 1 0%", minWidth: 0, minHeight: 0, overflowY: "auto", padding: space.s3 },
  datasetEmpty: { borderWidth: stroke.hairline, borderStyle: "solid", borderColor: "rgba(255,255,255,.1)", backgroundColor: "rgba(10,10,12,.6)", padding: space.s4, fontSize: text.sizeSm, lineHeight: text.lineSm, color: "hsl(var(--foreground) / .55)" },
  datasetList: { minWidth: 0, display: "grid", gap: space.s2 },
  datasetButton: { minWidth: 0, display: "flex", width: "100%", gap: space.s3, borderWidth: stroke.hairline, borderStyle: "solid", borderColor: "rgba(255,255,255,.1)", paddingInline: space.s3, paddingBlock: space.s3, textAlign: "left", backgroundColor: "rgba(10,10,12,.55)", transitionProperty: "background-color, border-color", transitionDuration: motion.durStandard, ":hover": { borderColor: "rgba(255,255,255,.25)", backgroundColor: "rgba(10,10,12,1)" } },
  datasetActive: { borderColor: "rgba(232,224,68,.7)", backgroundColor: "rgba(232,224,68,.08)" },
  datasetIcon: { marginTop: space.s0_5, width: "1rem", height: "1rem", flexShrink: 0, color: colors.mutedForeground },
  datasetIconActive: { color: colors.accent },
  datasetText: { minWidth: 0 },
  datasetName: { display: "block", fontSize: text.sizeSm, lineHeight: text.lineSm, fontWeight: text.weightSemibold, color: colors.text },
  datasetDescription: { display: "-webkit-box", overflow: "hidden", marginTop: space.s1, fontSize: text.sizeXs, lineHeight: text.lineSm, color: colors.mutedForeground, WebkitLineClamp: 2, WebkitBoxOrient: "vertical" },
  datasetId: { overflowWrap: "anywhere", display: "block", marginTop: space.s1, fontFamily: text.fontMono, fontSize: "10px", letterSpacing: text.trackingMetaNarrow, textTransform: "uppercase", color: "hsl(var(--muted-foreground) / .6)" },
  selectedLabel: { fontSize: text.sizeXs, lineHeight: text.lineXs, fontWeight: text.weightMedium, color: colors.mutedForeground },
  selectedName: { marginTop: space.s1, fontSize: text.sizeLg, lineHeight: text.lineLg, fontWeight: text.weightSemibold, color: colors.text },
  selectedDescription: { marginTop: space.s1, maxWidth: "48rem", fontSize: text.sizeSm, lineHeight: text.lineBase, color: colors.mutedForeground },
  selectedWrap: { minWidth: 0, display: "grid", gap: space.s4 },
  emptyState: { minHeight: "360px", borderWidth: stroke.hairline, borderStyle: "solid", borderColor: colors.border, backgroundColor: "hsl(var(--card) / .3)" },
  workspaceButton: { display: "inline-flex", height: "2.25rem", alignItems: "center", gap: space.s2, borderWidth: stroke.hairline, borderStyle: "solid", borderColor: colors.border, backgroundColor: colors.bg, paddingInline: space.s3, fontSize: text.sizeSm, lineHeight: text.lineSm, fontWeight: text.weightMedium, color: colors.text, transitionProperty: "background-color", transitionDuration: motion.durStandard, ":hover": { backgroundColor: "hsl(var(--foreground) / .05)" }, ":disabled": { cursor: "not-allowed", opacity: 0.45 } },
  iconEmpty: { width: "1.5rem", height: "1.5rem" }
});
