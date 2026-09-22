import * as stylex from "@stylexjs/stylex";
import { colors, space, text, motion } from "@simforge-oss/studio-ui/stylex/tokens.stylex";
export const shelf = stylex.create({
  tabBar: { borderBottomWidth: 1, borderBottomStyle: "solid", borderBottomColor: colors.border },
  tabBarInner: { display: "flex", flexWrap: "wrap", gap: space.xl },
  tab: { borderBottomWidth: 2, borderBottomStyle: "solid", paddingBlock: space.lg, fontSize: text.sizeSm, fontWeight: text.weightMedium, transitionProperty: "color, border-color", transitionDuration: motion.durBase, ":focus-visible": { outlineWidth: 2, outlineStyle: "solid", outlineColor: colors.ring } },
  tabActive: { borderBottomColor: colors.accent, color: colors.text },
  tabIdle: { borderBottomColor: "transparent", color: { default: colors.textMuted, ":hover": colors.text } },
});
