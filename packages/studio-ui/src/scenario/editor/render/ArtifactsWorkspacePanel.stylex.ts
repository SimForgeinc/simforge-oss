import * as stylex from "@stylexjs/stylex";
import { colors, text, space } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // flex min-h-0 flex-1 flex-col
  flexColFill: {
    display: "flex",
    minHeight: "0px",
    flex: "1 1 0%",
    flexDirection: "column",
  },
  // flex shrink-0 items-end gap-2 border-b render-hairline px-4 pb-3 pt-1
  flexEndTight: {
    display: "flex",
    flexShrink: "0",
    alignItems: "flex-end",
    gap: space.md,
    borderBottomWidth: "1px",
    paddingLeft: space.xl,
    paddingRight: space.xl,
    paddingBottom: space.lg,
    paddingTop: space.xs,
    borderColor: "rgb(255 255 255 / 10%)",
  },
  // min-w-0 flex-1
  fillNarrowable: {
    minWidth: "0px",
    flex: "1 1 0%",
  },
  // sr-only
  srOnly: {
    position: "absolute",
    width: "1px",
    height: "1px",
    padding: space.none,
    margin: "-1px",
    overflow: "hidden",
    clip: "rect(0, 0, 0, 0)",
    whiteSpace: "nowrap",
    borderWidth: "0",
  },
  // relative block
  relBlock: {
    position: "relative",
    display: "block",
  },
  // pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground
  absMutedInert: {
    pointerEvents: "none",
    position: "absolute",
    left: "0.625rem",
    top: "50%",
    width: "0.875rem",
    height: "0.875rem",
    transform: "translate(0, -50%)",
    color: colors.mutedForeground,
  },
  // h-9 pl-8 text-xs
  xs: {
    height: "2.25rem",
    paddingLeft: space.xxxl,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
  },
  // min-h-0 flex-1 overflow-y-auto px-4 py-3
  fillScrollYShrinkable: {
    minHeight: "0px",
    flex: "1 1 0%",
    overflowY: "auto",
    paddingLeft: space.xl,
    paddingRight: space.xl,
    paddingTop: space.lg,
    paddingBottom: space.lg,
  },
  // min-h-64
  minH64: {
    minHeight: "16rem",
  },

  // text-micro uppercase tracking-meta
  fieldMetaLabel: {
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
  },

  // w-40
  filterField: {
    width: "10rem",
  },
});
