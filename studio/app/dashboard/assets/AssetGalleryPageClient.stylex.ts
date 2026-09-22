import * as stylex from "@stylexjs/stylex";
import { colors, layers, motion, space, stroke, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

export const gallery = stylex.create({
  toolbar: { position: "sticky", top: 0, zIndex: layers.sticky, borderBottomWidth: stroke.hairline, borderBottomStyle: "solid", borderBottomColor: colors.border, backgroundColor: colors.bg },
  main: { paddingBlock: space.s6, minWidth: 0 },
  measure: { width: "100%", minWidth: 0 },
  alert: { marginBottom: space.s4, borderWidth: stroke.hairline, borderStyle: "solid", borderColor: "rgba(248,113,113,0.2)", borderRadius: "0.5rem", backgroundColor: "rgba(248,113,113,0.05)", paddingInline: space.s4, paddingBlock: space.s3, fontSize: text.sizeSm, lineHeight: text.lineSm, color: "#fecaca" },
  actions: { display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "center", gap: space.s2 },
  icon: { width: "1.75rem", height: "1.75rem" },
  emptyState: { borderWidth: stroke.hairline, borderStyle: "dashed", borderColor: colors.border },
  loadMore: { marginTop: space.s8, display: "flex", justifyContent: "center" },
  spinner: { animationName: stylex.keyframes({ from: { transform: "rotate(0deg)" }, to: { transform: "rotate(360deg)" } }), animationDuration: motion.durSpin, animationTimingFunction: motion.easeLinear, animationIterationCount: "infinite" },
});

