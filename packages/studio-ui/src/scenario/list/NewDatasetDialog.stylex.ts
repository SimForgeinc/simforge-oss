import * as stylex from "@stylexjs/stylex";
import { colors, layers, space, text } from "../../stylex/tokens.stylex";

export const styles = stylex.create({
  // pointer-events-auto fixed inset-0 z-50 flex items-center justify-center px-4
  divFixedFlex: {
    pointerEvents: "auto",
    position: "fixed",
    inset: "0",
    zIndex: layers.popover,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    paddingInline: space.xl,
  },
  // absolute inset-0 bg-black/70 backdrop-blur-sm
  closeNewDatasetDialogButton: {
    position: "absolute",
    inset: "0",
    backgroundColor: "rgb(0 0 0 / 0.7)",
    backdropFilter: "blur(4px)",
  },
  // relative z-10 w-full max-w-sm border border-border bg-background p-5 shadow-2xl
  dialog: {
    position: "relative",
    zIndex: layers.raised,
    width: "100%",
    maxWidth: "24rem",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.bg,
    padding: "1.25rem",
    boxShadow: "0 25px 50px -12px rgb(0 0 0 / 0.25)",
  },
  // text-base font-semibold text-foreground
  h2BaseSemibold: {
    fontSize: text.sizeBase,
    lineHeight: "1.5rem",
    fontWeight: text.weightSemibold,
    color: colors.text,
  },
  // mt-1 text-xs text-muted-foreground
  pXs: {
    marginTop: space.xs,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.mutedForeground,
  },
  // sr-only
  labelSrOnly: {
    position: "absolute",
    width: "1px",
    height: "1px",
    padding: 0,
    margin: "-1px",
    overflow: "hidden",
    clip: "rect(0, 0, 0, 0)",
    whiteSpace: "nowrap",
    borderWidth: 0,
  },
  // mt-3 text-xs
  copyableerrormessageXs: {
    marginTop: space.lg,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
  },
  // mt-5 flex justify-end gap-2
  divFlex: {
    marginTop: "1.25rem",
    display: "flex",
    justifyContent: "flex-end",
    gap: space.md,
  },
});
