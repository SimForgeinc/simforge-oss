import * as stylex from "@stylexjs/stylex";
import { colors, text, space } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  /**
   * font-semibold uppercase tracking-meta text-muted-foreground
   *
   * No font-size on purpose: Tailwind's preflight sets `font-size: inherit`
   * on `h1`-`h6`, so the baseline heading took the tools panel's `text-xs`.
   */
  heading: { color: colors.textMuted, fontWeight: text.weightSemibold, textTransform: "uppercase", letterSpacing: text.trackingMeta },
  row: { display: "flex", alignItems: "center" },
  mono: { fontFamily: text.fontMono },
  truncate: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  /**
   * mt-2 bg-muted/30 p-2
   *
   * `bg-muted/30` tints the semantic `muted` surface, which the `muted` token
   * bridges at full opacity; the tinted form is written out because a StyleX
   * variable has no channel left to apply the utility's alpha to.
   */
  item: { marginTop: space.md, backgroundColor: "hsl(var(--muted) / 0.3)", padding: space.md },
  /** mt-2 border border-border bg-muted/20 p-2 */
  itemBorder: { marginTop: space.md, borderWidth: "1px", borderStyle: "solid", borderColor: colors.border, backgroundColor: "hsl(var(--muted) / 0.2)", padding: space.md },
  /** mt-1 h-8 font-mono text-micro */
  monoInput: { marginTop: space.xs, height: "2rem", fontFamily: text.fontMono, fontSize: text.sizeMicro, lineHeight: text.lineMicro },
  stack: { marginTop: space.md, display: "flex", flexDirection: "column", gap: space.md },
  description: { marginTop: space.md },
  grid: {
    marginTop: space.md,
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: space.md,
  },
  fieldWrap: { minWidth: 0 },
  label: { display: "block", color: colors.textMuted },
  input: { marginTop: space.xs, height: "2rem" },
  /** h-8 text-xs */
  selectField: { height: "2rem", fontSize: text.sizeXs, lineHeight: "1rem" },
  /**
   * motionStyles.editorMotion + ml-auto text-primary hover:text-primary/80
   * focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
   * focus-visible:ring-offset-1 focus-visible:ring-offset-card
   * disabled:opacity-30
   */
  iconButton: {
    marginLeft: "auto",
    color: {
      default: colors.primary,
      ":hover": "hsl(var(--primary) / 0.8)",
    },
    opacity: {
      default: null,
      ":disabled": 0.3,
    },
    outline: {
      default: null,
      ":focus-visible": "2px solid transparent",
    },
    outlineOffset: {
      default: null,
      ":focus-visible": "2px",
    },
    boxShadow: {
      default: null,
      ":focus-visible": "0 0 0 1px hsl(var(--card)), 0 0 0 3px hsl(var(--ring))",
    },
  },
  /**
   * motionStyles.editorMotion + ml-auto text-muted-foreground
   * hover:text-destructive focus-visible:outline-none focus-visible:ring-2
   * focus-visible:ring-ring focus-visible:ring-offset-1
   * focus-visible:ring-offset-card
   */
  iconButtonMuted: {
    marginLeft: "auto",
    color: {
      default: colors.textMuted,
      ":hover": colors.danger,
    },
    outline: {
      default: null,
      ":focus-visible": "2px solid transparent",
    },
    outlineOffset: {
      default: null,
      ":focus-visible": "2px",
    },
    boxShadow: {
      default: null,
      ":focus-visible": "0 0 0 1px hsl(var(--card)), 0 0 0 3px hsl(var(--ring))",
    },
  },
  icon: { width: "0.75rem", height: "0.75rem" },
});
