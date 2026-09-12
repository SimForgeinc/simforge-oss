import * as stylex from "@stylexjs/stylex";
import { colors, radii, space, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

const LG = "@media (min-width: 1024px)";
const spin = stylex.keyframes({ from: { transform: "rotate(0deg)" }, to: { transform: "rotate(360deg)" } });

export const styles = stylex.create({
  shell: { display: "flex", minHeight: "100%", flexDirection: "column", backgroundColor: colors.bg },
  content: { display: "flex", flexDirection: "column", gap: space.xxl, paddingInline: space.xxl, paddingBlock: "20px" },
  workspaceBar: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: space.lg },
  label: { fontSize: text.sizeXs, fontWeight: text.weightMedium, color: colors.mutedForeground },
  select: { height: "2.25rem", border: `1px solid ${colors.border}`, borderRadius: radii.md, backgroundColor: colors.bg, paddingInline: space.lg, fontSize: text.sizeSm, color: colors.text },
  targetSelect: { height: "2rem", maxWidth: "11rem", border: `1px solid ${colors.border}`, borderRadius: radii.md, backgroundColor: colors.bg, paddingInline: space.md, fontSize: text.sizeXs, color: colors.text },
  account: { fontSize: text.sizeXs, color: colors.mutedForeground },
  notice: { display: "flex", alignItems: "flex-start", gap: space.md, border: "1px solid color-mix(in srgb, #f59e0b 40%, transparent)", borderRadius: radii.md, backgroundColor: "color-mix(in srgb, #f59e0b 10%, transparent)", paddingInline: space.lg, paddingBlock: space.md, fontSize: text.sizeSm, color: "#fde68a" },
  noticeSuccess: { borderColor: "color-mix(in srgb, #10b981 40%, transparent)", backgroundColor: "color-mix(in srgb, #10b981 10%, transparent)", color: "#a7f3d0" },
  noticeIcon: { marginTop: "2px", width: space.lg, height: space.lg, flexShrink: 0 },
  sectionGrid: { display: "grid", gap: space.lg, [LG]: { gridTemplateColumns: "repeat(2, minmax(0, 1fr))" } },
  card: { display: "flex", minHeight: "12rem", flexDirection: "column", border: `1px solid color-mix(in srgb, ${colors.border} 70%, transparent)`, borderRadius: radii.lg, backgroundColor: "color-mix(in srgb, hsl(var(--card)) 25%, transparent)" },
  cardHeader: { display: "flex", alignItems: "center", gap: space.md, borderBottom: `1px solid color-mix(in srgb, ${colors.border} 70%, transparent)`, paddingInline: space.xl, paddingBlock: space.lg },
  cardIcon: { color: colors.mutedForeground },
  cardHeading: { minWidth: 0 },
  cardTitle: { fontSize: text.sizeSm, fontWeight: text.weightSemibold, color: colors.text },
  cardSubtitle: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: text.sizeXs, color: colors.mutedForeground },
  count: { marginInlineStart: "auto", fontSize: text.sizeXs, color: colors.mutedForeground },
  empty: { paddingInline: space.xl, paddingBlock: space.xxl, fontSize: text.sizeSm, color: colors.mutedForeground },
  list: { margin: 0, padding: 0, listStyle: "none", borderBlock: 0 },
  row: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: space.lg, paddingInline: space.xl, paddingBlock: space.lg, borderBottom: `1px solid color-mix(in srgb, ${colors.border} 60%, transparent)` },
  rowBody: { minWidth: 0, flex: "1 1 0%" },
  rowHeading: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: space.md },
  rowTitle: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: text.sizeSm, fontWeight: text.weightMedium, color: colors.text },
  rowDetail: { marginTop: "2px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: text.sizeXs, color: colors.mutedForeground },
  actions: { display: "flex", alignItems: "center", gap: space.md },
  icon: { width: "0.875rem", height: "0.875rem" },
  icon4: { width: "1rem", height: "1rem" },
  icon8: { width: "2rem", height: "2rem" },
  spinner: { animationName: spin, animationDuration: "1s", animationTimingFunction: "linear", animationIterationCount: "infinite" },
});
