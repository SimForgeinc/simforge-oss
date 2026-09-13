import * as stylex from "@stylexjs/stylex";
import { colors, text, space } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // px-1 py-6 text-center text-xs text-muted-foreground
  xsMutedCenterText: {
    paddingLeft: space.xs,
    paddingRight: space.xs,
    paddingTop: space.xxl,
    paddingBottom: space.xxl,
    textAlign: "center",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.mutedForeground,
  },
  // flex flex-col gap-4
  flexColGap4: {
    display: "flex",
    flexDirection: "column",
    gap: space.xl,
  },
  // flex flex-col gap-1
  flexColGap1: {
    display: "flex",
    flexDirection: "column",
    gap: space.xs,
  },
  // text-micro font-semibold uppercase tracking-meta text-muted-foreground
  capsMicroMuted: {
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    fontWeight: text.weightSemibold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: colors.mutedForeground,
  },
  /*
   * `render-divide divide-y` was a `> * + *` rule, which StyleX cannot
   * express, so the hairline moves onto the rows: every row but the first
   * draws its own top border in the same colour the parent used to hand down.
   */
  // render-glass border
  borderedDivided: {
    borderWidth: "1px",
    backgroundColor: colors.glass,
    borderColor: "rgb(255 255 255 / 10%)",
  },
  // (was the list's render-divide divide-y)
  rowDivided: {
    borderTopWidth: "1px",
    borderTopColor: "rgb(255 255 255 / 10%)",
  },
  // flex items-center gap-3 px-2.5 py-2
  flexCenterGap3: {
    display: "flex",
    alignItems: "center",
    gap: space.lg,
    paddingLeft: "0.625rem",
    paddingRight: "0.625rem",
    paddingTop: space.md,
    paddingBottom: space.md,
  },
  // min-w-0 flex-1
  fillNarrowable: {
    minWidth: "0px",
    flex: "1 1 0%",
  },
  // truncate text-xs font-medium text-foreground
  xsInkMedium: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    fontWeight: text.weightMedium,
    color: colors.text,
  },
  // truncate text-micro text-muted-foreground
  microMutedTruncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    color: colors.mutedForeground,
  },
  // shrink-0 text-micro uppercase tracking-meta text-destructive
  tightCapsMicro: {
    flexShrink: "0",
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: colors.danger,
  },
  // flex shrink-0 items-center gap-1
  flexCenterTight: {
    display: "flex",
    flexShrink: "0",
    alignItems: "center",
    gap: space.xs,
  },
  // size-3.5
  size35: {
    width: "0.875rem",
    height: "0.875rem",
  },

  // size-4 shrink-0
  artifactIcon: {
    width: "1rem",
    height: "1rem",
    flexShrink: 0,
  },
  // text-destructive
  danger: {
    color: colors.danger,
  },
  // text-muted-foreground
  muted: {
    color: colors.mutedForeground,
  },
  // shrink-0 text-micro uppercase tracking-meta
  availabilityNote: {
    flexShrink: 0,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
  },
});
