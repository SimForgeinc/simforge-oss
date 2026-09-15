import * as stylex from "@stylexjs/stylex";
import { colors, space, text } from "../../stylex/tokens.stylex";

const spin = stylex.keyframes({ from: { transform: "rotate(0deg)" }, to: { transform: "rotate(360deg)" } });

export const styles = stylex.create({
  // space-y-1
  header: {
    display: "flex",
    flexDirection: "column",
    gap: space.xs,
  },
  // text-sm font-semibold text-foreground
  evaluateThisRender: {
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    fontWeight: text.weightSemibold,
    color: colors.text,
  },
  // text-xs leading-5 text-muted-foreground
  theRenderedCamerasBecomeTheC: {
    fontSize: text.sizeXs,
    lineHeight: "1.25rem",
    color: colors.mutedForeground,
  },
  // grid gap-x-8 gap-y-2 text-xs sm:grid-cols-2
  dlGridXs: {
    display: "grid",
    columnGap: space.xxxl,
    rowGap: space.md,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    gridTemplateColumns: { default: null, "@media (min-width: 640px)": "repeat(2, minmax(0, 1fr))" },
  },
  // min-w-0
  div: {
    minWidth: 0,
  },
  // uppercase tracking-wide text-muted-foreground
  renderedCameras: {
    textTransform: "uppercase",
    letterSpacing: "0.025em",
    color: colors.mutedForeground,
  },
  // mt-1 font-mono text-foreground
  ddMono: {
    marginTop: space.xs,
    fontFamily: text.fontMono,
    color: colors.text,
  },
  // min-w-0
  div2: {
    minWidth: 0,
  },
  // uppercase tracking-wide text-muted-foreground
  renderJob: {
    textTransform: "uppercase",
    letterSpacing: "0.025em",
    color: colors.mutedForeground,
  },
  // mt-1 truncate font-mono text-foreground
  ddTruncateMono: {
    marginTop: space.xs,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontFamily: text.fontMono,
    color: colors.text,
  },
  // text-xs leading-5 text-muted-foreground
  handoffReady: {
    fontSize: text.sizeXs,
    lineHeight: "1.25rem",
    color: colors.mutedForeground,
  },
  // flex flex-wrap items-center gap-3
  divFlex: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space.lg,
  },
  // size-4 animate-spin
  loader2Icon: {
    width: space.xl,
    height: space.xl,
    animationName: spin,
    animationDuration: "1s",
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
  },
  // size-4
  arrowrightIcon: {
    width: space.xl,
    height: space.xl,
  },
  // text-xs text-muted-foreground
  handoffProgress: {
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.mutedForeground,
  },
  // space-y-2 border-border border-t pt-3
  handoffProvenance: {
    borderColor: colors.border,
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    paddingTop: space.lg,
    display: "flex",
    flexDirection: "column",
    gap: space.md,
  },
  // text-xs font-semibold uppercase tracking-wide text-muted-foreground
  chainOfCustody: {
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    fontWeight: text.weightSemibold,
    textTransform: "uppercase",
    letterSpacing: "0.025em",
    color: colors.mutedForeground,
  },
  // space-y-1.5 text-xs
  olXs: {
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
  },
  // flex min-w-0 gap-3
  liFlex: {
    display: "flex",
    minWidth: 0,
    gap: space.lg,
  },
  // w-32 shrink-0 uppercase tracking-wide text-muted-foreground
  spanUppercase: {
    width: "8rem",
    flexShrink: 0,
    textTransform: "uppercase",
    letterSpacing: "0.025em",
    color: colors.mutedForeground,
  },
  // min-w-0 truncate font-mono text-foreground
  spanTruncateMono: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontFamily: text.fontMono,
    color: colors.text,
  },
});
