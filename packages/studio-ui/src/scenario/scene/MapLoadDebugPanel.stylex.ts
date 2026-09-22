import * as stylex from "@stylexjs/stylex";

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
    fontWeight: 600,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    cursor: "pointer",
    color: "rgb(255 255 255 / 55%)",
    backgroundColor: "rgb(0 0 0 / 15%)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "rgb(255 255 255 / 8%)",
    borderRadius: 999,
    ":hover": { color: "#fff", borderColor: "rgb(255 255 255 / 20%)" },
  },
  toggleOpen: { color: "#fff", borderColor: "rgb(255 255 255 / 20%)" },
  chevron: { width: 12, height: 12, transitionProperty: "transform", transitionDuration: "120ms" },
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
    borderRadius: 8,
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
    lineHeight: 1.5,
    userSelect: "text",
  },
});
