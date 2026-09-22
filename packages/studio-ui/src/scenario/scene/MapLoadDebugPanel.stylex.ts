import * as stylex from "@stylexjs/stylex";
import { colors, motion, text } from "../../stylex/tokens.stylex";

/**
 * The diagnostics live in a dropdown under the loading plate's telemetry, not
 * in a box pinned to the viewport corner: a small trigger in the flow of the
 * cover, and a card that opens beneath it over whatever follows.
 */
export const styles = stylex.create({
  panel: { position: "relative", color: "#e5e7eb", fontSize: 12 },
  toggle: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    paddingBlock: 6,
    paddingInline: 10,
    fontSize: 11,
    fontWeight: text.weightSemibold,
    letterSpacing: text.trackingMetaNarrow,
    textTransform: "uppercase",
    cursor: "pointer",
    color: colors.inkMuted,
    backgroundColor: "rgb(0 0 0 / 15%)",
    ":hover": { color: colors.ink, borderColor: colors.hairlineStrong },
  },
  toggleOpen: { color: colors.ink, borderColor: colors.hairlineStrong },
  chevron: { width: 12, height: 12, transitionProperty: "transform", transitionDuration: motion.durFast },
  chevronOpen: { transform: "rotate(180deg)" },
  content: {
    position: "absolute",
    top: "calc(100% + 8px)",
    left: 0,
    zIndex: 11,
    width: "min(720px, calc(100vw - 32px))",
    maxHeight: "50vh",
    overflow: "auto",
    padding: "12px 14px",
    backgroundColor: "rgba(15, 20, 29, 0.96)",
    border: "1px solid #46505f",
    boxShadow: "0 16px 40px rgb(0 0 0 / 45%)",
  },
  toolbar: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 },
  summary: { marginTop: 8, overflowWrap: "anywhere", lineHeight: 1.6 },
  coverage: { width: "100%", marginTop: 8, textAlign: "left", fontVariantNumeric: "tabular-nums", fontSize: 11 },
  json: {
    maxHeight: "28vh",
    overflow: "auto",
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    marginTop: 8,
    fontSize: 11,
    lineHeight: text.lineNormal,
    userSelect: "text",
  },
});
