import * as stylex from "@stylexjs/stylex";
import { colors, space, text } from "../../stylex/tokens.stylex";

export const styles = stylex.create({
  // flex items-baseline justify-between gap-2 font-meta text-micro uppercase tracking-meta-wider
  divFlexMetaMicro: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: space.s2,
  },
  // text-muted-foreground
  span: {
    color: colors.mutedForeground,
  },
  // tabular-nums text-foreground
  span2: {
    fontVariantNumeric: "tabular-nums",
    color: colors.text,
  },
  // mt-1 h-1 w-full bg-muted
  progressbar: {
    marginTop: space.s1,
    height: space.s1,
    width: "100%",
    backgroundColor: colors.muted,
  },
  // h-full bg-primary
  div: {
    height: "100%",
    backgroundColor: colors.primary,
  },
  // font-meta text-micro uppercase tracking-meta-widest text-muted-foreground
  datasetStatus: {
    color: colors.mutedForeground,
  },
  // truncate text-sm font-semibold text-foreground
  pTruncateSmSemibold: {
    fontSize: text.sizeSm,
    lineHeight: text.lineSm,
    fontWeight: text.weightSemibold,
    color: colors.text,
  },
  // space-y-2
  div2: {
    display: "flex",
    flexDirection: "column",
    gap: space.s2,
  },
  // font-meta text-micro uppercase tracking-meta-widest text-muted-foreground
  contributors: {
    color: colors.mutedForeground,
  },
  // mt-1 text-xs text-muted-foreground
  noNamedContributorsYet: {
    marginTop: space.s1,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.mutedForeground,
  },
  // mt-1 space-y-1
  ul: {
    marginTop: space.s1,
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
  },
  // flex items-baseline justify-between gap-2 text-xs
  liFlexXs: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: space.s2,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
  },
  // min-w-0 truncate text-foreground
  spanTruncate: {
    minWidth: 0,
    color: colors.text,
  },
  // shrink-0 font-meta text-micro uppercase tracking-meta text-muted-foreground
  spanMetaMicroUppercase: {
    flexShrink: 0,
    color: colors.mutedForeground,
  },
});
