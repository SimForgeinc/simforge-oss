import * as stylex from "@stylexjs/stylex";
import { colors, layers, layout, motion, shadows, space, stroke, text } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // h-8 gap-2 rounded-none border border-border bg-card/90 px-3 shadow-sm backdrop-blur
  borderedGlassyGap2: {
    height: "2rem",
    gap: space.s2,
    borderWidth: stroke.hairline,
    borderColor: colors.border,
    backgroundColor: "hsl(var(--card) / 0.9)",
    paddingLeft: space.s3,
    paddingRight: space.s3,
    boxShadow: shadows.elevationSm,
    backdropFilter: motion.blurMd,
  },
  // size-4
  size4: {
    width: "1rem",
    height: "1rem",
  },
  // fixed inset-0 z-[145] grid place-items-center bg-black/60 p-4 backdrop-blur-sm
  fixedGridCentered: {
    position: "fixed",
    inset: 0,
    zIndex: "145",
    display: "grid",
    placeItems: "center",
    backgroundColor: "rgb(0 0 0 / 0.6)",
    padding: space.s4,
    backdropFilter: motion.blurSm,
  },
  // w-full max-w-xl border border-white/15 bg-[#111111]/95 p-5 text-white shadow-[0_24px_80px_rgba(0,0,0,0.72)]
  whiteBorderedWide: {
    width: "100%",
    maxWidth: "36rem",
    borderWidth: stroke.hairline,
    borderColor: "rgb(255 255 255 / 0.15)",
    backgroundColor: "rgb(17 17 17 / 0.95)",
    padding: space.s5,
    color: colors.ink,
    boxShadow: "0 24px 80px rgba(0, 0, 0, 0.72)",
  },
  // flex items-start gap-3
  flexStartGap3: {
    display: "flex",
    alignItems: "flex-start",
    gap: space.s3,
  },
  // min-w-0 flex-1
  fillNarrowable: {
    minWidth: "0px",
    flex: "1 1 0%",
  },
  // font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-[#E8E044]
  capsMonoBold: {
    fontFamily: text.fontMono,
    fontSize: "10px",
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaWide,
    color: colors.accent,
  },
  // mt-1 text-lg font-semibold
  lgSemibold: {
    marginTop: space.s1,
    fontSize: text.sizeLg,
    lineHeight: text.lineLg,
    fontWeight: text.weightSemibold,
  },
  // mt-1 text-xs leading-5 text-white/55
  xs: {
    marginTop: space.s1,
    fontSize: text.sizeXs,
    lineHeight: text.lineSm,
    color: "rgb(255 255 255 / 0.55)",
  },
  // grid size-8 shrink-0 place-items-center text-white/50 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044]
  gridCenteredTight: {
    display: "grid",
    width: "2rem",
    height: "2rem",
    flexShrink: "0",
    placeItems: "center",
    color: {
      default: colors.textSubtle,
      ":hover": colors.ink,
    },
  },
  // mt-5 grid gap-3 sm:grid-cols-2
  gridGap3: {
    marginTop: space.s5,
    display: "grid",
    gap: space.s3,
    gridTemplateColumns: {
      default: null,
      [layout.bpSm]: "repeat(2, minmax(0, 1fr))",
    },
  },
  // group border border-[#E8E044]/55 bg-[#E8E044]/[0.07] p-4 text-left transition-colors hover:bg-[#E8E044]/[0.13] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044]
  borderedPad4LeftText: {
    borderWidth: stroke.hairline,
    borderColor: "rgb(232 224 68 / 0.55)",
    backgroundColor: {
      default: "rgb(232 224 68 / 0.07)",
      ":hover": "rgb(232 224 68 / 0.13)",
    },
    padding: space.s4,
    textAlign: "left",
  },
  // size-5 text-[#E8E044]
  size5Text: {
    width: "1.25rem",
    height: "1.25rem",
    color: colors.accent,
  },
  // mt-3 block text-sm text-white
  blockSmWhite: {
    marginTop: space.s3,
    display: "block",
    fontSize: text.sizeSm,
    lineHeight: text.lineSm,
    color: colors.ink,
  },
  // mt-1.5 block text-xs leading-5 text-white/55
  blockXs: {
    marginTop: space.s1_5,
    display: "block",
    fontSize: text.sizeXs,
    lineHeight: text.lineSm,
    color: "rgb(255 255 255 / 0.55)",
  },
  // group border border-white/15 bg-white/[0.03] p-4 text-left transition-colors hover:bg-white/[0.07] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044]
  borderedPad4LeftText2: {
    borderWidth: stroke.hairline,
    borderColor: "rgb(255 255 255 / 0.15)",
    backgroundColor: {
      default: "rgb(255 255 255 / 0.03)",
      ":hover": colors.glassRaised,
    },
    padding: space.s4,
    textAlign: "left",
  },
  // size-5 text-white/70
  size5TextWhite70: {
    width: "1.25rem",
    height: "1.25rem",
    color: colors.inkSecondary,
  },
  // fixed inset-0 z-[140] bg-black/45 p-3 md:p-7
  fixedInset0Pad3: {
    position: "fixed",
    inset: 0,
    zIndex: layers.tutorial,
    backgroundColor: colors.scrim,
    padding: {
      default: space.s3,
      [layout.bpMd]: space.s7,
    },
  },
  // mx-auto flex h-full w-full max-w-[1180px] flex-col overflow-hidden rounded-[28px] border border-border/80 bg-background/95 text-foreground shadow-2xl backdrop-blur-xl
  flexColInk: {
    marginLeft: "auto",
    marginRight: "auto",
    display: "flex",
    height: "100%",
    width: "100%",
    maxWidth: "1180px",
    flexDirection: "column",
    overflow: "hidden",
    borderWidth: stroke.hairline,
    borderColor: "hsl(var(--border) / 0.8)",
    backgroundColor: "hsl(var(--background) / 0.95)",
    color: colors.text,
    boxShadow: shadows.elevation2xl,
    backdropFilter: motion.blurPane,
  },
  // flex shrink-0 items-center gap-4 border-b border-border bg-card/90 px-5 py-3 backdrop-blur md:px-8
  flexCenterTight: {
    display: "flex",
    flexShrink: "0",
    alignItems: "center",
    gap: space.s4,
    borderBottomWidth: stroke.hairline,
    borderColor: colors.border,
    backgroundColor: "hsl(var(--card) / 0.9)",
    paddingLeft: {
      default: space.s5,
      [layout.bpMd]: space.s8,
    },
    paddingRight: {
      default: space.s5,
      [layout.bpMd]: space.s8,
    },
    paddingTop: space.s3,
    paddingBottom: space.s3,
    backdropFilter: motion.blurMd,
  },
  // size-5 text-primary
  accent: {
    width: "1.25rem",
    height: "1.25rem",
    color: colors.primary,
  },
  // min-w-0
  narrowable: {
    minWidth: "0px",
  },
  // text-base font-semibold
  semiboldBase: {
    fontSize: text.sizeBase,
    lineHeight: text.lineBase,
    fontWeight: text.weightSemibold,
  },
  // truncate text-xs text-muted-foreground
  xsMutedTruncate: {
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.mutedForeground,
  },
  // ml-auto hidden items-center gap-1 lg:flex
  hiddenCenterPushRight: {
    marginLeft: "auto",
    display: {
      default: "none",
      [layout.bpLg]: "flex",
    },
    alignItems: "center",
    gap: space.s1,
  },
  // px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground
  xsMuted: {
    paddingLeft: space.s3,
    paddingRight: space.s3,
    paddingTop: space.s2,
    paddingBottom: space.s2,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: {
      default: colors.mutedForeground,
      ":hover": colors.text,
    },
    backgroundColor: {
      default: null,
      ":hover": colors.hoverWash,
    },
  },
  // hidden shrink-0 border border-border bg-background/60 p-0.5 sm:flex
  hiddenTightBordered: {
    display: {
      default: "none",
      [layout.bpSm]: "flex",
    },
    flexShrink: "0",
    borderWidth: stroke.hairline,
    borderColor: colors.border,
    backgroundColor: "hsl(var(--background) / 0.6)",
    padding: space.s0_5,
  },
  // ml-auto size-8 shrink-0 gap-2 px-0 sm:h-8 sm:w-auto sm:px-3 lg:ml-2
  tightPushRightGap2: {
    marginLeft: {
      default: "auto",
      [layout.bpLg]: space.s2,
    },
    width: {
      default: "2rem",
      [layout.bpSm]: "auto",
    },
    height: {
      default: "2rem",
      [layout.bpSm]: "2rem",
    },
    flexShrink: "0",
    gap: space.s2,
    paddingLeft: {
      default: 0,
      [layout.bpSm]: space.s3,
    },
    paddingRight: {
      default: 0,
      [layout.bpSm]: space.s3,
    },
  },
  // size-3.5
  size35: {
    width: "0.875rem",
    height: "0.875rem",
  },
  // hidden sm:inline
  hidden: {
    display: {
      default: "none",
      [layout.bpSm]: "inline",
    },
  },
  // ml-auto size-8 shrink-0 md:ml-2
  tightPushRight: {
    marginLeft: {
      default: "auto",
      [layout.bpMd]: space.s2,
    },
    width: "2rem",
    height: "2rem",
    flexShrink: "0",
  },
  // min-h-0 flex-1 overflow-y-auto scroll-smooth
  fillScrollYShrinkable: {
    minHeight: "0px",
    flex: "1 1 0%",
    overflowY: "auto",
    scrollBehavior: "smooth",
  },
  /*
   * The guide body and each step list were `space-y-*`, a `> * + *` rule with
   * no StyleX form. Both hold only block-level children — sections, list items
   * — with no vertical margin of their own, so a flex column with the same gap
   * places them identically.
   */
  // mx-auto w-full max-w-6xl px-5 py-8 md:px-8 md:py-12
  wideCenteredX: {
    display: "flex",
    flexDirection: "column",
    gap: space.s10,
    marginLeft: "auto",
    marginRight: "auto",
    width: "100%",
    maxWidth: "72rem",
    paddingLeft: {
      default: space.s5,
      [layout.bpMd]: space.s8,
    },
    paddingRight: {
      default: space.s5,
      [layout.bpMd]: space.s8,
    },
    paddingTop: {
      default: space.s8,
      [layout.bpMd]: space.s12,
    },
    paddingBottom: {
      default: space.s8,
      [layout.bpMd]: space.s12,
    },
  },
  // mt-6 grid gap-3 lg:grid-cols-3
  gridGap32: {
    marginTop: space.s6,
    display: "grid",
    gap: space.s3,
    gridTemplateColumns: {
      default: null,
      [layout.bpLg]: "repeat(3, minmax(0, 1fr))",
    },
  },
  // border border-primary/30 bg-primary/[0.06] p-4
  borderedPad4: {
    borderWidth: stroke.hairline,
    borderColor: "hsl(var(--primary) / 0.3)",
    backgroundColor: "hsl(var(--primary) / 0.06)",
    padding: space.s4,
  },
  // flex min-h-9 flex-wrap items-center gap-1.5
  flexCenterWrap: {
    display: "flex",
    minHeight: "2.25rem",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space.s1_5,
  },
  // mt-4 text-sm font-semibold
  smSemibold: {
    marginTop: space.s4,
    fontSize: text.sizeSm,
    lineHeight: text.lineSm,
    fontWeight: text.weightSemibold,
  },
  // mt-1.5 text-xs leading-5 text-muted-foreground
  xsMuted2: {
    marginTop: space.s1_5,
    fontSize: text.sizeXs,
    lineHeight: text.lineSm,
    color: colors.mutedForeground,
  },
  // mt-3 grid gap-3 md:grid-cols-3
  gridGap33: {
    marginTop: space.s3,
    display: "grid",
    gap: space.s3,
    gridTemplateColumns: {
      default: null,
      [layout.bpMd]: "repeat(3, minmax(0, 1fr))",
    },
  },
  // flex gap-3 border border-border bg-card/60 p-4
  flexBorderedGap3: {
    display: "flex",
    gap: space.s3,
    borderWidth: stroke.hairline,
    borderColor: colors.border,
    backgroundColor: "hsl(var(--card) / 0.6)",
    padding: space.s4,
  },
  // mt-0.5 size-4 shrink-0 text-primary
  tightAccent: {
    marginTop: space.s0_5,
    width: "1rem",
    height: "1rem",
    flexShrink: "0",
    color: colors.primary,
  },
  // text-sm font-semibold
  smSemibold2: {
    fontSize: text.sizeSm,
    lineHeight: text.lineSm,
    fontWeight: text.weightSemibold,
  },
  // mt-1 text-xs leading-5 text-muted-foreground
  xsMuted3: {
    marginTop: space.s1,
    fontSize: text.sizeXs,
    lineHeight: text.lineSm,
    color: colors.mutedForeground,
  },
  // size-5
  size5: {
    width: "1.25rem",
    height: "1.25rem",
  },
  // grid gap-4 lg:grid-cols-3
  gridGap4: {
    display: "grid",
    gap: space.s4,
    gridTemplateColumns: {
      default: null,
      [layout.bpLg]: "repeat(3, minmax(0, 1fr))",
    },
  },
  // border border-border bg-card/50 p-5 md:p-6
  borderedPad5: {
    borderWidth: stroke.hairline,
    borderColor: colors.border,
    backgroundColor: "hsl(var(--card) / 0.5)",
    padding: {
      default: space.s5,
      [layout.bpMd]: space.s6,
    },
  },
  // flex items-start gap-4
  flexStartGap4: {
    display: "flex",
    alignItems: "flex-start",
    gap: space.s4,
  },
  // mt-1 size-5 shrink-0 text-primary
  tightAccent2: {
    marginTop: space.s1,
    width: "1.25rem",
    height: "1.25rem",
    flexShrink: "0",
    color: colors.primary,
  },
  // mt-5 grid gap-3 md:grid-cols-2
  gridGap34: {
    marginTop: space.s5,
    display: "grid",
    gap: space.s3,
    gridTemplateColumns: {
      default: null,
      [layout.bpMd]: "repeat(2, minmax(0, 1fr))",
    },
  },
  // text-[10px] font-bold uppercase tracking-[0.16em] text-primary
  capsAccentBold: {
    fontSize: "10px",
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaWide,
    color: colors.primary,
  },
  // mt-1 text-xl font-semibold tracking-tight md:text-2xl
  xlSemibold: {
    marginTop: space.s1,
    fontSize: {
      default: text.sizeXl,
      [layout.bpMd]: text.size2xl,
    },
    lineHeight: {
      default: text.lineLg,
      [layout.bpMd]: text.lineXl,
    },
    fontWeight: text.weightSemibold,
    letterSpacing: text.trackingTight,
  },
  // mt-2 max-w-2xl text-sm leading-6 text-muted-foreground
  smMuted: {
    marginTop: space.s2,
    maxWidth: "42rem",
    fontSize: text.sizeSm,
    lineHeight: text.lineBase,
    color: colors.mutedForeground,
  },
  // grid min-w-9 place-items-center border border-primary/50 bg-background px-2 py-1.5 font-mono text-xs font-semibold text-primary shadow-[0_2px_0_hsl(var(--border))]
  gridCenteredMono: {
    display: "grid",
    minWidth: "2.25rem",
    placeItems: "center",
    borderWidth: stroke.hairline,
    borderColor: "hsl(var(--primary) / 0.5)",
    backgroundColor: colors.bg,
    paddingLeft: space.s2,
    paddingRight: space.s2,
    paddingTop: space.s1_5,
    paddingBottom: space.s1_5,
    fontFamily: text.fontMono,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    fontWeight: text.weightSemibold,
    color: colors.primary,
    boxShadow: "0 2px 0 hsl(var(--border))",
  },
  // border border-border bg-card/60 p-5
  borderedPad52: {
    borderWidth: stroke.hairline,
    borderColor: colors.border,
    backgroundColor: "hsl(var(--card) / 0.6)",
    padding: space.s5,
  },
  // flex items-center gap-3 text-primary
  flexCenterAccent: {
    display: "flex",
    alignItems: "center",
    gap: space.s3,
    color: colors.primary,
  },
  // font-mono text-[10px] font-semibold tracking-[0.16em]
  monoSemibold: {
    fontFamily: text.fontMono,
    fontSize: "10px",
    fontWeight: text.weightSemibold,
    letterSpacing: text.trackingMetaWide,
  },
  // mt-4 text-lg font-semibold
  lgSemibold2: {
    marginTop: space.s4,
    fontSize: text.sizeLg,
    lineHeight: text.lineLg,
    fontWeight: text.weightSemibold,
  },
  // mt-4
  mt4StackLg: {
    marginTop: space.s4,
    display: "flex",
    flexDirection: "column",
    gap: space.s3,
  },
  // flex gap-2.5 text-xs leading-5 text-muted-foreground
  flexXsMuted: {
    display: "flex",
    gap: space.s2_5,
    fontSize: text.sizeXs,
    lineHeight: text.lineSm,
    color: colors.mutedForeground,
  },
  // mt-2 size-1 shrink-0 bg-primary
  tight: {
    marginTop: space.s2,
    width: "0.25rem",
    height: "0.25rem",
    flexShrink: "0",
    backgroundColor: colors.primary,
  },
  // border border-border bg-background/60 p-4
  borderedPad42: {
    borderWidth: stroke.hairline,
    borderColor: colors.border,
    backgroundColor: "hsl(var(--background) / 0.6)",
    padding: space.s4,
  },
  // flex items-center gap-2 text-sm font-semibold
  flexCenterSm: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    fontSize: text.sizeSm,
    lineHeight: text.lineSm,
    fontWeight: text.weightSemibold,
  },
  // text-primary
  accent2: {
    color: colors.primary,
  },
  // mt-2 text-xs leading-5 text-muted-foreground
  xsMuted4: {
    marginTop: space.s2,
    fontSize: text.sizeXs,
    lineHeight: text.lineSm,
    color: colors.mutedForeground,
  },
  // rounded-xl border border-primary/25 bg-card/70 p-5
  borderedPad53: {
    borderWidth: stroke.hairline,
    borderColor: "hsl(var(--primary) / 0.25)",
    backgroundColor: "hsl(var(--card) / 0.7)",
    padding: space.s5,
  },
  // text-sm font-semibold text-foreground
  smInkSemibold: {
    fontSize: text.sizeSm,
    lineHeight: text.lineSm,
    fontWeight: text.weightSemibold,
    color: colors.text,
  },
  // mt-3 text-xs leading-5 text-muted-foreground
  xsMuted5: {
    marginTop: space.s3,
    fontSize: text.sizeXs,
    lineHeight: text.lineSm,
    color: colors.mutedForeground,
  },

  // px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-[0.08em]
  modeToggle: {
    paddingLeft: space.s2_5,
    paddingRight: space.s2_5,
    paddingTop: space.s1_5,
    paddingBottom: space.s1_5,
    fontSize: "10px",
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    letterSpacing: "0.08em",
  },
  // bg-[#E8E044] text-black
  modeToggleActive: {
    backgroundColor: colors.accent,
    color: "rgb(0 0 0 / 1)",
  },
  // text-muted-foreground hover:text-foreground
  modeToggleIdle: {
    color: {
      default: colors.mutedForeground,
      ":hover": colors.text,
    },
  },
});
