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
    paddingInline: space.s4,
  },
  // absolute inset-0 bg-black/70 backdrop-blur-sm
  closeButton: {
    position: "absolute",
    inset: "0",
    backgroundColor: "rgb(0 0 0 / 0.7)",
    backdropFilter: "blur(4px)",
  },
  // relative z-10 w-full max-w-lg border border-border bg-background p-5 shadow-2xl
  dialog: {
    position: "relative",
    zIndex: layers.raised,
    width: "100%",
    maxWidth: "32rem",
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
    marginTop: space.s1,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.mutedForeground,
  },
  // mt-4 block font-meta text-micro uppercase tracking-meta-wide text-muted-foreground
  labelMetaMicroUppercase: {
    marginTop: space.s4,
    display: "block",
    fontFamily: text.fontMeta,
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaWide,
    color: colors.mutedForeground,
  },
  // mt-4 block font-meta text-micro uppercase tracking-meta-wide text-muted-foreground
  labelMetaMicroUppercase2: {
    marginTop: space.s4,
    display: "block",
    fontFamily: text.fontMeta,
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaWide,
    color: colors.mutedForeground,
  },
  // mt-1.5 min-h-28 w-full resize-y border border-input bg-background px-3 py-2 text-sm leading-5 text-foreground ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50
  textareaSm: {
    marginTop: space.s1_5,
    minHeight: "7rem",
    width: "100%",
    resize: "vertical",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "hsl(var(--input))",
    backgroundColor: colors.bg,
    paddingInline: space.s3,
    paddingBlock: space.s2,
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    color: { default: colors.text, "::placeholder": colors.mutedForeground },
    outline: { default: null, ":focus-visible": "2px solid transparent" },
    outlineOffset: { default: null, ":focus-visible": "2px" },
    cursor: { default: null, ":disabled": "not-allowed" },
    opacity: { default: null, ":disabled": 0.5 },
    boxShadow: { default: null, ":focus-visible": `0 0 0 2px ${colors.ring}` },
  },
  // mt-3 text-xs
  copyableerrormessageXs: {
    marginTop: space.s3,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
  },
  // mt-5 flex justify-end gap-2
  divFlex: {
    marginTop: "1.25rem",
    display: "flex",
    justifyContent: "flex-end",
    gap: space.s2,
  },
});
