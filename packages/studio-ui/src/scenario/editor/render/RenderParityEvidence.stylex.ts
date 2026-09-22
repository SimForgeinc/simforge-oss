import * as stylex from "@stylexjs/stylex";
import { colors, text, space } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // border border-destructive/40 p-3 text-xs text-destructive
  xsDangerBordered: {
    borderWidth: "1px",
    borderColor: "hsl(var(--destructive) / 0.4)",
    padding: space.s3,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.danger,
  },
  // border border-dashed render-hairline p-4 text-xs text-muted-foreground
  xsMutedBordered: {
    borderWidth: "1px",
    borderStyle: "dashed",
    padding: space.s4,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.mutedForeground,
    borderColor: "rgb(255 255 255 / 10%)",
  },
  // min-h-56
  minH56: {
    minHeight: "14rem",
  },
  // text-micro uppercase tracking-meta text-muted-foreground
  capsMicroMuted: {
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: colors.mutedForeground,
  },
  // mt-1 text-sm font-semibold
  smSemibold: {
    marginTop: space.s1,
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    fontWeight: text.weightSemibold,
  },
  // mt-2 text-xs text-muted-foreground
  xsMuted: {
    marginTop: space.s2,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.mutedForeground,
  },
  // text-xs font-semibold uppercase tracking-meta
  capsXsSemibold: {
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    fontWeight: text.weightSemibold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
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
    borderWidth: "1px",
    backgroundColor: colors.fillSubtle,
    borderColor: "rgb(255 255 255 / 10%)",
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
    lineHeight: "1rem",
  },
  // font-medium
  medium: {
    fontWeight: text.weightMedium,
  },
  // ml-2 text-micro text-muted-foreground
  microMuted: {
    marginLeft: space.s2,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    color: colors.mutedForeground,
  },
  // mt-2
  listMt2: {
    marginTop: space.s2,
  },
  // (was the metrics list's render-divide divide-y)
  rowDivided: {
    borderTopWidth: "1px",
    borderTopColor: "rgb(255 255 255 / 10%)",
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
    borderWidth: "1px",
    padding: space.s2,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    backgroundColor: colors.fillSubtle,
    borderColor: "rgb(255 255 255 / 10%)",
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
    lineHeight: "0.875rem",
    color: colors.mutedForeground,
  },
  // border border-destructive/40 p-3
  borderedPad3: {
    borderWidth: "1px",
    borderColor: "hsl(var(--destructive) / 0.4)",
    padding: space.s3,
  },
  // text-xs font-semibold
  xsSemibold: {
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    fontWeight: text.weightSemibold,
  },
  // mt-2 break-all font-mono text-micro
  monoMicroBreakAll: {
    marginTop: space.s2,
    wordBreak: "break-all",
    fontFamily: text.fontMono,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
  },
  // grid grid-cols-2 gap-3 border-y render-hairline py-3 text-xs
  gridXsCols2: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: space.s3,
    borderTopWidth: "1px",
    borderBottomWidth: "1px",
    paddingTop: space.s3,
    paddingBottom: space.s3,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    borderColor: "rgb(255 255 255 / 10%)",
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
    borderWidth: "1px",
    padding: space.s3,
  },
  // border-primary/40 bg-primary/5
  verdictAccepted: {
    borderColor: "hsl(var(--primary) / 0.4)",
    backgroundColor: "hsl(var(--primary) / 0.05)",
  },
  // border-destructive/40 bg-destructive/5
  verdictRejected: {
    borderColor: "hsl(var(--destructive) / 0.4)",
    backgroundColor: "hsl(var(--destructive) / 0.05)",
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
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontFamily: text.fontMono,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
  },
  // truncate font-medium
  evidenceValue: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontWeight: text.weightMedium,
  },
});
