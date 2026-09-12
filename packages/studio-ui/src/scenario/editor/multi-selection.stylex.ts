import * as stylex from "@stylexjs/stylex";
import { colors, text, space } from "../../stylex/tokens.stylex";
export const styles = stylex.create({
 panel: { pointerEvents: "auto", display: "flex", alignItems: "center", gap: space.md, border: `1px solid ${colors.lineStrong}`, backgroundColor: "rgba(0,0,0,0.85)", padding: "6px 12px", fontSize: text.sizeXs, color: "white", boxShadow: "0 10px 24px rgba(0,0,0,0.35)", backdropFilter: "blur(12px)" },
 count: { fontWeight: text.weightSemibold },
 button: { height: "28px" },
 clear: { height: "28px", width: "28px", padding: 0 },
});
