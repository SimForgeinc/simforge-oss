import * as stylex from "@stylexjs/stylex";
import { colors, text, space, layers } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

export const gallery = stylex.create({
  toolbar: { position: "sticky", top: 0, zIndex: layers.sticky, borderBottomWidth: 1, borderBottomStyle: "solid", borderBottomColor: colors.border, backgroundColor: colors.bg },
  main: { paddingBlock: space.xxl, minWidth: 0 },
  measure: { width: "100%", minWidth: 0 },
  alert: { marginBottom: "1rem", borderWidth: "1px", borderStyle: "solid", borderColor: "rgba(248,113,113,0.2)", borderRadius: "0.5rem", backgroundColor: "rgba(248,113,113,0.05)", paddingInline: "1rem", paddingBlock: "0.75rem", fontSize: text.sizeSm, lineHeight: "1.25rem", color: "#fecaca" },
  actions: { display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "center", gap: "0.5rem" },
  icon: { width: "1.75rem", height: "1.75rem" },
  emptyState: { borderWidth: 1, borderStyle: "dashed", borderColor: colors.border },
  loadMore: { marginTop: "2rem", display: "flex", justifyContent: "center" },
  spinner: { animationName: stylex.keyframes({ from: { transform: "rotate(0deg)" }, to: { transform: "rotate(360deg)" } }), animationDuration: "1s", animationTimingFunction: "linear", animationIterationCount: "infinite" },
});

