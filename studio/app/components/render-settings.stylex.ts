import * as stylex from "@stylexjs/stylex";
import { colors, space, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

export const styles = stylex.create({
  /** Fills the switcher's content column; the confirmation overlays cover it. */
  root: { position: "relative", minWidth: 0, minHeight: 0, overflow: "hidden", color: colors.ink },
  footer: { display: "grid", gap: space.s2, minWidth: 0 },
  footerRow: { display: "flex", flexDirection: "column", alignItems: "stretch", gap: space.s1 },
  current: { fontSize: text.sizeXs, color: colors.textSubtle },
  overlay: {
    position: "absolute",
    inset: 0,
    zIndex: 30,
    display: "grid",
    placeItems: "center",
    backgroundColor: "rgba(0,0,0,.55)",
    padding: "1.25rem",
    backdropFilter: "blur(24px)",
  },
  dialog: {
    width: "100%",
    maxWidth: "28rem",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "rgba(255,255,255,.1)",
    backgroundColor: "rgba(16,16,16,.95)",
    padding: "1.5rem",
    boxShadow: "0 25px 50px -12px rgba(0,0,0,.25)",
  },
  dialogTitle: { fontSize: "1.25rem", lineHeight: "1.75rem", fontWeight: 600 },
  dialogDetail: { marginTop: ".5rem", fontSize: text.sizeSm, lineHeight: "1.5rem", color: "rgba(255,255,255,.5)" },
  dialogActions: { display: "flex", flexDirection: "column", gap: ".5rem", marginTop: "1.5rem" },
  cacheButton: {
    height: "2.5rem",
    borderColor: "rgba(255,255,255,.15)",
    backgroundColor: "transparent",
    paddingInline: space.s2,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: "rgba(255,255,255,.65)",
    ":hover": { backgroundColor: "rgba(255,255,255,.05)", color: "#fff" },
  },
  icon: { width: "1rem", height: "1rem" },
  primaryButton: { backgroundColor: "#E8E044", color: "#000", ":hover": { backgroundColor: "#f1ea55" } },
  secondaryButton: {
    borderColor: "rgba(255,255,255,.15)",
    backgroundColor: "transparent",
    color: "#fff",
    ":hover": { backgroundColor: "rgba(255,255,255,.05)" },
  },
  cancelButton: { color: "rgba(255,255,255,.5)", ":hover": { backgroundColor: "transparent", color: "#fff" } },
});
