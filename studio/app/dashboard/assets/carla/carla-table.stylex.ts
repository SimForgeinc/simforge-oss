import * as stylex from "@stylexjs/stylex";
import { text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

const SM = "@media (min-width: 640px)";

/**
 * The compatibility catalog overrides the table primitive on nearly every
 * part, so its atoms live here rather than in `asset-dialogs.stylex.ts`:
 * they are the only styles in the dashboard that shrink the primitive's
 * `text-sm`/`h-11`/`py-3.5` defaults and repaint its borders and hovers.
 * Every key is passed through the primitives' `xstyle` seam so it wins the
 * conflict against the primitive's own atoms by declaration order.
 */
export const carla = stylex.create({
  section: { display: "flex", flexDirection: "column", gap: "1rem" },
  tools: { display: "flex", flexDirection: "column", gap: "0.5rem", [SM]: { flexDirection: "row" } },
  searchWrap: { position: "relative", minWidth: 0, flex: 1 },
  searchIcon: { pointerEvents: "none", position: "absolute", left: "0.75rem", top: "50%", width: "1rem", height: "1rem", transform: "translateY(-50%)", color: "rgba(255,255,255,0.3)" },
  searchInput: { borderColor: "rgba(255,255,255,0.1)", backgroundColor: "rgba(255,255,255,0.035)", paddingLeft: "2.25rem" },
  // `width` is one merge key, so the sm step has to restate the trigger's own
  // `100%`: baseline was `w-full` with `sm:w-56` layered on top of it.
  select: { width: { default: "100%", [SM]: "14rem" } },
  tableWrap: { overflow: "hidden", borderWidth: "1px", borderStyle: "solid", borderColor: "rgba(255,255,255,0.08)", borderRadius: "0.75rem", backgroundColor: "rgba(255,255,255,0.02)" },
  table: { minWidth: "1050px", fontSize: text.sizeXs, lineHeight: "1rem" },
  header: { backgroundColor: "rgba(255,255,255,0.035)" },
  // A conditional `backgroundColor` replaces the primitive's whole
  // `backgroundColor` — its `[data-state=selected]` value included. That is
  // correct here: this catalog has no row selection, so the only background
  // the primitive ever painted on these rows is the hover one being restated.
  headerRow: { borderBottomColor: "rgba(255,255,255,0.08)", backgroundColor: { default: null, ":hover": "transparent" } },
  head: { height: "2.5rem", color: "rgba(255,255,255,0.4)" },
  row: { borderBottomColor: "rgba(255,255,255,0.06)", backgroundColor: { default: null, ":hover": "rgba(255,255,255,0.025)" } },
  cell: { paddingBlock: "0.625rem" },
  cellMuted: { color: "rgba(255,255,255,0.55)" },
  cellCapitalize: { textTransform: "capitalize" },
  cellNumeric: { fontVariantNumeric: "tabular-nums" },
  blueprintCell: { maxWidth: "24rem" },
  label: { fontWeight: text.weightMedium, color: "rgba(255,255,255,0.85)" },
  catalogId: { marginTop: "0.125rem", fontFamily: text.fontMono, fontSize: "10px", color: "rgba(255,255,255,0.35)" },
  blueprintId: { fontFamily: text.fontMono, fontSize: "11px", color: "rgba(255,255,255,0.65)" },
  reason: { color: "rgba(255,255,255,0.45)" },
  empty: { borderTopWidth: "1px", borderTopStyle: "solid", borderTopColor: "rgba(255,255,255,0.06)", paddingInline: "1rem", paddingBlock: "3rem", textAlign: "center", fontSize: text.sizeSm, lineHeight: "1.25rem", color: "rgba(255,255,255,0.4)" },
  count: { fontSize: text.sizeXs, lineHeight: "1rem", fontVariantNumeric: "tabular-nums", color: "rgba(255,255,255,0.35)" },
});
