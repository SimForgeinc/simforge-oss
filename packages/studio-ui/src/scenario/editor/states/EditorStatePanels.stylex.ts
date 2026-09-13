import * as stylex from "@stylexjs/stylex";
import { colors, text, space, motion } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // grid h-full min-h-editor-shell place-items-center bg-background p-8
  gridCenteredTall: {
    display: "grid",
    height: "100%",
    minHeight: space.shellWidth,
    placeItems: "center",
    backgroundColor: colors.bg,
    padding: space.xxxl,
  },
  // max-w-md border border-border bg-card p-8 text-center
  borderedPad8CenterText: {
    maxWidth: "28rem",
    borderWidth: "1px",
    borderColor: colors.border,
    backgroundColor: colors.card,
    padding: space.xxxl,
    textAlign: "center",
  },
  // mx-auto mb-5 grid size-12 place-items-center bg-primary font-bold text-primary-foreground
  gridCenteredBold: {
    marginLeft: "auto",
    marginRight: "auto",
    marginBottom: "1.25rem",
    display: "grid",
    width: "3rem",
    height: "3rem",
    placeItems: "center",
    backgroundColor: colors.primary,
    fontWeight: text.weightBold,
    color: colors.primaryForeground,
  },
  // text-xl font-semibold
  xlSemibold: {
    fontSize: text.sizeXl,
    lineHeight: "1.75rem",
    fontWeight: text.weightSemibold,
  },
  // mt-2 text-sm leading-6 text-muted-foreground
  smMuted: {
    marginTop: space.md,
    fontSize: text.sizeSm,
    lineHeight: "1.5rem",
    color: colors.mutedForeground,
  },
  // mt-6
  mt6: {
    marginTop: space.xxl,
  },
  // grid min-h-full place-items-center bg-transparent px-4 py-10 sm:px-6 sm:py-14
  gridCentered: {
    display: "grid",
    minHeight: "100%",
    placeItems: "center",
    backgroundColor: "transparent",
    paddingLeft: {
      default: space.xl,
      "@media (min-width: 640px)": space.xxl,
    },
    paddingRight: {
      default: space.xl,
      "@media (min-width: 640px)": space.xxl,
    },
    paddingTop: {
      default: "2.5rem",
      "@media (min-width: 640px)": "3.5rem",
    },
    paddingBottom: {
      default: "2.5rem",
      "@media (min-width: 640px)": "3.5rem",
    },
  },
  // w-full max-w-6xl px-1 py-2 text-white sm:px-3
  whiteWide: {
    width: "100%",
    maxWidth: "72rem",
    paddingLeft: {
      default: space.xs,
      "@media (min-width: 640px)": space.lg,
    },
    paddingRight: {
      default: space.xs,
      "@media (min-width: 640px)": space.lg,
    },
    paddingTop: space.md,
    paddingBottom: space.md,
    color: "rgb(255 255 255 / 1)",
  },
  // text-center
  centerText: {
    textAlign: "center",
  },
  // font-meta text-[10px] font-bold uppercase tracking-[0.22em] text-[#E8E044]
  capsMetaBold: {
    fontFamily: text.fontMeta,
    fontSize: "10px",
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaWidest,
    color: colors.accent,
  },
  // mt-2 text-3xl font-semibold tracking-tight text-white
  xxxlWhiteSemibold: {
    marginTop: space.md,
    fontSize: "1.875rem",
    lineHeight: "2.25rem",
    fontWeight: text.weightSemibold,
    letterSpacing: "-0.025em",
    color: "rgb(255 255 255 / 1)",
  },
  // mt-2 text-sm text-white/50
  sm: {
    marginTop: space.md,
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    color: colors.textSubtle,
  },
  // mt-7 flex items-center gap-4
  flexCenterGap4: {
    marginTop: "1.75rem",
    display: "flex",
    alignItems: "center",
    gap: space.xl,
  },
  // h-px flex-1 bg-white/10
  fill: {
    height: "1px",
    flex: "1 1 0%",
    backgroundColor: colors.chip,
  },
  // font-meta text-[9px] font-bold uppercase tracking-[0.18em] text-white/30
  capsMetaBold2: {
    fontFamily: text.fontMeta,
    fontSize: "9px",
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaWider,
    color: "rgb(255 255 255 / 0.3)",
  },
  // mt-4 grid grid-cols-4 gap-2 sm:gap-3
  gridCols4Gap2: {
    marginTop: space.xl,
    display: "grid",
    gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
    gap: {
      default: space.md,
      "@media (min-width: 640px)": space.lg,
    },
  },
  // group motionStyles.editorMotion + text-left hover:-translate-y-1 focus-visible:rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044]
  leftText: {
    textAlign: "left",
    borderRadius: {
      default: null,
      ":focus-visible": "0",
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
    transform: {
      default: null,
      ":hover": "translate(0, -0.25rem)",
    },
  },
  // relative block aspect-[16/9] overflow-hidden rounded-2xl ring-1 ring-inset ring-white/10
  relBlockClip: {
    position: "relative",
    display: "block",
    aspectRatio: "16/9",
    overflow: "hidden",
    borderRadius: "0",
    boxShadow: "inset 0 0 0 1px rgb(255 255 255 / 0.1)",
  },
  // absolute inset-0 bg-cover bg-center bg-no-repeat transition-transform duration-500 group-hover:scale-[1.04]
  absInset0: {
    position: "absolute",
    inset: space.none,
    backgroundSize: "cover",
    backgroundPosition: "center",
    backgroundRepeat: "no-repeat",
    transitionProperty: "transform",
    transitionTimingFunction: motion.easeStandard,
    transitionDuration: "500ms",
    animationDuration: "500ms",
  },
  // absolute inset-0 bg-gradient-to-t from-black/45 via-transparent to-transparent
  absInset02: {
    position: "absolute",
    inset: space.none,
    backgroundImage: "linear-gradient(to top, rgb(0 0 0 / 0.45), transparent, transparent)",
  },
  // absolute bottom-2 left-2 font-meta text-[9px] font-bold uppercase tracking-meta text-white/80
  absCapsMeta: {
    position: "absolute",
    bottom: space.md,
    left: space.md,
    fontFamily: text.fontMeta,
    fontSize: "9px",
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: "rgb(255 255 255 / 0.8)",
  },
  // block px-1 py-3
  block: {
    display: "block",
    paddingLeft: space.xs,
    paddingRight: space.xs,
    paddingTop: space.lg,
    paddingBottom: space.lg,
  },
  // flex items-center
  flexCenter: {
    display: "flex",
    alignItems: "center",
  },
  // font-semibold text-white
  whiteSemibold: {
    fontWeight: text.weightSemibold,
    color: "rgb(255 255 255 / 1)",
  },
  // ml-auto text-[9px] font-bold uppercase tracking-meta text-[#E8E044]
  capsBoldPushRight: {
    marginLeft: "auto",
    fontSize: "9px",
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: colors.accent,
  },
  // mt-1.5 block text-xs text-white/45
  blockXs: {
    marginTop: space.sm,
    display: "block",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: "rgb(255 255 255 / 0.45)",
  },
  // mt-4 border-t border-white/10 pt-4
  ruleT: {
    marginTop: space.xl,
    borderTopWidth: "1px",
    borderColor: "rgb(255 255 255 / 0.1)",
    paddingTop: space.xl,
  },
  // grid min-h-editor-shell place-items-center bg-background p-8
  gridCenteredPad8: {
    display: "grid",
    minHeight: space.shellWidth,
    placeItems: "center",
    backgroundColor: colors.bg,
    padding: space.xxxl,
  },
  // w-full max-w-3xl
  wide: {
    width: "100%",
    maxWidth: "48rem",
  },
  // text-xs font-semibold uppercase tracking-meta-wider text-primary
  capsXsAccent: {
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    fontWeight: text.weightSemibold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaWider,
    color: colors.primary,
  },
  // mt-2 text-2xl font-semibold
  xxlSemibold: {
    marginTop: space.md,
    fontSize: text.size2xl,
    lineHeight: "2rem",
    fontWeight: text.weightSemibold,
  },
  // mt-2 text-sm text-muted-foreground
  smMuted2: {
    marginTop: space.md,
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    color: colors.mutedForeground,
  },
  // mt-8 grid gap-3 md:grid-cols-2
  gridGap3: {
    marginTop: space.xxxl,
    display: "grid",
    gap: space.lg,
    gridTemplateColumns: {
      default: null,
      "@media (min-width: 768px)": "repeat(2, minmax(0, 1fr))",
    },
  },
  // motionStyles.editorMotion + border border-border bg-card p-5 text-left hover:border-primary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background
  borderedPad5LeftText: {
    borderWidth: "1px",
    borderColor: {
      default: colors.border,
      ":hover": "hsl(var(--primary) / 0.6)",
    },
    backgroundColor: colors.card,
    padding: "1.25rem",
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
      ":focus-visible": "0 0 0 2px hsl(var(--background)), 0 0 0 4px hsl(var(--ring))",
    },
  },
  // block font-semibold
  blockSemibold: {
    display: "block",
    fontWeight: text.weightSemibold,
  },
  // mt-1 block text-xs text-muted-foreground
  blockXsMuted: {
    marginTop: space.xs,
    display: "block",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.mutedForeground,
  },
  // mt-3 block break-all font-mono text-micro text-muted-foreground
  blockMonoMicro: {
    marginTop: space.lg,
    display: "block",
    wordBreak: "break-all",
    fontFamily: text.fontMono,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    color: colors.mutedForeground,
  },
});
