import * as stylex from "@stylexjs/stylex";
import { colors, text, space } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // flex flex-col gap-3 border-t render-hairline pt-4
  flexColRuleT: {
    display: "flex",
    flexDirection: "column",
    gap: space.lg,
    borderTopWidth: "1px",
    paddingTop: space.xl,
    borderColor: "rgb(255 255 255 / 10%)",
  },
  // flex items-center gap-2
  flexCenterGap2: {
    display: "flex",
    alignItems: "center",
    gap: space.md,
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
  // ml-auto flex items-center gap-1
  flexCenterPushRight: {
    marginLeft: "auto",
    display: "flex",
    alignItems: "center",
    gap: space.xs,
  },
  // size-3.5
  size35: {
    width: "0.875rem",
    height: "0.875rem",
  },
  // text-micro text-muted-foreground
  microMuted: {
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    color: colors.mutedForeground,
  },
  // flex flex-col gap-1
  flexColGap1: {
    display: "flex",
    flexDirection: "column",
    gap: space.xs,
  },
  // text-micro uppercase tracking-meta text-muted-foreground
  capsMicroMuted2: {
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
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
    borderWidth: "1px",
    backgroundColor: colors.glass,
    borderColor: "rgb(255 255 255 / 10%)",
  },
  // (was the list's render-divide divide-y)
  rowDivided: {
    borderTopWidth: "1px",
    borderTopColor: "rgb(255 255 255 / 10%)",
  },
  // flex flex-col gap-1 px-2.5 py-2
  flexColGap12: {
    display: "flex",
    flexDirection: "column",
    gap: space.xs,
    paddingLeft: "0.625rem",
    paddingRight: "0.625rem",
    paddingTop: space.md,
    paddingBottom: space.md,
  },
  // min-w-0 flex-1 truncate text-xs text-foreground
  fillXsInk: {
    minWidth: "0px",
    flex: "1 1 0%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.text,
  },
  // shrink-0 text-micro text-muted-foreground
  tightMicroMuted: {
    flexShrink: "0",
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    color: colors.mutedForeground,
  },
  // flex flex-col gap-2 render-glass border p-2.5
  flexColBordered: {
    display: "flex",
    flexDirection: "column",
    gap: space.md,
    borderWidth: "1px",
    padding: "0.625rem",
    backgroundColor: colors.glass,
    borderColor: "rgb(255 255 255 / 10%)",
  },
  // min-h-16 text-xs
  xs: {
    minHeight: "4rem",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
  },
  // h-8 text-xs
  xs2: {
    height: "2rem",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
  },
  // self-start
  selfStart: {
    alignSelf: "flex-start",
  },

  // text-micro uppercase tracking-meta
  fieldMetaLabel: {
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
  },
});
