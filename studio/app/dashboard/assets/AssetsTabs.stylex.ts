import * as stylex from "@stylexjs/stylex";
import { colors, motion, space, stroke, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";
export const shelf = stylex.create({
  tabBar: { borderBottomWidth: stroke.hairline, borderBottomStyle: "solid", borderBottomColor: colors.hairline },
  tabBarInner: { display: "flex", flexWrap: "wrap", gap: space.s4 },
  tab: { borderBottomWidth: stroke.thick, borderBottomStyle: "solid", paddingBlock: space.s3, fontSize: text.sizeSm, fontWeight: text.weightMedium, transitionProperty: "color, border-color", transitionDuration: motion.durBase, ":focus-visible": { outlineWidth: stroke.thick, outlineStyle: "solid", outlineColor: colors.ring } },
  tabActive: { borderBottomColor: colors.accent, color: colors.text },
  tabIdle: { borderBottomColor: "transparent", color: { default: colors.mutedForeground, ":hover": colors.text } },
});
