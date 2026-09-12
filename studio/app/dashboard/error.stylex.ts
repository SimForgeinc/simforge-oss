import * as stylex from "@stylexjs/stylex";
import { colors, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

/**
 * Dashboard segment error boundary, translated one-for-one from its Tailwind
 * utilities.
 *
 * `colors.primary` is the shadcn `--primary` bridge, not the brand accent:
 * the two coincide in dark mode (`53 78% 58%` ≈ `#E8E044`) but diverge in
 * light mode (`0 0% 9%`), so `colors.accent` would have silently restyled the
 * light theme. The hover state needs the same hue at 90% alpha, which a var
 * bridge cannot express, so it re-spells `hsl(var(--primary) / 0.9)` — the
 * exact value `hover:bg-primary/90` compiled to.
 */
export const styles = stylex.create({
  // p-6 max-w-[1400px] mx-auto
  root: {
    padding: "1.5rem",
    maxWidth: "1400px",
    marginInline: "auto",
  },
  // text-lg font-semibold mb-2
  heading: {
    fontSize: text.sizeLg,
    lineHeight: "1.75rem",
    fontWeight: 600,
    marginBottom: "0.5rem",
  },
  // text-sm text-muted-foreground mb-4
  message: {
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    color: colors.textMuted,
    marginBottom: "1rem",
  },
  // text-sm px-4 py-2 bg-primary text-primary-foreground hover:bg-primary/90
  retry: {
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    paddingInline: "1rem",
    paddingBlock: "0.5rem",
    backgroundColor: {
      default: colors.primary,
      ":hover": "hsl(var(--primary) / 0.9)",
    },
    color: colors.primaryForeground,
  },
});
