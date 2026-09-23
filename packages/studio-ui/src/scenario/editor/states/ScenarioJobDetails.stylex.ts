import * as stylex from "@stylexjs/stylex";
import { colors, shadows, space, stroke, text } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // h-full overflow-y-auto border border-border bg-card p-5 shadow-2xl
  borderedScrollYTall: {
    height: "100%",
    overflowY: "auto",
    borderWidth: stroke.hairline,
    borderColor: colors.hairline,
    backgroundColor: colors.card,
    padding: space.s5,
    boxShadow: shadows.elevation2xl,
  },
  // flex items-start
  flexStart: {
    display: "flex",
    alignItems: "flex-start",
  },
  // text-xs uppercase tracking-meta text-muted-foreground
  capsXsMuted: {
    color: colors.mutedForeground,
  },
  // mt-1 font-semibold
  semibold: {
    marginTop: space.s1,
    fontWeight: text.weightSemibold,
  },
  // motionStyles.editorMotion + -mr-1 -mt-1 ml-auto inline-flex size-7 items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card
  inlineFlexCenterMid: {
    marginRight: "-0.25rem",
    marginTop: "-0.25rem",
    marginLeft: "auto",
    display: "inline-flex",
    width: "1.75rem",
    height: "1.75rem",
    alignItems: "center",
    justifyContent: "center",
    color: {
      default: colors.mutedForeground,
      ":hover": colors.text,
    },
    backgroundColor: {
      default: null,
      ":hover": colors.hoverWash,
    },
  },
  // size-4
  size4: {
    width: "1rem",
    height: "1rem",
  },
  // mt-4 h-1.5 overflow-hidden bg-muted
  clip: {
    marginTop: space.s4,
    height: "0.375rem",
    overflow: "hidden",
    backgroundColor: colors.muted,
  },
  // h-full bg-primary
  tall: {
    height: "100%",
    backgroundColor: colors.primary,
  },
  // mb-2 flex border border-border p-2 text-xs
  flexXsBordered: {
    marginBottom: space.s2,
    display: "flex",
    borderWidth: stroke.hairline,
    borderColor: colors.hairline,
    padding: space.s2,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
  },
  // motionStyles.editorMotion + min-w-0 flex-1 text-left hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card
  fillNarrowableLeftText: {
    minWidth: "0px",
    flex: "1 1 0%",
    textAlign: "left",
    color: {
      default: null,
      ":hover": colors.primary,
    },
  },
  // text-primary
  accent: {
    color: colors.primary,
  },
  // ml-2 text-muted-foreground
  muted: {
    marginLeft: space.s2,
    color: colors.mutedForeground,
  },
  // ml-2 h-auto p-0 text-xs text-muted-foreground hover:text-foreground
  xsMutedPad0: {
    marginLeft: space.s2,
    height: "auto",
    padding: 0,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: {
      default: colors.mutedForeground,
      ":hover": colors.text,
    },
  },
  // mt-5 border-t border-border pt-4
  ruleT: {
    marginTop: space.s5,
    borderTopWidth: stroke.hairline,
    borderColor: colors.hairline,
    paddingTop: space.s4,
  },
  // text-xs font-semibold uppercase tracking-meta text-muted-foreground
  capsXsMuted2: {
    color: colors.mutedForeground,
  },
  // mt-3 (the space-y-2 moved onto the rows)
  mt3: {
    marginTop: space.s3,
  },
  /*
   * `space-y-2` was a `> * + *` rule, which StyleX cannot express from the
   * parent. The same effect from the child's side: an 8px top margin that
   * `:first-child` cancels, so only the rows that follow a sibling take it.
   * The artifact rows keep their own `mb-2`, which collapses against this
   * margin exactly as it did under the utility.
   */
  stackedMd: {
    marginTop: {
      default: space.s2,
      ":first-child": 0,
    },
  },
  // flex gap-4 text-xs
  flexXsGap4: {
    display: "flex",
    gap: space.s4,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
  },
  // w-32 shrink-0 text-muted-foreground
  tightMuted: {
    width: "8rem",
    flexShrink: "0",
    color: colors.mutedForeground,
  },
  // min-w-0 break-all text-foreground/90
  narrowableBreakAll: {
    minWidth: "0px",
    wordBreak: "break-all",
    color: colors.ink,
  },
});
