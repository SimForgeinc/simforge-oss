import * as stylex from "@stylexjs/stylex";
import { colors, space, text } from "../stylex/tokens.stylex";

export const styles = stylex.create({
  root: { display: "flex", flexDirection: "column", width: "100%", height: "100%", minWidth: 0, minHeight: 0, overflow: "hidden" },
  switcher: { display: "flex", flexShrink: 0, gap: space.xs, padding: space.md, borderBottom: `1px solid ${colors.border}`, backgroundColor: colors.bg },
  switchButton: { minHeight: "44px", paddingInline: space.xl, fontSize: text.sizeSm, color: colors.text, backgroundColor: { default: "transparent", ":hover": colors.glassHover }, outlineColor: colors.ring },
  selected: { color: colors.accent, backgroundColor: colors.accentSoft },
  panes: { display: "flex", flex: 1, minWidth: 0, minHeight: 0, overflow: "hidden" },
  stage: { position: "relative", display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, overflow: "hidden" },
  inspector: { display: "flex", flexDirection: "column", width: space.inspectorWidthXl, minWidth: 0, minHeight: 0, overflow: "hidden", flexShrink: 0 },
  narrowInspector: { width: "100%", flex: 1 },
  hidden: { display: "none" },
});
