import * as stylex from "@stylexjs/stylex";
import { text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";
const SM = "@media (min-width: 640px)";
export const styles = stylex.create({
  root: { position: "relative", height: "100%", minHeight: 0, overflow: "hidden", color: "#fff" },
  scroll: { position: "relative", zIndex: 10, height: "100%", minHeight: 0, overflowY: "auto" },
  inner: { display: "flex", width: "100%", maxWidth: "48rem", marginInline: "auto", flexDirection: "column", gap: "2.5rem", paddingInline: "1.25rem", paddingBlock: "2.5rem", [SM]: { paddingInline: "2rem", paddingBlock: "3.5rem" } },
  section: { borderTop: "1px solid rgba(255,255,255,.1)", paddingTop: "2rem" },
  eyebrow: { fontFamily: "var(--font-meta)", fontSize: "9px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.16em", color: "rgba(255,255,255,.4)" },
  heading: { marginTop: "0.25rem", fontSize: text.sizeLg, fontWeight: 600 },
  copy: { marginTop: "0.5rem", fontSize: text.sizeSm, lineHeight: 1.5, color: "rgba(255,255,255,.55)" },
  action: { marginTop: "1rem", height: "2.5rem", gap: "0.5rem", borderRadius: "9999px", borderColor: "rgba(255,255,255,.15)", backgroundColor: "transparent", color: "#fff", ":hover": { backgroundColor: "rgba(255,255,255,.05)" } },
  icon: { width: "1rem", height: "1rem" },
  cloudCard: { borderTop: "1px solid rgba(255,255,255,.1)", paddingTop: "2rem" },
  cache: { marginTop: "1rem", borderTop: 0 },
});