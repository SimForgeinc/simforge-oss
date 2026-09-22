import * as stylex from "@stylexjs/stylex";
import { colors, space, text, motion } from "@simforge-oss/studio-ui/stylex/tokens.stylex";
export const shelf = stylex.create({
  tabBar: { borderBottomWidth: 1, borderBottomStyle: "solid", borderBottomColor: colors.border },
  tabBarInner: { display: "flex", flexWrap: "wrap", gap: space.s4 },
  tab: { borderBottomWidth: 2, borderBottomStyle: "solid", paddingBlock: space.s3, fontSize: text.sizeSm, fontWeight: text.weightMedium, transitionProperty: "color, border-color", transitionDuration: motion.durBase, ":focus-visible": { outlineWidth: 2, outlineStyle: "solid", outlineColor: colors.ring } },
  tabActive: { borderBottomColor: colors.accent, color: colors.text },
  tabIdle: { borderBottomColor: "transparent", color: { default: colors.mutedForeground, ":hover": colors.text } },
});
