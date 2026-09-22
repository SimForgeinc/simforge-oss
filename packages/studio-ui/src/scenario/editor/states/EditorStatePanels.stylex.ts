import * as stylex from "@stylexjs/stylex";
import { colors, layout, space, stroke, text } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // grid h-full min-h-editor-shell place-items-center bg-background p-8
  gridCenteredTall: {
    display: "grid",
    height: "100%",
    minHeight: space.shellWidth,
    placeItems: "center",
    backgroundColor: colors.bg,
    padding: space.s8,
  },
  // max-w-md border border-border bg-card p-8 text-center
  borderedPad8CenterText: {
    maxWidth: "28rem",
    borderWidth: stroke.hairline,
    borderColor: colors.border,
    backgroundColor: colors.card,
    padding: space.s8,
    textAlign: "center",
  },
  // mx-auto mb-5 grid size-12 place-items-center bg-primary font-bold text-primary-foreground
  gridCenteredBold: {
    marginLeft: "auto",
    marginRight: "auto",
    marginBottom: space.s5,
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
    lineHeight: text.lineLg,
    fontWeight: text.weightSemibold,
  },
  // mt-2 text-sm leading-6 text-muted-foreground
  smMuted: {
    marginTop: space.s2,
    fontSize: text.sizeSm,
    lineHeight: text.lineBase,
    color: colors.mutedForeground,
  },
  // mt-6
  mt6: {
    marginTop: space.s6,
  },
  // text-center
  centerText: {
    textAlign: "center",
  },
  // grid min-h-editor-shell place-items-center bg-background p-8
  gridCenteredPad8: {
    display: "grid",
    minHeight: space.shellWidth,
    placeItems: "center",
    backgroundColor: colors.bg,
    padding: space.s8,
  },
  // w-full max-w-3xl
  wide: {
    width: "100%",
    maxWidth: "48rem",
  },
  // text-xs font-semibold uppercase tracking-meta-wider text-primary
  capsXsAccent: {
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    fontWeight: text.weightSemibold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaWider,
    color: colors.primary,
  },
  // mt-2 text-2xl font-semibold
  xxlSemibold: {
    marginTop: space.s2,
    fontSize: text.size2xl,
    lineHeight: text.lineXl,
    fontWeight: text.weightSemibold,
  },
  // mt-2 text-sm text-muted-foreground
  smMuted2: {
    marginTop: space.s2,
    fontSize: text.sizeSm,
    lineHeight: text.lineSm,
    color: colors.mutedForeground,
  },
  // mt-8 grid gap-3 md:grid-cols-2
  gridGap3: {
    marginTop: space.s8,
    display: "grid",
    gap: space.s3,
    gridTemplateColumns: {
      default: null,
      [layout.bpMd]: "repeat(2, minmax(0, 1fr))",
    },
  },
  // motionStyles.editorMotion + border border-border bg-card p-5 text-left hover:border-primary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background
  borderedPad5LeftText: {
    borderWidth: stroke.hairline,
    borderColor: {
      default: colors.border,
      ":hover": "hsl(var(--primary) / 0.6)",
    },
    backgroundColor: colors.card,
    padding: space.s5,
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
    marginTop: space.s1,
    display: "block",
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.mutedForeground,
  },
  // mt-3 block break-all font-mono text-micro text-muted-foreground
  blockMonoMicro: {
    marginTop: space.s3,
    display: "block",
    wordBreak: "break-all",
    fontFamily: text.fontMono,
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    color: colors.mutedForeground,
  },
});
