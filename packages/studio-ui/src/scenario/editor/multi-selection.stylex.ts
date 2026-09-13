import * as stylex from "@stylexjs/stylex";
import { text, space } from "../../stylex/tokens.stylex";
export const styles = stylex.create({
 /**
  * pointer-events-auto flex items-center gap-2 rounded-lg border
  * border-border/70 bg-black/85 px-3 py-1.5 text-xs text-white shadow-lg
  * backdrop-blur-md
  *
  * `border-border/70` carries an alpha the `border` token cannot express —
  * it bridges `hsl(var(--border))` with no channel left to tint — so the
  * bridge is written out here at the utility's own opacity. `shadow-lg` is
  * Tailwind's two-layer value verbatim.
  */
 panel: { pointerEvents: "auto", display: "flex", alignItems: "center", gap: space.md, borderWidth: "1px", borderStyle: "solid", borderColor: "hsl(var(--border) / 0.7)", backgroundColor: "rgba(0,0,0,0.85)", padding: "0.375rem 0.75rem", fontSize: text.sizeXs, lineHeight: "1rem", color: "white", boxShadow: "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)", backdropFilter: "blur(12px)" },
 count: { fontWeight: text.weightSemibold },
 button: { height: "1.75rem" },
 resnapButton: {
    height: "1.75rem",
    borderColor: "rgb(252 211 77 / 0.7)",
    color: {
      default: "rgb(253 230 138 / 1)",
      ":hover": "rgb(254 243 199 / 1)",
    },
 },
 clear: { height: "1.75rem", width: "1.75rem", padding: 0 },
});
