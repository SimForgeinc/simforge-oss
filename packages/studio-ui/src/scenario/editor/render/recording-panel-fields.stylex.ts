import * as stylex from "@stylexjs/stylex";
import { colors, layout, space, stroke, text } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // mt-3 border-t render-hairline pt-3
  ruleT: {
    marginTop: space.s3,
    borderTopWidth: stroke.hairline,
    paddingTop: space.s3,
    borderColor: "rgb(255 255 255 / 10%)",
  },
  // flex items-center gap-2
  flexCenterGap2: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
  },
  // size-3.5 text-muted-foreground
  muted: {
    width: "0.875rem",
    height: "0.875rem",
    color: colors.mutedForeground,
  },
  // text-micro font-bold uppercase tracking-meta text-muted-foreground
  capsMicroMuted: {
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: colors.mutedForeground,
  },
  // mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 text-xs sm:grid-cols-4
  gridXsCols2: {
    marginTop: space.s1_5,
    display: "grid",
    gridTemplateColumns: {
      default: "repeat(2, minmax(0, 1fr))",
      [layout.bpSm]: "repeat(4, minmax(0, 1fr))",
    },
    MozColumnGap: "0.75rem",
    columnGap: space.s3,
    rowGap: space.s1,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
  },
  // mt-1.5 text-micro text-muted-foreground
  microMuted: {
    marginTop: space.s1_5,
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    color: colors.mutedForeground,
  },
  // text-muted-foreground
  muted2: {
    color: colors.mutedForeground,
  },
  // font-medium
  medium: {
    fontWeight: text.weightMedium,
  },
  /*
   * `space-y-*` is a `> * + *` rule with no StyleX form — StyleX styles only
   * the element they are applied to — so the margin it handed down now sits on
   * the child that received it, and only the first child goes without.
   */
  // text-xs
  xs: {
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
  },
  // (was the label's space-y-1)
  stackedXs: {
    marginTop: space.s1,
  },
  // h-9 w-full render-glass border px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
  smBorderedWide: {
    height: "2.25rem",
    width: "100%",
    borderWidth: stroke.hairline,
    paddingLeft: space.s2,
    paddingRight: space.s2,
    fontSize: text.sizeSm,
    lineHeight: text.lineSm,
    backgroundColor: colors.fillSubtle,
    borderColor: "rgb(255 255 255 / 10%)",
  },
  // h-9 w-full render-glass border px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
  xsBorderedWide: {
    height: "2.25rem",
    width: "100%",
    borderWidth: stroke.hairline,
    paddingLeft: space.s2,
    paddingRight: space.s2,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    backgroundColor: colors.fillSubtle,
    borderColor: "rgb(255 255 255 / 10%)",
  },
});
