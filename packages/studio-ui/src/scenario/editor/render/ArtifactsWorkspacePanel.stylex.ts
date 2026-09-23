import * as stylex from "@stylexjs/stylex";
import { colors, space, stroke } from "../../../stylex/tokens.stylex";

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
    gap: space.s2,
    borderBottomWidth: stroke.hairline,
    paddingLeft: space.s4,
    paddingRight: space.s4,
    paddingBottom: space.s3,
    paddingTop: space.s1,
    borderColor: colors.hairline,
  },
  // min-w-0 flex-1
  fillNarrowable: {
    minWidth: "0px",
    flex: "1 1 0%",
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
    paddingLeft: space.s8,
  },
  // min-h-0 flex-1 overflow-y-auto px-4 py-3
  fillScrollYShrinkable: {
    minHeight: "0px",
    flex: "1 1 0%",
    overflowY: "auto",
    paddingLeft: space.s4,
    paddingRight: space.s4,
    paddingTop: space.s3,
    paddingBottom: space.s3,
  },
  // min-h-64
  minH64: {
    minHeight: "16rem",
  },

  // w-40
  filterField: {
    width: "10rem",
  },
});
