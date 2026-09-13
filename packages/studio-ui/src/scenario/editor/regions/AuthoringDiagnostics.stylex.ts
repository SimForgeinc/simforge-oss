import * as stylex from "@stylexjs/stylex";
import { colors, text, space } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // mt-5 border-t border-border pt-4 text-xs
  xsRuleT: {
    marginTop: "1.25rem",
    borderTopWidth: "1px",
    borderColor: colors.border,
    paddingTop: space.xl,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
  },
  // font-semibold uppercase tracking-meta text-muted-foreground
  capsMutedSemibold: {
    fontWeight: text.weightSemibold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: colors.mutedForeground,
  },
  // mt-3 grid grid-cols-2 gap-2
  gridCols2Gap2: {
    marginTop: space.lg,
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: space.md,
  },
  // mt-3 flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground
  flexWrapMuted: {
    marginTop: space.lg,
    display: "flex",
    flexWrap: "wrap",
    MozColumnGap: "0.75rem",
    columnGap: space.lg,
    rowGap: space.xs,
    color: colors.mutedForeground,
  },
  // mt-3 border border-emerald-400/40 bg-emerald-500/15 p-2 text-foreground
  inkBorderedPad2: {
    marginTop: space.lg,
    borderWidth: "1px",
    borderColor: "rgb(52 211 153 / 0.4)",
    backgroundColor: "rgb(16 185 129 / 0.15)",
    padding: space.md,
    color: colors.text,
  },

  // mt-3 border p-2
  firstIssue: {
    marginTop: space.lg,
    borderWidth: "1px",
    padding: space.md,
  },
  // border-destructive/50 bg-destructive/15 text-foreground
  firstIssueError: {
    borderColor: "hsl(var(--destructive) / 0.5)",
    backgroundColor: "hsl(var(--destructive) / 0.15)",
    color: colors.text,
  },
  // border-amber-400/40 bg-amber-500/15 text-foreground
  firstIssueWarning: {
    borderColor: "rgb(251 191 36 / 0.4)",
    backgroundColor: "rgb(245 158 11 / 0.15)",
    color: colors.text,
  },
});
