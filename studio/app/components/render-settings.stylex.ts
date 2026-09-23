import * as stylex from "@stylexjs/stylex";
import { colors, layers, motion, shadows, space, stroke, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

export const styles = stylex.create({
  /** Fills the switcher's content column; the confirmation overlays cover it. */
  root: { position: "relative", minWidth: 0, minHeight: 0, overflow: "hidden", color: colors.ink },
  footer: { display: "grid", gap: space.s2, minWidth: 0 },
  footerRow: { display: "flex", flexDirection: "column", alignItems: "stretch", gap: space.s1 },
  current: { fontSize: text.sizeXs, color: colors.inkMuted },
  overlay: {
    position: "absolute",
    inset: 0,
    zIndex: layers.sticky,
    display: "grid",
    placeItems: "center",
    backgroundColor: colors.scrim,
    padding: space.s5,
    backdropFilter: motion.blurPane,
  },
  dialog: {
    width: "100%",
    maxWidth: "28rem",
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: colors.hairline,
    backgroundColor: "rgba(16,16,16,.95)",
    padding: space.s6,
    boxShadow: shadows.elevation2xl,
  },
  dialogTitle: { fontSize: text.sizeXl, lineHeight: text.lineLg, fontWeight: text.weightSemibold },
  dialogDetail: { marginTop: space.s2, fontSize: text.sizeSm, lineHeight: text.lineBase, color: colors.inkMuted },
  dialogActions: { display: "flex", flexDirection: "column", gap: space.s2, marginTop: space.s6 },
  cacheButton: {
    height: "2.5rem",
    borderColor: colors.hairlineStrong,
    backgroundColor: "transparent",
    paddingInline: space.s2,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.inkSecondary,
    ":hover": { backgroundColor: colors.fillSubtle, color: colors.ink },
  },
  icon: { width: "1rem", height: "1rem" },
  primaryButton: { backgroundColor: colors.accent, color: "#000", ":hover": { backgroundColor: colors.accent } },
  secondaryButton: {
    borderColor: colors.hairlineStrong,
    backgroundColor: "transparent",
    color: colors.ink,
    ":hover": { backgroundColor: colors.fillSubtle },
  },
  cancelButton: { color: colors.inkMuted, ":hover": { backgroundColor: "transparent", color: colors.ink } },
});
