import * as stylex from "@stylexjs/stylex";
import { colors, layers, space, text } from "../../stylex/tokens.stylex";

export const styles = stylex.create({
  // render-view-enter absolute inset-0 z-20 flex min-h-0 flex-col text-foreground
  scenarioDatasetRenderPane: {
    position: "absolute",
    inset: "0",
    zIndex: layers.float,
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
    gap: space.s3,
    padding: space.s6,
    textAlign: "center",
  },
  // max-w-md text-sm text-destructive
  pSm: {
    maxWidth: "28rem",
    fontSize: text.sizeSm,
    lineHeight: text.lineSm,
    color: colors.danger,
  },
  // flex items-center gap-2
  divFlex2: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
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
});
