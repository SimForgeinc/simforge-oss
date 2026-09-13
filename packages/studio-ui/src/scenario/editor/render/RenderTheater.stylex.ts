import * as stylex from "@stylexjs/stylex";
import { colors, text, space } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // render-view-enter flex min-h-0 flex-1 flex-col
  flexColFill: {
    display: "flex",
    minHeight: "0px",
    flex: "1 1 0%",
    flexDirection: "column",
  },
  // flex shrink-0 flex-col gap-2 border-b render-hairline px-5 py-3.5
  flexColTight: {
    display: "flex",
    flexShrink: "0",
    flexDirection: "column",
    gap: space.md,
    borderBottomWidth: "1px",
    paddingLeft: "1.25rem",
    paddingRight: "1.25rem",
    paddingTop: "0.875rem",
    paddingBottom: "0.875rem",
    borderColor: "rgb(255 255 255 / 10%)",
  },
  // flex items-center gap-3
  flexCenterGap3: {
    display: "flex",
    alignItems: "center",
    gap: space.lg,
  },
  // motionStyles.editorMotion + render-glass grid size-8 shrink-0 place-items-center border text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
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
    backgroundColor: colors.glass,
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
  // truncate text-sm font-semibold text-foreground
  smInkSemibold: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    fontWeight: text.weightSemibold,
    color: colors.text,
  },
  // mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-micro text-muted-foreground
  flexCenterWrap: {
    marginTop: space.xxs,
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    MozColumnGap: "0.75rem",
    columnGap: space.lg,
    rowGap: space.xs,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    color: colors.mutedForeground,
  },
  // inline-flex items-center gap-1
  inlineFlexCenterGap1: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.xs,
  },
  // size-3
  size3: {
    width: "0.75rem",
    height: "0.75rem",
  },
  // motionStyles.editorMotion + inline-flex shrink-0 items-center gap-1.5 border border-destructive/40 bg-destructive/10 px-3 py-1 text-micro font-medium text-destructive hover:bg-destructive/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50
  inlineFlexCenterTight: {
    display: "inline-flex",
    flexShrink: "0",
    alignItems: "center",
    gap: space.sm,
    borderWidth: "1px",
    borderColor: "hsl(var(--destructive) / 0.4)",
    backgroundColor: {
      default: "hsl(var(--destructive) / 0.1)",
      ":hover": "hsl(var(--destructive) / 0.2)",
    },
    paddingLeft: space.lg,
    paddingRight: space.lg,
    paddingTop: space.xs,
    paddingBottom: space.xs,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    fontWeight: text.weightMedium,
    color: colors.danger,
    opacity: {
      default: null,
      ":disabled": "0.5",
    },
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
  // motionStyles.editorMotion + render-glass inline-flex shrink-0 items-center gap-1.5 border px-3 py-1 text-micro font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50
  inlineFlexCenterTight2: {
    display: "inline-flex",
    flexShrink: "0",
    alignItems: "center",
    gap: space.sm,
    borderWidth: "1px",
    paddingLeft: space.lg,
    paddingRight: space.lg,
    paddingTop: space.xs,
    paddingBottom: space.xs,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    fontWeight: text.weightMedium,
    color: {
      default: colors.mutedForeground,
      ":hover": colors.text,
    },
    backgroundColor: colors.glass,
    borderColor: "rgb(255 255 255 / 10%)",
    opacity: {
      default: null,
      ":disabled": "0.5",
    },
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
  // text-xs text-destructive
  xsDanger: {
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.danger,
  },
  // min-h-0 flex-1
  fillShrinkable: {
    minHeight: "0px",
    flex: "1 1 0%",
  },
  // grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_auto] gap-0 overflow-hidden xl:grid-cols-[minmax(0,1fr)_22rem] xl:grid-rows-1
  gridFillClip: {
    display: "grid",
    minHeight: "0px",
    flex: "1 1 0%",
    gridTemplateRows: {
      default: "minmax(0, 1fr) auto",
      "@media (min-width: 1280px)": "repeat(1, minmax(0, 1fr))",
    },
    gap: space.none,
    overflow: "hidden",
    gridTemplateColumns: {
      default: null,
      "@media (min-width: 1280px)": "minmax(0, 1fr) 22rem",
    },
  },
  // flex min-h-0 min-w-0 flex-col gap-3 overflow-y-auto p-4
  flexColScrollY: {
    display: "flex",
    minHeight: "0px",
    minWidth: "0px",
    flexDirection: "column",
    gap: space.lg,
    overflowY: "auto",
    padding: space.xl,
  },
  // render-glass flex min-h-0 flex-col border
  flexColBordered: {
    display: "flex",
    minHeight: "0px",
    flexDirection: "column",
    borderWidth: "1px",
    backgroundColor: colors.glass,
    borderColor: "rgb(255 255 255 / 10%)",
  },
  // aspect-video w-full render-video-mat object-contain
  wideVideoContain: {
    aspectRatio: "16 / 9",
    width: "100%",
    objectFit: "contain",
    backgroundColor: colors.overlayMat,
  },
  // flex items-baseline justify-between gap-2 px-3 py-2
  flexBetweenBaseline: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: space.md,
    paddingLeft: space.lg,
    paddingRight: space.lg,
    paddingTop: space.md,
    paddingBottom: space.md,
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
  // shrink-0 text-micro uppercase tracking-meta text-muted-foreground
  tightCapsMicro: {
    flexShrink: "0",
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: colors.mutedForeground,
  },
  // render-glass flex min-h-72 flex-1 flex-col items-center justify-center gap-3 border p-8 text-center text-sm text-muted-foreground
  flexColCenter: {
    display: "flex",
    minHeight: "18rem",
    flex: "1 1 0%",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: space.lg,
    borderWidth: "1px",
    padding: space.xxxl,
    textAlign: "center",
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    color: colors.mutedForeground,
    backgroundColor: colors.glass,
    borderColor: "rgb(255 255 255 / 10%)",
  },
  // size-6 text-muted-foreground/50
  size6TextMutedForeground50: {
    width: "1.5rem",
    height: "1.5rem",
    color: "hsl(var(--muted-foreground) / 0.5)",
  },
  // flex shrink-0 flex-wrap gap-2
  flexWrapTight: {
    display: "flex",
    flexShrink: "0",
    flexWrap: "wrap",
    gap: space.md,
  },
  // aspect-video w-full render-video-mat object-cover
  wideVideoCover: {
    aspectRatio: "16 / 9",
    width: "100%",
    objectFit: "cover",
    backgroundColor: colors.overlayMat,
  },
  // block truncate px-2 py-1 text-micro uppercase tracking-meta text-muted-foreground
  blockCapsMicro: {
    display: "block",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    paddingLeft: space.md,
    paddingRight: space.md,
    paddingTop: space.xs,
    paddingBottom: space.xs,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: colors.mutedForeground,
  },
  // flex min-h-0 flex-col render-hairline xl:border-l
  flexColShrinkable: {
    display: "flex",
    minHeight: "0px",
    flexDirection: "column",
    borderColor: "rgb(255 255 255 / 10%)",
    borderLeftWidth: {
      default: null,
      "@media (min-width: 1280px)": "1px",
    },
  },
  // flex shrink-0 items-center gap-1 border-b render-hairline px-2 py-1.5
  flexCenterTight: {
    display: "flex",
    flexShrink: "0",
    alignItems: "center",
    gap: space.xs,
    borderBottomWidth: "1px",
    paddingLeft: space.md,
    paddingRight: space.md,
    paddingTop: space.sm,
    paddingBottom: space.sm,
    borderColor: "rgb(255 255 255 / 10%)",
  },
  // min-h-0 flex-1 overflow-y-auto
  fillScrollYShrinkable: {
    minHeight: "0px",
    flex: "1 1 0%",
    overflowY: "auto",
  },
  // flex flex-col gap-5 p-3
  flexColGap5: {
    display: "flex",
    flexDirection: "column",
    gap: "1.25rem",
    padding: space.lg,
  },
  // p-3
  pad3: {
    padding: space.lg,
  },
  // p-3 font-mono text-micro leading-relaxed text-foreground/75
  monoMicroPad3: {
    padding: space.lg,
    fontFamily: text.fontMono,
    fontSize: text.sizeMicro,
    lineHeight: "1.625",
    color: "hsl(var(--foreground) / 0.75)",
  },
  // flex h-full items-center justify-center text-muted-foreground
  flexCenterMid: {
    display: "flex",
    height: "100%",
    alignItems: "center",
    justifyContent: "center",
    color: colors.mutedForeground,
  },
  // flex gap-3
  flexGap3: {
    display: "flex",
    gap: space.lg,
  },
  // shrink-0 text-muted-foreground
  tightMuted: {
    flexShrink: "0",
    color: colors.mutedForeground,
  },
  // break-all
  breakAll: {
    wordBreak: "break-all",
  },
  // grid gap-x-4 gap-y-2 text-xs sm:grid-cols-[7.5rem_minmax(0,1fr)]
  gridXs: {
    display: "grid",
    MozColumnGap: "1rem",
    columnGap: space.xl,
    rowGap: space.md,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    gridTemplateColumns: {
      default: null,
      "@media (min-width: 640px)": "7.5rem minmax(0, 1fr)",
    },
  },
  // text-micro uppercase tracking-meta text-muted-foreground
  capsMicroMuted: {
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: colors.mutedForeground,
  },
  // motionStyles.editorMotion + relative w-40 shrink-0 overflow-hidden border text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring border-primary
  relTightBordered: {
    position: "relative",
    width: "10rem",
    flexShrink: "0",
    overflow: "hidden",
    borderWidth: "1px",
    borderColor: colors.primary,
    textAlign: "left",
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
  // motionStyles.editorMotion + relative w-40 shrink-0 overflow-hidden border text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring render-glass hover:border-primary/50
  relTightBordered2: {
    position: "relative",
    width: "10rem",
    flexShrink: "0",
    overflow: "hidden",
    borderWidth: "1px",
    textAlign: "left",
    backgroundColor: colors.glass,
    borderColor: {
      default: "rgb(255 255 255 / 10%)",
      ":hover": "hsl(var(--primary) / 0.5)",
    },
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
  // motionStyles.editorMotion + px-2.5 py-1.5 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring render-glass-raised border text-foreground
  xsInkMedium2: {
    borderWidth: "1px",
    paddingLeft: "0.625rem",
    paddingRight: "0.625rem",
    paddingTop: space.sm,
    paddingBottom: space.sm,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    fontWeight: text.weightMedium,
    color: colors.text,
    backgroundColor: colors.glassRaised,
    borderColor: colors.lineStrong,
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
  // motionStyles.editorMotion + px-2.5 py-1.5 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring text-muted-foreground hover:text-foreground
  xsMutedMedium: {
    paddingLeft: "0.625rem",
    paddingRight: "0.625rem",
    paddingTop: space.sm,
    paddingBottom: space.sm,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    fontWeight: text.weightMedium,
    color: {
      default: colors.mutedForeground,
      ":hover": colors.text,
    },
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
  // min-w-0 break-all text-foreground font-mono text-micro
  monoMicroInk: {
    minWidth: "0px",
    wordBreak: "break-all",
    fontFamily: text.fontMono,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    color: colors.text,
  },
  // min-w-0 break-all text-foreground
  inkNarrowableBreakAll: {
    minWidth: "0px",
    wordBreak: "break-all",
    color: colors.text,
  },
});
