import * as stylex from "@stylexjs/stylex";
import { colors, space, text } from "../stylex/tokens.stylex";

export const styles = stylex.create({
  // mx-auto flex min-h-64 max-w-3xl flex-col items-center justify-center px-6 text-center
  divFlex: {
    marginInline: "auto",
    display: "flex",
    minHeight: "16rem",
    maxWidth: "48rem",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    paddingInline: space.xxl,
    textAlign: "center",
  },
  // text-lg font-semibold
  scenarioWorkspaceFailedToLoa: {
    fontSize: text.sizeLg,
    lineHeight: "1.75rem",
    fontWeight: text.weightSemibold,
  },
  // mt-2 text-sm text-muted-foreground
  pSm: {
    marginTop: space.md,
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    color: colors.mutedForeground,
  },
  // mt-1 font-mono text-micro text-muted-foreground
  reference: {
    marginTop: space.xs,
    fontFamily: text.fontMono,
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    color: colors.mutedForeground,
  },
  // flex h-full min-h-0 flex-col items-center justify-center gap-4 bg-background p-6 text-foreground
  sectionFlex: {
    display: "flex",
    height: "100%",
    minHeight: 0,
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: space.xl,
    backgroundColor: colors.bg,
    padding: space.xxl,
    color: colors.text,
  },
  // w-full max-w-lg space-y-3
  div: {
    width: "100%",
    maxWidth: "32rem",
    display: "flex",
    flexDirection: "column",
    gap: space.lg,
  },
  // font-display text-lg font-semibold
  thisDatasetCouldNotBeLoaded: {
    fontFamily: text.fontDisplay,
    fontSize: text.sizeLg,
    lineHeight: "1.75rem",
    fontWeight: text.weightSemibold,
  },
  // flex gap-2
  divFlex2: {
    display: "flex",
    gap: space.md,
  },
  // mx-auto flex min-h-64 max-w-3xl flex-col items-center justify-center px-6 text-center
  divFlex3: {
    marginInline: "auto",
    display: "flex",
    minHeight: "16rem",
    maxWidth: "48rem",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    paddingInline: space.xxl,
    textAlign: "center",
  },
  // text-lg font-semibold
  failedToOpenTheScenarioRevie: {
    fontSize: text.sizeLg,
    lineHeight: "1.75rem",
    fontWeight: text.weightSemibold,
  },
  // mt-2 text-sm text-muted-foreground
  pSm2: {
    marginTop: space.md,
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    color: colors.mutedForeground,
  },
});
