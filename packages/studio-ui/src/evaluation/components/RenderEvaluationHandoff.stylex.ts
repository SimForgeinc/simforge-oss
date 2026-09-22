import * as stylex from "@stylexjs/stylex";
import { colors, layout, space, stroke, text } from "../../stylex/tokens.stylex";

export const styles = stylex.create({
  root: { display: "flex", flexDirection: "column", gap: space.s4, minWidth: 0 },
  // space-y-1
  header: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
  },
  // text-sm font-semibold text-foreground
  evaluateThisRender: {
    fontSize: text.sizeSm,
    lineHeight: text.lineSm,
    fontWeight: text.weightSemibold,
    color: colors.text,
  },
  // text-xs leading-5 text-muted-foreground
  theRenderedCamerasBecomeTheC: {
    fontSize: text.sizeXs,
    lineHeight: text.lineSm,
    color: colors.mutedForeground,
  },
  // grid gap-x-8 gap-y-2 text-xs sm:grid-cols-2
  dlGridXs: {
    display: "grid",
    columnGap: space.s8,
    rowGap: space.s2,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    gridTemplateColumns: { default: null, [layout.bpSm]: "repeat(2, minmax(0, 1fr))" },
  },
  // min-w-0
  div: {
    minWidth: 0,
  },
  // uppercase tracking-wide text-muted-foreground
  renderedCameras: {
    textTransform: "uppercase",
    letterSpacing: text.trackingWide,
    color: colors.mutedForeground,
  },
  // mt-1 font-mono text-foreground
  ddMono: {
    marginTop: space.s1,
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
    letterSpacing: text.trackingWide,
    color: colors.mutedForeground,
  },
  // mt-1 truncate font-mono text-foreground
  ddTruncateMono: {
    marginTop: space.s1,
    fontFamily: text.fontMono,
    color: colors.text,
  },
  // text-xs leading-5 text-muted-foreground
  handoffReady: {
    fontSize: text.sizeXs,
    lineHeight: text.lineSm,
    color: colors.mutedForeground,
  },
  // flex flex-wrap items-center gap-3
  divFlex: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space.s3,
  },
  // size-4 animate-spin
  loader2Icon: {
    width: space.s4,
    height: space.s4,
  },
  // size-4
  arrowrightIcon: {
    width: space.s4,
    height: space.s4,
  },
  // text-xs text-muted-foreground
  handoffProgress: {
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.mutedForeground,
  },
  // space-y-2 border-border border-t pt-3
  handoffProvenance: {
    borderColor: colors.hairline,
    borderTopWidth: stroke.hairline,
    borderTopStyle: "solid",
    paddingTop: space.s3,
    display: "flex",
    flexDirection: "column",
    gap: space.s2,
  },
  // text-xs font-semibold uppercase tracking-wide text-muted-foreground
  chainOfCustody: {
    color: colors.mutedForeground,
  },
  // space-y-1.5 text-xs
  olXs: {
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    display: "flex",
    flexDirection: "column",
    gap: space.s1_5,
  },
  // flex min-w-0 gap-3
  liFlex: {
    display: "flex",
    minWidth: 0,
    gap: space.s3,
  },
  // w-32 shrink-0 uppercase tracking-wide text-muted-foreground
  spanUppercase: {
    width: "8rem",
    flexShrink: 0,
    textTransform: "uppercase",
    letterSpacing: text.trackingWide,
    color: colors.mutedForeground,
  },
  // min-w-0 truncate font-mono text-foreground
  spanTruncateMono: {
    minWidth: 0,
    fontFamily: text.fontMono,
    color: colors.text,
  },
});
