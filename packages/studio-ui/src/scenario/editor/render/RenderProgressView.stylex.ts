import * as stylex from "@stylexjs/stylex";
import { colors, text, space } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // render-view-enter flex min-h-0 flex-1 flex-col overflow-hidden
  flexColFill: {
    display: "flex",
    minHeight: "0px",
    flex: "1 1 0%",
    flexDirection: "column",
    overflow: "hidden",
  },
  // flex shrink-0 items-center gap-3 border-b render-hairline px-6 py-3
  flexCenterTight: {
    display: "flex",
    flexShrink: "0",
    alignItems: "center",
    gap: space.s3,
    borderBottomWidth: "1px",
    paddingLeft: space.s6,
    paddingRight: space.s6,
    paddingTop: space.s3,
    paddingBottom: space.s3,
    borderColor: "rgb(255 255 255 / 10%)",
  },
  // motionStyles.editorMotion + grid size-8 shrink-0 place-items-center border render-hairline render-glass text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
  gridCenteredTight: {
    display: "grid",
    width: "2rem",
    height: "2rem",
    flexShrink: "0",
    placeItems: "center",
    borderWidth: "1px",
    color: {
      default: colors.mutedForeground,
      ":hover": colors.text,
    },
    backgroundColor: colors.fillSubtle,
    borderColor: "rgb(255 255 255 / 10%)",
    outline: {
      default: null,
      ":focus-visible": "2px solid transparent",
    },
    outlineOffset: {
      default: null,
      ":focus-visible": "2px",
    },
    boxShadow: {
      default: null,
      ":focus-visible": "0 0 0 2px hsl(var(--ring))",
    },
  },
  // size-4
  size4: {
    width: "1rem",
    height: "1rem",
  },
  // min-w-0 flex-1
  fillNarrowable: {
    minWidth: "0px",
    flex: "1 1 0%",
  },
  // font-mono text-micro font-bold uppercase tracking-meta text-primary/90
  capsMonoMicro: {
    fontFamily: text.fontMono,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: "hsl(var(--primary) / 0.9)",
  },
  // truncate text-base font-extrabold leading-tight tracking-tight text-foreground
  inkTruncateBase: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: text.sizeBase,
    lineHeight: "1.25",
    fontWeight: "800",
    letterSpacing: "-0.025em",
    color: colors.text,
  },
  // ml-2 font-mono text-xs font-normal text-muted-foreground
  monoXsMuted: {
    marginLeft: space.s2,
    fontFamily: text.fontMono,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    fontWeight: text.weightNormal,
    color: colors.mutedForeground,
  },
  // motionStyles.editorMotion + inline-flex h-8 shrink-0 items-center gap-1.5 bg-primary px-3 text-micro font-bold uppercase tracking-meta text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
  inlineFlexCenterTight: {
    display: "inline-flex",
    height: "2rem",
    flexShrink: "0",
    alignItems: "center",
    gap: space.s1_5,
    backgroundColor: {
      default: colors.primary,
      ":hover": "hsl(var(--primary) / 0.9)",
    },
    paddingLeft: space.s3,
    paddingRight: space.s3,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: colors.primaryForeground,
    outline: {
      default: null,
      ":focus-visible": "2px solid transparent",
    },
    outlineOffset: {
      default: null,
      ":focus-visible": "2px",
    },
    boxShadow: {
      default: null,
      ":focus-visible": "0 0 0 2px hsl(var(--ring))",
    },
  },
  // size-3.5
  size35: {
    width: "0.875rem",
    height: "0.875rem",
  },
  // min-h-0 flex-1 overflow-y-auto px-6 py-4
  fillScrollYShrinkable: {
    minHeight: "0px",
    flex: "1 1 0%",
    overflowY: "auto",
    paddingLeft: space.s6,
    paddingRight: space.s6,
    paddingTop: space.s4,
    paddingBottom: space.s4,
  },
  // border border-dashed render-hairline px-3 py-2 text-xs text-destructive
  xsDangerBordered: {
    borderWidth: "1px",
    borderStyle: "dashed",
    paddingLeft: space.s3,
    paddingRight: space.s3,
    paddingTop: space.s2,
    paddingBottom: space.s2,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.danger,
    borderColor: "rgb(255 255 255 / 10%)",
  },
  // mb-1
  mb1: {
    marginBottom: space.s1,
  },
  // mb-4 flex flex-wrap items-baseline gap-x-3 text-micro text-muted-foreground
  flexBaselineWrap: {
    marginBottom: space.s4,
    display: "flex",
    flexWrap: "wrap",
    alignItems: "baseline",
    MozColumnGap: "0.75rem",
    columnGap: space.s3,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    color: colors.mutedForeground,
  },
  // text-destructive
  danger: {
    color: colors.danger,
  },
  // mb-4 grid gap-0
  gridGap0: {
    marginBottom: space.s4,
    display: "grid",
    gap: 0,
  },
  // shrink-0
  tight: {
    flexShrink: "0",
  },
  // size-3 text-primary
  accent: {
    width: "0.75rem",
    height: "0.75rem",
    color: colors.primary,
  },
  // size-3 text-muted-foreground/60
  size3TextMutedForeground60: {
    width: "0.75rem",
    height: "0.75rem",
    color: "hsl(var(--muted-foreground) / 0.6)",
  },
  // min-w-0 flex-1 font-medium
  fillMediumNarrowable: {
    minWidth: "0px",
    flex: "1 1 0%",
    fontWeight: text.weightMedium,
  },
  // ml-2 font-normal text-micro text-muted-foreground
  microMuted: {
    marginLeft: space.s2,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    fontWeight: text.weightNormal,
    color: colors.mutedForeground,
  },
  // shrink-0 font-mono text-micro text-muted-foreground
  tightMonoMicro: {
    flexShrink: "0",
    fontFamily: text.fontMono,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    color: colors.mutedForeground,
  },
  // mb-4 flex items-center gap-2 border border-primary/40 bg-primary/5 px-3 py-2 text-xs font-semibold text-foreground
  flexCenterXs: {
    marginBottom: space.s4,
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    borderWidth: "1px",
    borderColor: "hsl(var(--primary) / 0.4)",
    backgroundColor: "hsl(var(--primary) / 0.05)",
    paddingLeft: space.s3,
    paddingRight: space.s3,
    paddingTop: space.s2,
    paddingBottom: space.s2,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    fontWeight: text.weightSemibold,
    color: colors.text,
  },
  // mb-4 flex items-start gap-2 border border-destructive/40 px-3 py-2 text-xs text-destructive
  flexStartXs: {
    marginBottom: space.s4,
    display: "flex",
    alignItems: "flex-start",
    gap: space.s2,
    borderWidth: "1px",
    borderColor: "hsl(var(--destructive) / 0.4)",
    paddingLeft: space.s3,
    paddingRight: space.s3,
    paddingTop: space.s2,
    paddingBottom: space.s2,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.danger,
  },
  // mt-0.5 size-3.5 shrink-0
  tight2: {
    marginTop: space.s0_5,
    width: "0.875rem",
    height: "0.875rem",
    flexShrink: "0",
  },
  // ml-1 font-mono text-micro opacity-80
  monoMicro: {
    marginLeft: space.s1,
    fontFamily: text.fontMono,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    opacity: "0.8",
  },
  // mb-4 grid gap-x-4 gap-y-1 text-micro sm:grid-cols-2
  gridMicro: {
    marginBottom: space.s4,
    display: "grid",
    MozColumnGap: "1rem",
    columnGap: space.s4,
    rowGap: space.s1,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    gridTemplateColumns: {
      default: null,
      "@media (min-width: 640px)": "repeat(2, minmax(0, 1fr))",
    },
  },
  // mb-1 text-micro font-bold uppercase tracking-meta text-muted-foreground
  capsMicroMuted: {
    marginBottom: space.s1,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: colors.mutedForeground,
  },
  // ml-2 font-normal normal-case tracking-normal
  normalCase: {
    marginLeft: space.s2,
    fontWeight: text.weightNormal,
    textTransform: "none",
    letterSpacing: "0em",
  },
  // text-micro text-muted-foreground
  microMuted2: {
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    color: colors.mutedForeground,
  },
  // grid gap-0.5
  gridGap05: {
    display: "grid",
    gap: space.s0_5,
  },
  // flex items-baseline justify-between gap-2 border-b render-hairline py-1 text-xs last:border-b-0
  flexBetweenBaseline: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: space.s2,
    borderBottomWidth: {
      default: "1px",
      ":last-child": "0px",
    },
    paddingTop: space.s1,
    paddingBottom: space.s1,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    borderColor: "rgb(255 255 255 / 10%)",
  },
  // min-w-0 truncate font-medium text-foreground
  inkMediumTruncate: {
    minWidth: "0px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontWeight: text.weightMedium,
    color: colors.text,
  },
  // flex items-center gap-2 text-xs text-muted-foreground
  flexCenterXs2: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.mutedForeground,
  },
  // flex items-baseline justify-between gap-2 border-b render-hairline py-1
  flexBetweenBaseline2: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: space.s2,
    borderBottomWidth: "1px",
    paddingTop: space.s1,
    paddingBottom: space.s1,
    borderColor: "rgb(255 255 255 / 10%)",
  },
  // shrink-0 uppercase tracking-meta text-muted-foreground
  tightCapsMuted: {
    flexShrink: "0",
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: colors.mutedForeground,
  },
  // min-w-0 truncate text-right font-mono text-foreground
  monoInkTruncate: {
    minWidth: "0px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    textAlign: "right",
    fontFamily: text.fontMono,
    color: colors.text,
  },
  // flex items-baseline gap-2 border-l-2 py-1 pl-3 text-xs
  flexBaselineXs: {
    display: "flex",
    alignItems: "baseline",
    gap: space.s2,
    borderLeftWidth: "2px",
    paddingTop: space.s1,
    paddingBottom: space.s1,
    paddingLeft: space.s3,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
  },

  // border-primary text-foreground
  stageDone: {
    borderColor: colors.primary,
    color: colors.text,
  },
  // border-primary/60 text-foreground
  stageActive: {
    borderColor: "hsl(var(--primary) / 0.6)",
    color: colors.text,
  },
  // border-border text-muted-foreground
  stageTodo: {
    borderColor: colors.border,
    color: colors.mutedForeground,
  },

  // size-3
  size3Icon: {
    width: "0.75rem",
    height: "0.75rem",
  },
});
