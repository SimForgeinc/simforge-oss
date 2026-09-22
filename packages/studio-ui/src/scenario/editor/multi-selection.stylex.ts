import * as stylex from "@stylexjs/stylex";
import { colors, motion, shadows, space, text } from "../../stylex/tokens.stylex";
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
 panel: { pointerEvents: "auto", display: "flex", alignItems: "center", gap: space.s2, backgroundColor: colors.scrimHeavy, padding: "0.375rem 0.75rem", fontSize: text.sizeXs, lineHeight: text.lineXs, color: colors.ink, boxShadow: shadows.elevationLg, backdropFilter: motion.blurGlass },
 count: { fontWeight: text.weightSemibold },
 clear: { padding: 0 },
});
