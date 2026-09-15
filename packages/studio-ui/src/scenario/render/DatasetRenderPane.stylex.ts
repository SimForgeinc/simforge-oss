import * as stylex from "@stylexjs/stylex";
import { colors, space, text } from "../../stylex/tokens.stylex";

export const styles = stylex.create({
  // render-view-enter absolute inset-0 z-20 flex min-h-0 flex-col text-foreground
  scenarioDatasetRenderPane: {
    position: "absolute",
    inset: "0",
    zIndex: 20,
    display: "flex",
    minHeight: 0,
    flexDirection: "column",
    color: colors.text,
  },
  // flex h-full flex-col items-center justify-center gap-3 p-6 text-center
  divFlex: {
    display: "flex",
    height: "100%",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: space.lg,
    padding: space.xxl,
    textAlign: "center",
  },
  // max-w-md text-sm text-destructive
  pSm: {
    maxWidth: "28rem",
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    color: colors.danger,
  },
  // flex items-center gap-2
  divFlex2: {
    display: "flex",
    alignItems: "center",
    gap: space.md,
  },
  // size-3.5
  tryAgainRefreshCw: {
    width: "0.875rem",
    height: "0.875rem",
  },
  // size-3.5
  closeX: {
    width: "0.875rem",
    height: "0.875rem",
  },
  // flex h-full flex-col items-center justify-center gap-3 p-6 text-center
  divFlex3: {
    display: "flex",
    height: "100%",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: space.lg,
    padding: space.xxl,
    textAlign: "center",
  },
  // max-w-md text-sm text-muted-foreground
  theSavedScenarioDetailsAreNo: {
    maxWidth: "28rem",
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    color: colors.mutedForeground,
  },
  // flex items-center gap-2
  divFlex4: {
    display: "flex",
    alignItems: "center",
    gap: space.md,
  },
  // size-3.5
  tryAgainRefreshCw2: {
    width: "0.875rem",
    height: "0.875rem",
  },
  // size-3.5
  closeX2: {
    width: "0.875rem",
    height: "0.875rem",
  },
});
