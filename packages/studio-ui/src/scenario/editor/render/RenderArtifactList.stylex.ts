import * as stylex from "@stylexjs/stylex";
import { colors, space, stroke, text } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // px-1 py-6 text-center text-xs text-muted-foreground
  xsMutedCenterText: {
    paddingLeft: space.s1,
    paddingRight: space.s1,
    paddingTop: space.s6,
    paddingBottom: space.s6,
    textAlign: "center",
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.mutedForeground,
  },
  // flex flex-col gap-4
  flexColGap4: {
    display: "flex",
    flexDirection: "column",
    gap: space.s4,
  },
  // flex flex-col gap-1
  flexColGap1: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
  },
  // text-micro font-semibold uppercase tracking-meta text-muted-foreground
  capsMicroMuted: {
    color: colors.mutedForeground,
  },
  /*
   * `render-divide divide-y` was a `> * + *` rule, which StyleX cannot
   * express, so the hairline moves onto the rows: every row but the first
   * draws its own top border in the same colour the parent used to hand down.
   */
  // render-glass border
  borderedDivided: {
    borderWidth: stroke.hairline,
    backgroundColor: colors.fillSubtle,
    borderColor: colors.hairline,
  },
  // (was the list's render-divide divide-y)
  rowDivided: {
    borderTopWidth: stroke.hairline,
    borderTopColor: colors.hairline,
  },
  // flex items-center gap-3 px-2.5 py-2
  flexCenterGap3: {
    display: "flex",
    alignItems: "center",
    gap: space.s3,
    paddingLeft: space.s2_5,
    paddingRight: space.s2_5,
    paddingTop: space.s2,
    paddingBottom: space.s2,
  },
  // min-w-0 flex-1
  fillNarrowable: {
    minWidth: "0px",
    flex: "1 1 0%",
  },
  // Names wrap inside the row; metadata can truncate with its full title.
  xsInkMedium: {
    overflowWrap: "anywhere",
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    fontWeight: text.weightMedium,
    color: colors.text,
  },
  // truncate text-micro text-muted-foreground
  microMutedTruncate: {
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    color: colors.mutedForeground,
  },
  // shrink-0 text-micro uppercase tracking-meta text-destructive
  tightCapsMicro: {
    flexShrink: "0",
    color: colors.danger,
  },
  // flex shrink-0 items-center gap-1
  flexCenterTight: {
    display: "flex",
    flexShrink: "0",
    alignItems: "center",
    gap: space.s1,
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
  },
});
