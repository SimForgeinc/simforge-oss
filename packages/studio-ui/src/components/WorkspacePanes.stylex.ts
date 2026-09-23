import * as stylex from "@stylexjs/stylex";
import { colors, space, text } from "../stylex/tokens.stylex";

/**
 * The pane boxes clip and never scroll (`scroll.clip`, composed first in the component): scrolling is
 * each pane's own business. They used to be `overflow: hidden`, which a `scrollIntoView()` inside a
 * pane could scroll, dragging every pane up under the top bar.
 */
export const styles = stylex.create({
  root: { display: "flex", flexDirection: "column", width: "100%", height: "100%", minWidth: 0, minHeight: 0 },
  switcher: { display: "flex", flexShrink: 0, gap: space.s1, padding: space.s2, borderBottom: `1px solid ${colors.hairline}`, backgroundColor: colors.bg },
  switchButton: { minHeight: "44px", paddingInline: space.s4, fontSize: text.sizeSm, color: colors.text, backgroundColor: { default: "transparent", ":hover": colors.fillStronger }, outlineColor: colors.ring },
  selected: { color: colors.accent, backgroundColor: colors.accentWash },
  panes: { display: "flex", flex: 1, minWidth: 0, minHeight: 0 },
  stage: { position: "relative", display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0 },
  inspector: { display: "flex", flexDirection: "column", width: space.inspectorWidthXl, minWidth: 0, minHeight: 0, flexShrink: 0 },
  narrowInspector: { width: "100%", flex: 1 },
  hidden: { display: "none" },
});
