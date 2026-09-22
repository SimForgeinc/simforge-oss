import * as stylex from "@stylexjs/stylex";
import { colors, space, stroke, text } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // flex flex-col gap-3 border-t render-hairline pt-4
  flexColRuleT: {
    display: "flex",
    flexDirection: "column",
    gap: space.s3,
    borderTopWidth: stroke.hairline,
    paddingTop: space.s4,
    borderColor: "rgb(255 255 255 / 10%)",
  },
  // flex items-center gap-2
  flexCenterGap2: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
  },
  // text-micro font-semibold uppercase tracking-meta text-muted-foreground
  capsMicroMuted: {
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    fontWeight: text.weightSemibold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: colors.mutedForeground,
  },
  // ml-auto flex items-center gap-1
  flexCenterPushRight: {
    marginLeft: "auto",
    display: "flex",
    alignItems: "center",
    gap: space.s1,
  },
  // size-3.5
  size35: {
    width: "0.875rem",
    height: "0.875rem",
  },
  // text-micro text-muted-foreground
  microMuted: {
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    color: colors.mutedForeground,
  },
  // flex flex-col gap-1
  flexColGap1: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
  },
  // text-micro uppercase tracking-meta text-muted-foreground
  capsMicroMuted2: {
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: colors.mutedForeground,
  },
  /*
   * `render-divide divide-y` was a `> * + *` rule and StyleX addresses only the
   * element it is applied to, so the hairline moves onto the rows: every row
   * but the first draws the top border the list used to hand down.
   */
  // render-glass border
  borderedDivided: {
    borderWidth: stroke.hairline,
    backgroundColor: colors.fillSubtle,
    borderColor: "rgb(255 255 255 / 10%)",
  },
  // (was the list's render-divide divide-y)
  rowDivided: {
    borderTopWidth: stroke.hairline,
    borderTopColor: "rgb(255 255 255 / 10%)",
  },
  // flex flex-col gap-1 px-2.5 py-2
  flexColGap12: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
    paddingLeft: space.s2_5,
    paddingRight: space.s2_5,
    paddingTop: space.s2,
    paddingBottom: space.s2,
  },
  // min-w-0 flex-1 truncate text-xs text-foreground
  fillXsInk: {
    minWidth: "0px",
    flex: "1 1 0%",
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.text,
  },
  // shrink-0 text-micro text-muted-foreground
  tightMicroMuted: {
    flexShrink: "0",
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    color: colors.mutedForeground,
  },
  // flex flex-col gap-2 render-glass border p-2.5
  flexColBordered: {
    display: "flex",
    flexDirection: "column",
    gap: space.s2,
    borderWidth: stroke.hairline,
    padding: space.s2_5,
    backgroundColor: colors.fillSubtle,
    borderColor: "rgb(255 255 255 / 10%)",
  },
  // min-h-16 text-xs
  xs: {
    minHeight: "4rem",
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
  },
  // h-8 text-xs
  xs2: {
    height: "2rem",
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
  },
  // self-start
  selfStart: {
    alignSelf: "flex-start",
  },

  // text-micro uppercase tracking-meta
  fieldMetaLabel: {
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
  },
});
