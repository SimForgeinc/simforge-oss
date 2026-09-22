import * as stylex from "@stylexjs/stylex";
import { colors, layers, motion, shadows, space, stroke, text } from "../../stylex/tokens.stylex";

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
    paddingInline: space.s4,
  },
  // absolute inset-0 bg-black/70 backdrop-blur-sm
  closeNewDatasetDialogButton: {
    position: "absolute",
    inset: "0",
    backgroundColor: "rgb(0 0 0 / 0.7)",
    backdropFilter: motion.blurSm,
  },
  // relative z-10 w-full max-w-sm border border-border bg-background p-5 shadow-2xl
  dialog: {
    position: "relative",
    zIndex: layers.raised,
    width: "100%",
    maxWidth: "24rem",
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.bg,
    padding: space.s5,
    boxShadow: shadows.elevation2xl,
  },
  // text-base font-semibold text-foreground
  h2BaseSemibold: {
    fontSize: text.sizeBase,
    lineHeight: text.lineBase,
    fontWeight: text.weightSemibold,
    color: colors.text,
  },
  // mt-1 text-xs text-muted-foreground
  pXs: {
    marginTop: space.s1,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.mutedForeground,
  },
  // mt-3 text-xs
  copyableerrormessageXs: {
    marginTop: space.s3,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
  },
  // mt-5 flex justify-end gap-2
  divFlex: {
    marginTop: space.s5,
    display: "flex",
    justifyContent: "flex-end",
    gap: space.s2,
  },
});
