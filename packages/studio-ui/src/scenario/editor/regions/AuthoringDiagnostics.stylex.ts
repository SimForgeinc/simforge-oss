import * as stylex from "@stylexjs/stylex";
import { colors, space, stroke, text } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // mt-5 border-t border-border pt-4 text-xs
  xsRuleT: {
    marginTop: space.s5,
    borderTopWidth: stroke.hairline,
    borderColor: colors.hairline,
    paddingTop: space.s4,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
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
    marginTop: space.s3,
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: space.s2,
  },
  // mt-3 flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground
  flexWrapMuted: {
    marginTop: space.s3,
    display: "flex",
    flexWrap: "wrap",
    MozColumnGap: "0.75rem",
    columnGap: space.s3,
    rowGap: space.s1,
    color: colors.mutedForeground,
  },
  // mt-3 border border-emerald-400/40 bg-emerald-500/15 p-2 text-foreground
  inkBorderedPad2: {
    marginTop: space.s3,
    borderWidth: stroke.hairline,
    borderColor: colors.positive,
    backgroundColor: colors.positiveWash,
    padding: space.s2,
    color: colors.text,
  },

  // mt-3 border p-2
  firstIssue: {
    marginTop: space.s3,
    borderWidth: stroke.hairline,
    padding: space.s2,
  },
  // border-destructive/50 bg-destructive/15 text-foreground
  firstIssueError: {
    borderColor: colors.critical,
    backgroundColor: colors.criticalWash,
    color: colors.text,
  },
  // border-amber-400/40 bg-amber-500/15 text-foreground
  firstIssueWarning: {
    borderColor: colors.warning,
    backgroundColor: colors.warningWash,
    color: colors.text,
  },
});
