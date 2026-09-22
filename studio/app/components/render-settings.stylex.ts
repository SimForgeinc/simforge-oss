import * as stylex from "@stylexjs/stylex";
import { colors, layers, motion, shadows, space, stroke, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

export const styles = stylex.create({
  /** Fills the switcher's content column; the confirmation overlays cover it. */
  root: { position: "relative", minWidth: 0, minHeight: 0, overflow: "hidden", color: colors.ink },
  footer: { display: "grid", gap: space.s2, minWidth: 0 },
  footerRow: { display: "flex", flexDirection: "column", alignItems: "stretch", gap: space.s1 },
  current: { fontSize: text.sizeXs, color: colors.textSubtle },
  overlay: {
    position: "absolute",
    inset: 0,
    zIndex: layers.sticky,
    display: "grid",
    placeItems: "center",
    backgroundColor: "rgba(0,0,0,.55)",
    padding: space.s5,
    backdropFilter: motion.blurPane,
  },
  dialog: {
    width: "100%",
    maxWidth: "28rem",
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: "rgba(255,255,255,.1)",
    backgroundColor: "rgba(16,16,16,.95)",
    padding: space.s6,
    boxShadow: shadows.elevation2xl,
  },
  dialogTitle: { fontSize: text.sizeXl, lineHeight: text.lineLg, fontWeight: text.weightSemibold },
  dialogDetail: { marginTop: space.s2, fontSize: text.sizeSm, lineHeight: text.lineBase, color: "rgba(255,255,255,.5)" },
  dialogActions: { display: "flex", flexDirection: "column", gap: space.s2, marginTop: space.s6 },
  cacheButton: {
    height: "2.5rem",
    borderColor: "rgba(255,255,255,.15)",
    backgroundColor: "transparent",
    paddingInline: space.s2,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: "rgba(255,255,255,.65)",
    ":hover": { backgroundColor: "rgba(255,255,255,.05)", color: colors.ink },
  },
  icon: { width: "1rem", height: "1rem" },
  primaryButton: { backgroundColor: colors.accent, color: "#000", ":hover": { backgroundColor: "#f1ea55" } },
  secondaryButton: {
    borderColor: "rgba(255,255,255,.15)",
    backgroundColor: "transparent",
    color: colors.ink,
    ":hover": { backgroundColor: "rgba(255,255,255,.05)" },
  },
  cancelButton: { color: "rgba(255,255,255,.5)", ":hover": { backgroundColor: "transparent", color: colors.ink } },
});
