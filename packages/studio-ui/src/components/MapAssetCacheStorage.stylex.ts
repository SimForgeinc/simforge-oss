/**
 * StyleX for the map-cache storage block.
 *
 * The `control*` keys are the `Button` overrides this surface passes down.
 * They travel as `xstyle`, not as a `className`: `Button` compiles its own
 * height, colour and font size with StyleX, and an atomic rule outranks a
 * plain Tailwind utility no matter which order they are concatenated in.
 */
import * as stylex from "@stylexjs/stylex";
import { colors, space, text } from "../stylex/tokens.stylex";

export const styles = stylex.create({
  root: {
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.chip,
    paddingBlock: space.xl,
    color: "white",
  },
  compact: { borderTopWidth: 0, borderBottomWidth: 0, paddingBlock: 0, minWidth: 0 },
  compactLabel: { fontSize: text.sizeXs, letterSpacing: 0, whiteSpace: "normal", color: colors.textSubtle },
  compactStats: { flexDirection: "column", gap: space.xs, fontSize: text.sizeXs, letterSpacing: 0, textTransform: "none" },
  compactActions: { paddingLeft: 0 },
  /** The one-line location wraps in the compact readout: the column is narrow and the text is short. */
  compactLocation: { whiteSpace: "normal", overflow: "visible" },
  compactMessage: { marginLeft: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  head: {
    display: "flex",
    alignItems: "flex-start",
    gap: space.lg,
  },
  headIcon: {
    marginTop: "0.125rem",
    width: "1rem",
    height: "1rem",
    flexShrink: 0,
    color: colors.accent,
  },
  headText: {
    minWidth: 0,
    flex: 1,
  },
  eyebrow: {
    fontFamily: text.fontMeta,
    fontSize: "9px",
    fontWeight: text.weightBold,
    letterSpacing: text.trackingMetaWide,
    textTransform: "uppercase",
    color: "rgb(255 255 255 / 0.4)",
  },
  location: {
    marginTop: space.xs,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontFamily: text.fontMono,
    fontSize: text.sizeXs,
    color: "rgb(255 255 255 / 0.75)",
  },
  stats: {
    marginTop: space.md,
    display: "flex",
    flexWrap: "wrap",
    columnGap: "1.25rem",
    rowGap: space.xs,
    fontFamily: text.fontMono,
    fontSize: text.sizeMicro,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: "rgb(255 255 255 / 0.45)",
  },
  statLabel: { display: "inline" },
  statValue: { display: "inline", color: "rgb(255 255 255 / 0.7)" },
  statAccent: { display: "inline", marginLeft: space.lg, color: colors.accent },
  actions: {
    marginTop: space.lg,
    display: "flex",
    flexWrap: "wrap",
    gap: space.md,
    paddingLeft: "1.75rem",
  },
  hint: {
    marginTop: space.sm,
    paddingLeft: "1.75rem",
    fontSize: text.sizeXs,
    color: "rgb(255 255 255 / 0.45)",
  },
  confirm: {
    marginTop: space.lg,
    marginLeft: "1.75rem",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.chip,
    backgroundColor: "rgb(255 255 255 / 0.05)",
    padding: space.lg,
    fontSize: text.sizeXs,
    color: "rgb(255 255 255 / 0.7)",
  },
  confirmActions: {
    marginTop: space.md,
    display: "flex",
    gap: space.md,
  },
  unavailable: {
    marginTop: space.lg,
    marginLeft: "1.75rem",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "rgb(232 224 68 / 0.4)",
    backgroundColor: colors.accentSoft,
    padding: space.md,
    fontSize: text.sizeXs,
    color: colors.accent,
  },
  error: {
    marginTop: space.lg,
    marginLeft: "1.75rem",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "hsl(var(--destructive) / 0.4)",
    backgroundColor: "hsl(var(--destructive) / 0.1)",
    padding: space.md,
    fontSize: text.sizeXs,
    color: colors.danger,
  },

  control: {
    height: "2rem",
    paddingInline: space.lg,
    fontSize: "11px",
    lineHeight: "inherit",
    borderColor: colors.lineStrong,
    backgroundColor: { default: "transparent", ":hover": "rgb(255 255 255 / 0.05)" },
    color: { default: "rgb(255 255 255 / 0.75)", ":hover": "rgb(255 255 255 / 1)" },
  },
  controlConfirm: {
    height: "2rem",
    paddingInline: space.lg,
    fontSize: "11px",
    lineHeight: "inherit",
    backgroundColor: { default: colors.accent, ":hover": colors.accentHover },
    color: colors.accentText,
  },
  controlDismiss: {
    height: "2rem",
    paddingInline: space.lg,
    fontSize: "11px",
    lineHeight: "inherit",
    backgroundColor: { default: null, ":hover": "transparent" },
    color: { default: "rgb(255 255 255 / 0.6)", ":hover": "rgb(255 255 255 / 1)" },
  },
});
