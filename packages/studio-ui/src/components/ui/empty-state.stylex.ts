import * as stylex from "@stylexjs/stylex";
import { colors, text } from "../../stylex/tokens.stylex";

/**
 * The empty-state block, translated one-for-one from its Tailwind utilities.
 *
 * Colour and type come from the shared token scale (`colors.text` is
 * `hsl(var(--foreground))`, `text.sizeBase` is `1rem`), so the two themes keep
 * switching on the `.dark` class exactly as before. Geometry stays as literal
 * `rem` values rather than the `px`-based `space` scale: this component is
 * rendered inside pixel-preserved surfaces (the scenario review queue, the map
 * catalog), and `rem` keeps it tied to the root font size the way Tailwind's
 * spacing scale was.
 */
export const styles = stylex.create({
  // flex min-h-64 flex-col items-center justify-center px-6 py-10 text-center
  root: {
    display: "flex",
    minHeight: "16rem",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    paddingInline: "1.5rem",
    paddingBlock: "2.5rem",
    textAlign: "center",
  },
  // mb-4 text-muted-foreground
  icon: {
    marginBottom: "1rem",
    color: colors.textMuted,
  },
  // text-base font-semibold text-foreground
  title: {
    fontSize: text.sizeBase,
    lineHeight: "1.5rem",
    fontWeight: 600,
    color: colors.text,
  },
  // mt-1 max-w-md text-sm leading-6 text-muted-foreground
  description: {
    marginTop: "0.25rem",
    maxWidth: "28rem",
    fontSize: text.sizeSm,
    lineHeight: "1.5rem",
    color: colors.textMuted,
  },
  // mt-5
  action: {
    marginTop: "1.25rem",
  },
});
