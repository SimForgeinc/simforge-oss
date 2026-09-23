import * as stylex from "@stylexjs/stylex";
import { colors, space, stroke, text } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // flex flex-wrap items-center gap-x-1 gap-y-1
  flexCenterWrap: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    MozColumnGap: "0.25rem",
    columnGap: space.s1,
    rowGap: space.s1,
  },
  // flex items-center gap-1
  flexCenterGap1: {
    display: "flex",
    alignItems: "center",
    gap: space.s1,
  },
  // w-3 border-t render-hairline
  ruleT: {
    width: "0.75rem",
    borderTopWidth: stroke.hairline,
    borderColor: colors.hairline,
  },
  // size-3
  size3: {
    width: "0.75rem",
    height: "0.75rem",
  },
  // font-mono
  mono: {
    fontFamily: text.fontMono,
  },
  // flex shrink-0 items-center justify-between gap-4 render-glass-raised border-t px-6 py-3.5
  flexCenterBetween: {
    display: "flex",
    flexShrink: "0",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.s4,
    borderTopWidth: stroke.hairline,
    paddingLeft: space.s6,
    paddingRight: space.s6,
    paddingTop: space.s3_5,
    paddingBottom: space.s3_5,
    backgroundColor: colors.fill,
    borderColor: colors.hairlineStrong,
  },
  // min-w-0 text-micro text-muted-foreground
  microMutedNarrowable: {
    minWidth: "0px",
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    color: colors.mutedForeground,
  },
  // flex shrink-0 items-center gap-2
  flexCenterTight: {
    display: "flex",
    flexShrink: "0",
    alignItems: "center",
    gap: space.s2,
  },
  // motionStyles.editorMotion + inline-flex h-9 items-center gap-1.5 border render-hairline render-glass px-3 text-micro font-bold uppercase tracking-meta text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
  inlineFlexCenterCaps: {
    display: "inline-flex",
    height: "2.25rem",
    alignItems: "center",
    gap: space.s1_5,
    borderWidth: stroke.hairline,
    paddingLeft: space.s3,
    paddingRight: space.s3,
    color: {
      default: colors.mutedForeground,
      ":hover": colors.text,
    },
    backgroundColor: colors.fillSubtle,
    borderColor: colors.hairline,
  },
  // size-3.5
  size35: {
    width: "0.875rem",
    height: "0.875rem",
  },
  // flex w-full min-w-0 items-center gap-2
  flexCenterWide: {
    display: "flex",
    width: "100%",
    minWidth: "0px",
    alignItems: "center",
    gap: space.s2,
  },
  // min-w-0 flex-1 truncate text-xs font-semibold text-foreground
  fillXsInk: {
    minWidth: "0px",
    flex: "1 1 0%",
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    fontWeight: text.weightSemibold,
    color: colors.text,
  },
  // text-micro leading-relaxed text-muted-foreground
  microMutedRelaxed: {
    fontSize: text.sizeMicro,
    lineHeight: text.lineRelaxed,
    color: colors.mutedForeground,
  },
  // motionStyles.editorMotion + inline-flex items-center gap-1.5 px-2 py-1 text-micro font-bold uppercase tracking-meta focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
  inlineFlexCenterCaps2: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1_5,
    paddingLeft: space.s2,
    paddingRight: space.s2,
    paddingTop: space.s1,
    paddingBottom: space.s1,
  },
  // render-step-center flex min-h-0 flex-1 flex-col overflow-hidden px-6 py-5
  flexColFill: {
    display: "flex",
    minHeight: "0px",
    flex: "1 1 0%",
    flexDirection: "column",
    overflow: "hidden",
    paddingLeft: space.s6,
    paddingRight: space.s6,
    paddingTop: space.s5,
    paddingBottom: space.s5,
  },
  // motionStyles.editorMotion + inline-flex h-9 items-center gap-1.5 px-5 text-micro font-bold uppercase tracking-meta focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-not-allowed border render-hairline render-glass text-muted-foreground
  inlineFlexCenterCaps3: {
    display: "inline-flex",
    height: "2.25rem",
    cursor: "not-allowed",
    alignItems: "center",
    gap: space.s1_5,
    borderWidth: stroke.hairline,
    paddingLeft: space.s5,
    paddingRight: space.s5,
    color: colors.mutedForeground,
    backgroundColor: colors.fillSubtle,
    borderColor: colors.hairline,
  },
  // motionStyles.editorMotion + inline-flex h-9 items-center gap-1.5 px-5 text-micro font-bold uppercase tracking-meta focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring bg-primary text-primary-foreground hover:bg-primary/90
  inlineFlexCenterCaps4: {
    display: "inline-flex",
    height: "2.25rem",
    alignItems: "center",
    gap: space.s1_5,
    backgroundColor: {
      default: colors.primary,
      ":hover": colors.accent,
    },
    paddingLeft: space.s5,
    paddingRight: space.s5,
    color: colors.primaryForeground,
  },
  // size-4 shrink-0 text-primary
  tightAccent: {
    width: "1rem",
    height: "1rem",
    flexShrink: "0",
    color: colors.primary,
  },
  // size-4 shrink-0 text-muted-foreground
  tightMuted: {
    width: "1rem",
    height: "1rem",
    flexShrink: "0",
    color: colors.mutedForeground,
  },
  // motionStyles.editorMotion + flex min-w-0 flex-col items-start gap-1 border p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
  flexColStart: {
    display: "flex",
    minWidth: "0px",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: space.s1,
    borderWidth: stroke.hairline,
    padding: space.s3,
    textAlign: "left",
  },
  // border-primary bg-primary/10
  borderPrimaryBgPrimary10: {
    borderColor: colors.primary,
    backgroundColor: colors.accentWash,
  },
  // render-glass hover:border-primary/40
  renderGlassHoverBorderPrimary40: {
    backgroundColor: colors.fillSubtle,
    borderColor: {
      default: colors.hairline,
      ":hover": colors.accentLineSubtle,
    },
  },
  // cursor-not-allowed opacity-50
  cursorNotAllowedOpacity50: {
    cursor: "not-allowed",
    opacity: "0.5",
  },

  // bg-primary text-primary-foreground
  stepActive: {
    backgroundColor: colors.primary,
    color: colors.primaryForeground,
  },
  // text-foreground/80 hover:text-primary
  stepDone: {
    color: {
      default: colors.inkSecondary,
      ":hover": colors.primary,
    },
  },
  // cursor-default text-muted-foreground/50
  stepTodo: {
    cursor: "default",
    color: colors.inkFaint,
  },
});
