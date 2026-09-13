import * as stylex from "@stylexjs/stylex";
import { colors, text, space, layers, motion } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // h-8 gap-2 rounded-none border border-border bg-card/90 px-3 shadow-sm backdrop-blur
  borderedGlassyGap2: {
    height: "2rem",
    gap: space.md,
    borderRadius: "0",
    borderWidth: "1px",
    borderColor: colors.border,
    backgroundColor: "hsl(var(--card) / 0.9)",
    paddingLeft: space.lg,
    paddingRight: space.lg,
    boxShadow: "0 1px 2px 0 rgb(0 0 0 / 0.05)",
    backdropFilter: "blur(8px)",
  },
  // size-4
  size4: {
    width: "1rem",
    height: "1rem",
  },
  // fixed inset-0 z-[145] grid place-items-center bg-black/60 p-4 backdrop-blur-sm
  fixedGridCentered: {
    position: "fixed",
    inset: space.none,
    zIndex: "145",
    display: "grid",
    placeItems: "center",
    backgroundColor: "rgb(0 0 0 / 0.6)",
    padding: space.xl,
    backdropFilter: "blur(4px)",
  },
  // w-full max-w-xl border border-white/15 bg-[#111111]/95 p-5 text-white shadow-[0_24px_80px_rgba(0,0,0,0.72)]
  whiteBorderedWide: {
    width: "100%",
    maxWidth: "36rem",
    borderWidth: "1px",
    borderColor: "rgb(255 255 255 / 0.15)",
    backgroundColor: "rgb(17 17 17 / 0.95)",
    padding: "1.25rem",
    color: "rgb(255 255 255 / 1)",
    boxShadow: "0 24px 80px rgba(0, 0, 0, 0.72)",
  },
  // flex items-start gap-3
  flexStartGap3: {
    display: "flex",
    alignItems: "flex-start",
    gap: space.lg,
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
    marginTop: space.xs,
    fontSize: text.sizeLg,
    lineHeight: "1.75rem",
    fontWeight: text.weightSemibold,
  },
  // mt-1 text-xs leading-5 text-white/55
  xs: {
    marginTop: space.xs,
    fontSize: text.sizeXs,
    lineHeight: "1.25rem",
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
      ":hover": "rgb(255 255 255 / 1)",
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
      ":focus-visible": "0 0 0 2px rgb(232 224 68 / 1)",
    },
  },
  // mt-5 grid gap-3 sm:grid-cols-2
  gridGap3: {
    marginTop: "1.25rem",
    display: "grid",
    gap: space.lg,
    gridTemplateColumns: {
      default: null,
      "@media (min-width: 640px)": "repeat(2, minmax(0, 1fr))",
    },
  },
  // group border border-[#E8E044]/55 bg-[#E8E044]/[0.07] p-4 text-left transition-colors hover:bg-[#E8E044]/[0.13] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044]
  borderedPad4LeftText: {
    borderWidth: "1px",
    borderColor: "rgb(232 224 68 / 0.55)",
    backgroundColor: {
      default: "rgb(232 224 68 / 0.07)",
      ":hover": "rgb(232 224 68 / 0.13)",
    },
    padding: space.xl,
    textAlign: "left",
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: motion.easeStandard,
    transitionDuration: "150ms",
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
      ":focus-visible": "0 0 0 2px rgb(232 224 68 / 1)",
    },
  },
  // size-5 text-[#E8E044]
  size5Text: {
    width: "1.25rem",
    height: "1.25rem",
    color: colors.accent,
  },
  // mt-3 block text-sm text-white
  blockSmWhite: {
    marginTop: space.lg,
    display: "block",
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    color: "rgb(255 255 255 / 1)",
  },
  // mt-1.5 block text-xs leading-5 text-white/55
  blockXs: {
    marginTop: space.sm,
    display: "block",
    fontSize: text.sizeXs,
    lineHeight: "1.25rem",
    color: "rgb(255 255 255 / 0.55)",
  },
  // group border border-white/15 bg-white/[0.03] p-4 text-left transition-colors hover:bg-white/[0.07] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044]
  borderedPad4LeftText2: {
    borderWidth: "1px",
    borderColor: "rgb(255 255 255 / 0.15)",
    backgroundColor: {
      default: "rgb(255 255 255 / 0.03)",
      ":hover": colors.glassRaised,
    },
    padding: space.xl,
    textAlign: "left",
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: motion.easeStandard,
    transitionDuration: "150ms",
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
      ":focus-visible": "0 0 0 2px rgb(232 224 68 / 1)",
    },
  },
  // size-5 text-white/70
  size5TextWhite70: {
    width: "1.25rem",
    height: "1.25rem",
    color: "rgb(255 255 255 / 0.7)",
  },
  // fixed inset-0 z-[140] bg-black/45 p-3 md:p-7
  fixedInset0Pad3: {
    position: "fixed",
    inset: space.none,
    zIndex: layers.tutorial,
    backgroundColor: colors.overlayScrim,
    padding: {
      default: space.lg,
      "@media (min-width: 768px)": "1.75rem",
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
    borderRadius: "28px",
    borderWidth: "1px",
    borderColor: "hsl(var(--border) / 0.8)",
    backgroundColor: "hsl(var(--background) / 0.95)",
    color: colors.text,
    boxShadow: "0 25px 50px -12px rgb(0 0 0 / 0.25)",
    backdropFilter: "blur(24px)",
  },
  // flex shrink-0 items-center gap-4 border-b border-border bg-card/90 px-5 py-3 backdrop-blur md:px-8
  flexCenterTight: {
    display: "flex",
    flexShrink: "0",
    alignItems: "center",
    gap: space.xl,
    borderBottomWidth: "1px",
    borderColor: colors.border,
    backgroundColor: "hsl(var(--card) / 0.9)",
    paddingLeft: {
      default: "1.25rem",
      "@media (min-width: 768px)": space.xxxl,
    },
    paddingRight: {
      default: "1.25rem",
      "@media (min-width: 768px)": space.xxxl,
    },
    paddingTop: space.lg,
    paddingBottom: space.lg,
    backdropFilter: "blur(8px)",
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
    lineHeight: "1.5rem",
    fontWeight: text.weightSemibold,
  },
  // truncate text-xs text-muted-foreground
  xsMutedTruncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.mutedForeground,
  },
  // ml-auto hidden items-center gap-1 lg:flex
  hiddenCenterPushRight: {
    marginLeft: "auto",
    display: {
      default: "none",
      "@media (min-width: 1024px)": "flex",
    },
    alignItems: "center",
    gap: space.xs,
  },
  // px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground
  xsMuted: {
    paddingLeft: space.lg,
    paddingRight: space.lg,
    paddingTop: space.md,
    paddingBottom: space.md,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: {
      default: colors.mutedForeground,
      ":hover": colors.text,
    },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: motion.easeStandard,
    transitionDuration: "150ms",
    backgroundColor: {
      default: null,
      ":hover": "hsl(var(--accent))",
    },
  },
  // hidden shrink-0 border border-border bg-background/60 p-0.5 sm:flex
  hiddenTightBordered: {
    display: {
      default: "none",
      "@media (min-width: 640px)": "flex",
    },
    flexShrink: "0",
    borderWidth: "1px",
    borderColor: colors.border,
    backgroundColor: "hsl(var(--background) / 0.6)",
    padding: space.xxs,
  },
  // ml-auto size-8 shrink-0 gap-2 px-0 sm:h-8 sm:w-auto sm:px-3 lg:ml-2
  tightPushRightGap2: {
    marginLeft: {
      default: "auto",
      "@media (min-width: 1024px)": space.md,
    },
    width: {
      default: "2rem",
      "@media (min-width: 640px)": "auto",
    },
    height: {
      default: "2rem",
      "@media (min-width: 640px)": "2rem",
    },
    flexShrink: "0",
    gap: space.md,
    paddingLeft: {
      default: space.none,
      "@media (min-width: 640px)": space.lg,
    },
    paddingRight: {
      default: space.none,
      "@media (min-width: 640px)": space.lg,
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
      "@media (min-width: 640px)": "inline",
    },
  },
  // ml-auto size-8 shrink-0 md:ml-2
  tightPushRight: {
    marginLeft: {
      default: "auto",
      "@media (min-width: 768px)": space.md,
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
    gap: "2.5rem",
    marginLeft: "auto",
    marginRight: "auto",
    width: "100%",
    maxWidth: "72rem",
    paddingLeft: {
      default: "1.25rem",
      "@media (min-width: 768px)": space.xxxl,
    },
    paddingRight: {
      default: "1.25rem",
      "@media (min-width: 768px)": space.xxxl,
    },
    paddingTop: {
      default: space.xxxl,
      "@media (min-width: 768px)": "3rem",
    },
    paddingBottom: {
      default: space.xxxl,
      "@media (min-width: 768px)": "3rem",
    },
  },
  // mt-6 grid gap-3 lg:grid-cols-3
  gridGap32: {
    marginTop: space.xxl,
    display: "grid",
    gap: space.lg,
    gridTemplateColumns: {
      default: null,
      "@media (min-width: 1024px)": "repeat(3, minmax(0, 1fr))",
    },
  },
  // border border-primary/30 bg-primary/[0.06] p-4
  borderedPad4: {
    borderWidth: "1px",
    borderColor: "hsl(var(--primary) / 0.3)",
    backgroundColor: "hsl(var(--primary) / 0.06)",
    padding: space.xl,
  },
  // flex min-h-9 flex-wrap items-center gap-1.5
  flexCenterWrap: {
    display: "flex",
    minHeight: "2.25rem",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space.sm,
  },
  // mt-4 text-sm font-semibold
  smSemibold: {
    marginTop: space.xl,
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    fontWeight: text.weightSemibold,
  },
  // mt-1.5 text-xs leading-5 text-muted-foreground
  xsMuted2: {
    marginTop: space.sm,
    fontSize: text.sizeXs,
    lineHeight: "1.25rem",
    color: colors.mutedForeground,
  },
  // mt-3 grid gap-3 md:grid-cols-3
  gridGap33: {
    marginTop: space.lg,
    display: "grid",
    gap: space.lg,
    gridTemplateColumns: {
      default: null,
      "@media (min-width: 768px)": "repeat(3, minmax(0, 1fr))",
    },
  },
  // flex gap-3 border border-border bg-card/60 p-4
  flexBorderedGap3: {
    display: "flex",
    gap: space.lg,
    borderWidth: "1px",
    borderColor: colors.border,
    backgroundColor: "hsl(var(--card) / 0.6)",
    padding: space.xl,
  },
  // mt-0.5 size-4 shrink-0 text-primary
  tightAccent: {
    marginTop: space.xxs,
    width: "1rem",
    height: "1rem",
    flexShrink: "0",
    color: colors.primary,
  },
  // text-sm font-semibold
  smSemibold2: {
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    fontWeight: text.weightSemibold,
  },
  // mt-1 text-xs leading-5 text-muted-foreground
  xsMuted3: {
    marginTop: space.xs,
    fontSize: text.sizeXs,
    lineHeight: "1.25rem",
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
    gap: space.xl,
    gridTemplateColumns: {
      default: null,
      "@media (min-width: 1024px)": "repeat(3, minmax(0, 1fr))",
    },
  },
  // border border-border bg-card/50 p-5 md:p-6
  borderedPad5: {
    borderWidth: "1px",
    borderColor: colors.border,
    backgroundColor: "hsl(var(--card) / 0.5)",
    padding: {
      default: "1.25rem",
      "@media (min-width: 768px)": space.xxl,
    },
  },
  // flex items-start gap-4
  flexStartGap4: {
    display: "flex",
    alignItems: "flex-start",
    gap: space.xl,
  },
  // mt-1 size-5 shrink-0 text-primary
  tightAccent2: {
    marginTop: space.xs,
    width: "1.25rem",
    height: "1.25rem",
    flexShrink: "0",
    color: colors.primary,
  },
  // mt-5 grid gap-3 md:grid-cols-2
  gridGap34: {
    marginTop: "1.25rem",
    display: "grid",
    gap: space.lg,
    gridTemplateColumns: {
      default: null,
      "@media (min-width: 768px)": "repeat(2, minmax(0, 1fr))",
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
    marginTop: space.xs,
    fontSize: {
      default: text.sizeXl,
      "@media (min-width: 768px)": text.size2xl,
    },
    lineHeight: {
      default: "1.75rem",
      "@media (min-width: 768px)": "2rem",
    },
    fontWeight: text.weightSemibold,
    letterSpacing: "-0.025em",
  },
  // mt-2 max-w-2xl text-sm leading-6 text-muted-foreground
  smMuted: {
    marginTop: space.md,
    maxWidth: "42rem",
    fontSize: text.sizeSm,
    lineHeight: "1.5rem",
    color: colors.mutedForeground,
  },
  // grid min-w-9 place-items-center border border-primary/50 bg-background px-2 py-1.5 font-mono text-xs font-semibold text-primary shadow-[0_2px_0_hsl(var(--border))]
  gridCenteredMono: {
    display: "grid",
    minWidth: "2.25rem",
    placeItems: "center",
    borderWidth: "1px",
    borderColor: "hsl(var(--primary) / 0.5)",
    backgroundColor: colors.bg,
    paddingLeft: space.md,
    paddingRight: space.md,
    paddingTop: space.sm,
    paddingBottom: space.sm,
    fontFamily: text.fontMono,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    fontWeight: text.weightSemibold,
    color: colors.primary,
    boxShadow: "0 2px 0 hsl(var(--border))",
  },
  // border border-border bg-card/60 p-5
  borderedPad52: {
    borderWidth: "1px",
    borderColor: colors.border,
    backgroundColor: "hsl(var(--card) / 0.6)",
    padding: "1.25rem",
  },
  // flex items-center gap-3 text-primary
  flexCenterAccent: {
    display: "flex",
    alignItems: "center",
    gap: space.lg,
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
    marginTop: space.xl,
    fontSize: text.sizeLg,
    lineHeight: "1.75rem",
    fontWeight: text.weightSemibold,
  },
  // mt-4
  mt4StackLg: {
    marginTop: space.xl,
    display: "flex",
    flexDirection: "column",
    gap: space.lg,
  },
  // flex gap-2.5 text-xs leading-5 text-muted-foreground
  flexXsMuted: {
    display: "flex",
    gap: "0.625rem",
    fontSize: text.sizeXs,
    lineHeight: "1.25rem",
    color: colors.mutedForeground,
  },
  // mt-2 size-1 shrink-0 bg-primary
  tight: {
    marginTop: space.md,
    width: "0.25rem",
    height: "0.25rem",
    flexShrink: "0",
    backgroundColor: colors.primary,
  },
  // border border-border bg-background/60 p-4
  borderedPad42: {
    borderWidth: "1px",
    borderColor: colors.border,
    backgroundColor: "hsl(var(--background) / 0.6)",
    padding: space.xl,
  },
  // flex items-center gap-2 text-sm font-semibold
  flexCenterSm: {
    display: "flex",
    alignItems: "center",
    gap: space.md,
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    fontWeight: text.weightSemibold,
  },
  // text-primary
  accent2: {
    color: colors.primary,
  },
  // mt-2 text-xs leading-5 text-muted-foreground
  xsMuted4: {
    marginTop: space.md,
    fontSize: text.sizeXs,
    lineHeight: "1.25rem",
    color: colors.mutedForeground,
  },
  // rounded-xl border border-primary/25 bg-card/70 p-5
  borderedPad53: {
    borderRadius: "0",
    borderWidth: "1px",
    borderColor: "hsl(var(--primary) / 0.25)",
    backgroundColor: "hsl(var(--card) / 0.7)",
    padding: "1.25rem",
  },
  // text-sm font-semibold text-foreground
  smInkSemibold: {
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    fontWeight: text.weightSemibold,
    color: colors.text,
  },
  // mt-3 text-xs leading-5 text-muted-foreground
  xsMuted5: {
    marginTop: space.lg,
    fontSize: text.sizeXs,
    lineHeight: "1.25rem",
    color: colors.mutedForeground,
  },

  // px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-[0.08em]
  modeToggle: {
    paddingLeft: "0.625rem",
    paddingRight: "0.625rem",
    paddingTop: "0.375rem",
    paddingBottom: "0.375rem",
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
