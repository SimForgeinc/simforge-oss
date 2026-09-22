import * as stylex from "@stylexjs/stylex";
import { colors, layout, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

const LG = "@media (min-width: 1024px)";
const MD = "@media (min-width: 768px)";
const spin = stylex.keyframes({ from: { transform: "rotate(0deg)" }, to: { transform: "rotate(360deg)" } });

export const styles = stylex.create({
  shell: { display: "flex", height: "100%", minHeight: 0, minWidth: 0, overflow: "hidden", flexDirection: "column", backgroundColor: colors.bg },
  sidebar: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0, minWidth: 0, overflow: "hidden", backgroundColor: colors.bg },
  main: { height: "100%", minHeight: 0, minWidth: 0, overflowY: "auto", padding: { default: layout.gutterNarrow, [LG]: layout.gutter } },
  selected: { borderWidth: "1px", borderStyle: "solid", borderColor: "hsl(var(--border) / .6)", backgroundColor: "hsl(var(--card) / .35)", padding: "1rem" },
  iconSmall: { width: "0.75rem", height: "0.75rem" },
  iconSpin: { animationName: spin, animationDuration: "1s", animationTimingFunction: "linear", animationIterationCount: "infinite" },
  sidebarHeader: { flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between", borderBottomWidth: "1px", borderBottomStyle: "solid", borderBottomColor: "hsl(var(--border) / .7)", paddingInline: "1rem", paddingBlock: "0.75rem" },
  textMuted: { fontSize: "0.75rem", lineHeight: "1rem", fontWeight: 500, color: "hsl(var(--muted-foreground))" },
  count: { fontFamily: text.fontMono, fontSize: "10px", color: "hsl(var(--muted-foreground) / .7)" },
  datasetScroll: { flex: "1 1 0%", minWidth: 0, minHeight: 0, overflowY: "auto", padding: "0.75rem" },
  datasetEmpty: { borderWidth: "1px", borderStyle: "solid", borderColor: "rgba(255,255,255,.1)", backgroundColor: "rgba(10,10,12,.6)", padding: "1rem", fontSize: "0.875rem", lineHeight: "1.25rem", color: "hsl(var(--foreground) / .55)" },
  datasetList: { minWidth: 0, display: "grid", gap: "0.5rem" },
  datasetButton: { minWidth: 0, display: "flex", width: "100%", gap: "0.75rem", borderWidth: "1px", borderStyle: "solid", borderColor: "rgba(255,255,255,.1)", paddingInline: "0.75rem", paddingBlock: "0.75rem", textAlign: "left", backgroundColor: "rgba(10,10,12,.55)", transitionProperty: "background-color, border-color", transitionDuration: "150ms", ":hover": { borderColor: "rgba(255,255,255,.25)", backgroundColor: "rgba(10,10,12,1)" } },
  datasetActive: { borderColor: "rgba(232,224,68,.7)", backgroundColor: "rgba(232,224,68,.08)" },
  datasetIcon: { marginTop: "0.125rem", width: "1rem", height: "1rem", flexShrink: 0, color: "hsl(var(--muted-foreground))" },
  datasetIconActive: { color: colors.accent },
  datasetText: { minWidth: 0 },
  datasetName: { display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "0.875rem", lineHeight: "1.25rem", fontWeight: 600, color: "hsl(var(--foreground))" },
  datasetDescription: { display: "-webkit-box", overflow: "hidden", marginTop: "0.25rem", fontSize: "0.75rem", lineHeight: "1.25rem", color: "hsl(var(--muted-foreground))", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" },
  datasetId: { overflowWrap: "anywhere", display: "block", marginTop: "0.25rem", fontFamily: text.fontMono, fontSize: "10px", letterSpacing: "0.1em", textTransform: "uppercase", color: "hsl(var(--muted-foreground) / .6)" },
  selectedLabel: { fontSize: "0.75rem", lineHeight: "1rem", fontWeight: 500, color: "hsl(var(--muted-foreground))" },
  selectedName: { marginTop: "0.25rem", fontSize: "1.125rem", lineHeight: "1.75rem", fontWeight: 600, color: "hsl(var(--foreground))" },
  selectedDescription: { marginTop: "0.25rem", maxWidth: "48rem", fontSize: "0.875rem", lineHeight: "1.5rem", color: "hsl(var(--muted-foreground))" },
  selectedWrap: { minWidth: 0, display: "grid", gap: "1rem" },
  emptyState: { minHeight: "360px", borderWidth: "1px", borderStyle: "solid", borderColor: "hsl(var(--border))", backgroundColor: "hsl(var(--card) / .3)" },
  workspaceButton: { display: "inline-flex", height: "2.25rem", alignItems: "center", gap: "0.5rem", borderWidth: "1px", borderStyle: "solid", borderColor: "hsl(var(--border))", backgroundColor: "hsl(var(--background))", paddingInline: "0.75rem", fontSize: "0.875rem", lineHeight: "1.25rem", fontWeight: 500, color: "hsl(var(--foreground))", transitionProperty: "background-color", transitionDuration: "150ms", ":hover": { backgroundColor: "hsl(var(--foreground) / .05)" }, ":disabled": { cursor: "not-allowed", opacity: 0.45 } },
  iconEmpty: { width: "1.5rem", height: "1.5rem" }
});
