import * as stylex from "@stylexjs/stylex";
import { colors, layout, space, stroke, text } from "../../../stylex/tokens.stylex";

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
    gap: space.s2,
    borderBottomWidth: stroke.hairline,
    paddingLeft: space.s5,
    paddingRight: space.s5,
    paddingTop: space.s3_5,
    paddingBottom: space.s3_5,
    borderColor: colors.hairline,
  },
  // flex items-center gap-3
  flexCenterGap3: {
    display: "flex",
    alignItems: "center",
    gap: space.s3,
  },
  // motionStyles.editorMotion + render-glass grid size-8 shrink-0 place-items-center border text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
  gridCenteredTight: {
    display: "grid",
    width: "2rem",
    height: "2rem",
    flexShrink: "0",
    placeItems: "center",
    borderWidth: stroke.hairline,
    color: {
      default: colors.mutedForeground,
      ":hover": colors.text,
    },
    backgroundColor: colors.fillSubtle,
    borderColor: colors.hairline,
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
    fontSize: text.sizeSm,
    lineHeight: text.lineSm,
    fontWeight: text.weightSemibold,
    color: colors.text,
  },
  // mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-micro text-muted-foreground
  flexCenterWrap: {
    marginTop: space.s0_5,
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    MozColumnGap: "0.75rem",
    columnGap: space.s3,
    rowGap: space.s1,
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    color: colors.mutedForeground,
  },
  // inline-flex items-center gap-1
  inlineFlexCenterGap1: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1,
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
    gap: space.s1_5,
    borderWidth: stroke.hairline,
    borderColor: colors.critical,
    backgroundColor: {
      default: colors.criticalWash,
      ":hover": colors.criticalWash,
    },
    paddingLeft: space.s3,
    paddingRight: space.s3,
    paddingTop: space.s1,
    paddingBottom: space.s1,
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    fontWeight: text.weightMedium,
    color: colors.danger,
    opacity: {
      default: null,
      ":disabled": "0.5",
    },
  },
  // motionStyles.editorMotion + render-glass inline-flex shrink-0 items-center gap-1.5 border px-3 py-1 text-micro font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50
  inlineFlexCenterTight2: {
    display: "inline-flex",
    flexShrink: "0",
    alignItems: "center",
    gap: space.s1_5,
    borderWidth: stroke.hairline,
    paddingLeft: space.s3,
    paddingRight: space.s3,
    paddingTop: space.s1,
    paddingBottom: space.s1,
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    fontWeight: text.weightMedium,
    color: {
      default: colors.mutedForeground,
      ":hover": colors.text,
    },
    backgroundColor: colors.fillSubtle,
    borderColor: colors.hairline,
    opacity: {
      default: null,
      ":disabled": "0.5",
    },
  },
  // text-xs text-destructive
  xsDanger: {
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.danger,
  },
  // What the job result records beside the video: allowed substitutions and engine warnings.
  resultNotes: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
  },
  resultNote: {
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.warning,
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
      [layout.bpXl]: "repeat(1, minmax(0, 1fr))",
    },
    gap: 0,
    overflow: "hidden",
    gridTemplateColumns: {
      default: null,
      [layout.bpXl]: "minmax(0, 1fr) 22rem",
    },
  },
  // flex min-h-0 min-w-0 flex-col gap-3 overflow-y-auto p-4
  flexColScrollY: {
    display: "flex",
    minHeight: "0px",
    minWidth: "0px",
    flexDirection: "column",
    gap: space.s3,
    overflowY: "auto",
    padding: space.s4,
  },
  // render-glass flex min-h-0 flex-col border
  flexColBordered: {
    display: "flex",
    flexShrink: 0,
    minHeight: "0px",
    flexDirection: "column",
    borderWidth: stroke.hairline,
    backgroundColor: colors.fillSubtle,
    borderColor: colors.hairline,
  },
  // aspect-video w-full render-video-mat object-contain
  wideVideoContain: {
    aspectRatio: "16 / 9",
    width: "100%",
    objectFit: "contain",
    backgroundColor: colors.scrimLight,
  },
  // flex items-baseline justify-between gap-2 px-3 py-2
  flexBetweenBaseline: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: space.s2,
    paddingLeft: space.s3,
    paddingRight: space.s3,
    paddingTop: space.s2,
    paddingBottom: space.s2,
  },
  // truncate text-xs font-medium text-foreground
  xsInkMedium: {
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    fontWeight: text.weightMedium,
    color: colors.text,
  },
  // shrink-0 text-micro uppercase tracking-meta text-muted-foreground
  tightCapsMicro: {
    flexShrink: "0",
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
    gap: space.s3,
    borderWidth: stroke.hairline,
    padding: space.s8,
    textAlign: "center",
    fontSize: text.sizeSm,
    lineHeight: text.lineSm,
    color: colors.mutedForeground,
    backgroundColor: colors.fillSubtle,
    borderColor: colors.hairline,
  },
  // size-6 text-muted-foreground/50
  size6TextMutedForeground50: {
    width: "1.5rem",
    height: "1.5rem",
    color: colors.inkFaint,
  },
  // flex shrink-0 flex-wrap gap-2
  flexWrapTight: {
    display: "flex",
    flexShrink: "0",
    flexWrap: "wrap",
    gap: space.s2,
  },
  // aspect-video w-full render-video-mat object-cover
  wideVideoCover: {
    aspectRatio: "16 / 9",
    width: "100%",
    objectFit: "cover",
    backgroundColor: colors.scrimLight,
  },
  // block truncate px-2 py-1 text-micro uppercase tracking-meta text-muted-foreground
  blockCapsMicro: {
    display: "block",
    paddingLeft: space.s2,
    paddingRight: space.s2,
    paddingTop: space.s1,
    paddingBottom: space.s1,
    color: colors.mutedForeground,
  },
  // flex min-h-0 flex-col render-hairline xl:border-l
  flexColShrinkable: {
    display: "flex",
    minHeight: "0px",
    flexDirection: "column",
    borderColor: colors.hairline,
    borderLeftWidth: {
      default: null,
      [layout.bpXl]: stroke.hairline,
    },
  },
  // flex shrink-0 items-center gap-1 border-b render-hairline px-2 py-1.5
  flexCenterTight: {
    display: "flex",
    flexShrink: "0",
    alignItems: "center",
    gap: space.s1,
    borderBottomWidth: stroke.hairline,
    paddingLeft: space.s2,
    paddingRight: space.s2,
    paddingTop: space.s1_5,
    paddingBottom: space.s1_5,
    borderColor: colors.hairline,
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
    gap: space.s5,
    padding: space.s3,
  },
  // p-3
  pad3: {
    padding: space.s3,
  },
  // p-3 font-mono text-micro leading-relaxed text-foreground/75
  monoMicroPad3: {
    padding: space.s3,
    fontFamily: text.fontMono,
    fontSize: text.sizeMicro,
    lineHeight: text.lineRelaxed,
    color: colors.inkSecondary,
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
    gap: space.s3,
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
    columnGap: space.s4,
    rowGap: space.s2,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    gridTemplateColumns: {
      default: null,
      [layout.bpSm]: "7.5rem minmax(0, 1fr)",
    },
  },
  // text-micro uppercase tracking-meta text-muted-foreground
  capsMicroMuted: {
    color: colors.mutedForeground,
  },
  // motionStyles.editorMotion + relative w-40 shrink-0 overflow-hidden border text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring border-primary
  relTightBordered: {
    position: "relative",
    width: "10rem",
    flexShrink: "0",
    overflow: "hidden",
    borderWidth: stroke.hairline,
    borderColor: colors.primary,
    textAlign: "left",
  },
  // motionStyles.editorMotion + relative w-40 shrink-0 overflow-hidden border text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring render-glass hover:border-primary/50
  relTightBordered2: {
    position: "relative",
    width: "10rem",
    flexShrink: "0",
    overflow: "hidden",
    borderWidth: stroke.hairline,
    textAlign: "left",
    backgroundColor: colors.fillSubtle,
    borderColor: {
      default: colors.hairline,
      ":hover": colors.accentLine,
    },
  },
  // motionStyles.editorMotion + px-2.5 py-1.5 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring render-glass-raised border text-foreground
  xsInkMedium2: {
    borderWidth: stroke.hairline,
    paddingLeft: space.s2_5,
    paddingRight: space.s2_5,
    paddingTop: space.s1_5,
    paddingBottom: space.s1_5,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    fontWeight: text.weightMedium,
    color: colors.text,
    backgroundColor: colors.fill,
    borderColor: colors.hairlineStrong,
  },
  // motionStyles.editorMotion + px-2.5 py-1.5 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring text-muted-foreground hover:text-foreground
  xsMutedMedium: {
    paddingLeft: space.s2_5,
    paddingRight: space.s2_5,
    paddingTop: space.s1_5,
    paddingBottom: space.s1_5,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    fontWeight: text.weightMedium,
    color: {
      default: colors.mutedForeground,
      ":hover": colors.text,
    },
  },
  // min-w-0 break-all text-foreground font-mono text-micro
  monoMicroInk: {
    minWidth: "0px",
    wordBreak: "break-all",
    fontFamily: text.fontMono,
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    color: colors.text,
  },
  // min-w-0 break-all text-foreground
  inkNarrowableBreakAll: {
    minWidth: "0px",
    wordBreak: "break-all",
    color: colors.text,
  },
});
