import * as stylex from "@stylexjs/stylex";
import { colors, space, stroke, text } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // border border-destructive/40 p-3 text-xs text-destructive
  xsDangerBordered: {
    borderWidth: stroke.hairline,
    borderColor: colors.critical,
    padding: space.s3,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.danger,
  },
  // border border-dashed render-hairline p-4 text-xs text-muted-foreground
  xsMutedBordered: {
    borderWidth: stroke.hairline,
    borderStyle: "dashed",
    padding: space.s4,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.mutedForeground,
    borderColor: colors.hairline,
  },
  // min-h-56
  minH56: {
    minHeight: "14rem",
  },
  // text-micro uppercase tracking-meta text-muted-foreground
  capsMicroMuted: {
    color: colors.mutedForeground,
  },
  // mt-1 text-sm font-semibold
  smSemibold: {
    marginTop: space.s1,
    fontSize: text.sizeSm,
    lineHeight: text.lineSm,
    fontWeight: text.weightSemibold,
  },
  // mt-2 text-xs text-muted-foreground
  xsMuted: {
    marginTop: space.s2,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.mutedForeground,
  },
  /*
   * `render-divide divide-y` and `space-y-*` are both `> * + *` rules, and
   * StyleX only ever addresses the element a style is applied to. Both move
   * onto the children: a divided row draws its own top hairline, a stacked row
   * its own top margin, and only the first row of each list goes without.
   */
  // mt-2 render-glass border
  borderedDivided: {
    marginTop: space.s2,
    borderWidth: stroke.hairline,
    backgroundColor: colors.fillSubtle,
    borderColor: colors.hairline,
  },
  // grid grid-cols-[1fr_auto] gap-3 px-3 py-2 text-xs
  gridXsGap3: {
    display: "grid",
    gridTemplateColumns: "1fr auto",
    gap: space.s3,
    paddingLeft: space.s3,
    paddingRight: space.s3,
    paddingTop: space.s2,
    paddingBottom: space.s2,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
  },
  // font-medium
  medium: {
    fontWeight: text.weightMedium,
  },
  // ml-2 text-micro text-muted-foreground
  microMuted: {
    marginLeft: space.s2,
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    color: colors.mutedForeground,
  },
  // mt-2
  listMt2: {
    marginTop: space.s2,
  },
  // (was the metrics list's render-divide divide-y)
  rowDivided: {
    borderTopWidth: stroke.hairline,
    borderTopColor: colors.hairline,
  },
  // (was the list's space-y-1)
  rowStackedXs: {
    marginTop: space.s1,
  },
  // (was the body's space-y-4)
  stackXl: {
    display: "flex",
    flexDirection: "column",
    gap: space.s4,
  },
  // render-glass border p-2 text-xs
  xsBorderedPad2: {
    borderWidth: stroke.hairline,
    padding: space.s2,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    backgroundColor: colors.fillSubtle,
    borderColor: colors.hairline,
  },
  // flex items-center gap-2
  flexCenterGap2: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
  },
  // min-w-0 flex-1 font-medium
  fillMediumNarrowable: {
    minWidth: "0px",
    flex: "1 1 0%",
    fontWeight: text.weightMedium,
  },
  // mt-1 text-micro text-muted-foreground
  microMuted2: {
    marginTop: space.s1,
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    color: colors.mutedForeground,
  },
  // border border-destructive/40 p-3
  borderedPad3: {
    borderWidth: stroke.hairline,
    borderColor: colors.critical,
    padding: space.s3,
  },
  // text-xs font-semibold
  xsSemibold: {
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    fontWeight: text.weightSemibold,
  },
  // mt-2 break-all font-mono text-micro
  monoMicroBreakAll: {
    marginTop: space.s2,
    wordBreak: "break-all",
    fontFamily: text.fontMono,
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
  },
  // grid grid-cols-2 gap-3 border-y render-hairline py-3 text-xs
  gridXsCols2: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: space.s3,
    borderTopWidth: stroke.hairline,
    borderBottomWidth: stroke.hairline,
    paddingTop: space.s3,
    paddingBottom: space.s3,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    borderColor: colors.hairline,
  },
  // min-w-0
  narrowable: {
    minWidth: "0px",
  },
  // text-muted-foreground
  muted: {
    color: colors.mutedForeground,
  },

  // border p-3
  verdict: {
    borderWidth: stroke.hairline,
    padding: space.s3,
  },
  // border-primary/40 bg-primary/5
  verdictAccepted: {
    borderColor: colors.accentLineSubtle,
    backgroundColor: colors.accentWash,
  },
  // border-destructive/40 bg-destructive/5
  verdictRejected: {
    borderColor: colors.critical,
    backgroundColor: colors.criticalWash,
  },
  // font-mono
  metricValue: {
    fontFamily: text.fontMono,
  },
  // font-mono text-destructive
  metricValueViolating: {
    fontFamily: text.fontMono,
    color: colors.danger,
  },
  // text-primary
  divergenceAccepted: {
    color: colors.primary,
  },
  // text-destructive
  divergenceRejected: {
    color: colors.danger,
  },
  // truncate font-mono text-micro
  evidenceValueMono: {
    fontFamily: text.fontMono,
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
  },
  // truncate font-medium
  evidenceValue: {
    fontWeight: text.weightMedium,
  },
});
