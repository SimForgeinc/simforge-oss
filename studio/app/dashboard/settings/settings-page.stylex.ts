import * as stylex from "@stylexjs/stylex";
import { text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";
const SM = "@media (min-width: 640px)";
export const styles = stylex.create({
  root: { position: "relative", height: "100%", minHeight: 0, overflow: "hidden", color: "#fff" },
  scroll: { position: "relative", zIndex: 10, height: "100%", minHeight: 0, overflowY: "auto" },
  inner: { display: "flex", width: "100%", maxWidth: "48rem", marginInline: "auto", flexDirection: "column", gap: "2.5rem", paddingInline: "1.25rem", paddingBlock: "2.5rem", [SM]: { paddingInline: "2rem", paddingBlock: "3.5rem" } },
  // border-t border-white/10 pt-8
  section: { borderTopWidth: "1px", borderTopStyle: "solid", borderTopColor: "rgba(255,255,255,.1)", paddingTop: "2rem" },
  eyebrow: { fontFamily: "var(--font-meta)", fontSize: "9px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.16em", color: "rgba(255,255,255,.4)" },
  heading: { marginTop: "0.25rem", fontSize: text.sizeLg, lineHeight: "1.75rem", fontWeight: 600 },
  copy: { marginTop: "0.5rem", fontSize: text.sizeSm, lineHeight: "1.5rem", color: "rgba(255,255,255,.55)" },
  action: { marginTop: "1rem", height: "2.5rem", gap: "0.5rem", borderRadius: "9999px", borderColor: "rgba(255,255,255,.15)", backgroundColor: "transparent", color: "#fff", ":hover": { backgroundColor: "rgba(255,255,255,.05)" } },
  icon: { width: "1rem", height: "1rem" },
  // border-t border-white/10 pt-8
  cloudCard: { borderTopWidth: "1px", borderTopStyle: "solid", borderTopColor: "rgba(255,255,255,.1)", paddingTop: "2rem" },
  /**
   * mt-4 border-t-0
   *
   * Cancels the top rule `MapAssetCacheStorage`'s own `border-y` draws: on
   * this page the section heading above already rules that boundary. Passed
   * as `xstyle`, not `className` — two atomic rules for one property are
   * ordered by the sheet, and only StyleX's own merge makes this one win.
   */
  cache: { marginTop: "1rem", borderTopWidth: 0 },
});