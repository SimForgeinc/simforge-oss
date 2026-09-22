import * as stylex from "@stylexjs/stylex";
import { colors, space, stroke, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

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
  section: { display: "grid", gridTemplateRows: "auto minmax(0, 1fr) auto", gap: space.s4, minHeight: 0, minWidth: 0, overflow: "hidden" },
  tools: { display: "flex", flexDirection: "column", gap: space.s2, [SM]: { flexDirection: "row" } },
  searchWrap: { position: "relative", minWidth: 0, flex: 1 },
  searchIcon: { pointerEvents: "none", position: "absolute", left: "0.75rem", top: "50%", width: "1rem", height: "1rem", transform: "translateY(-50%)", color: "rgba(255,255,255,0.3)" },
  searchInput: { borderColor: "rgba(255,255,255,0.1)", backgroundColor: "rgba(255,255,255,0.035)", paddingLeft: "2.25rem" },
  // `width` is one merge key, so the sm step has to restate the trigger's own
  // `100%`: baseline was `w-full` with `sm:w-56` layered on top of it.
  select: { width: { default: "100%", [SM]: "14rem" } },
  tableWrap: { minHeight: 0, overflow: "auto", overscrollBehavior: "contain", borderWidth: stroke.hairline, borderStyle: "solid", borderColor: colors.hairline, backgroundColor: colors.fillFaint },
  table: { minWidth: "1050px", fontSize: text.sizeXs, lineHeight: text.lineXs },
  header: { backgroundColor: "rgba(255,255,255,0.035)" },
  // A conditional `backgroundColor` replaces the primitive's whole
  // `backgroundColor` — its `[data-state=selected]` value included. That is
  // correct here: this catalog has no row selection, so the only background
  // the primitive ever painted on these rows is the hover one being restated.
  headerRow: { borderBottomColor: colors.hairline, backgroundColor: { default: null, ":hover": "transparent" } },
  head: { height: "2.5rem", color: "rgba(255,255,255,0.4)" },
  row: { borderBottomColor: "rgba(255,255,255,0.06)", backgroundColor: { default: null, ":hover": "rgba(255,255,255,0.025)" } },
  cell: { paddingBlock: space.s2_5 },
  cellMuted: { color: "rgba(255,255,255,0.55)" },
  cellCapitalize: { textTransform: "capitalize" },
  cellNumeric: { fontVariantNumeric: "tabular-nums" },
  blueprintCell: { maxWidth: "24rem" },
  label: { fontWeight: text.weightMedium, color: "rgba(255,255,255,0.85)" },
  catalogId: { marginTop: space.s0_5, fontFamily: text.fontMono, fontSize: "10px", color: colors.inkFaint },
  blueprintId: { fontFamily: text.fontMono, fontSize: "11px", color: "rgba(255,255,255,0.65)" },
  reason: { color: colors.inkMuted },
  empty: { borderTopWidth: stroke.hairline, borderTopStyle: "solid", borderTopColor: "rgba(255,255,255,0.06)", paddingInline: space.s4, paddingBlock: space.s12, textAlign: "center", fontSize: text.sizeSm, lineHeight: text.lineSm, color: "rgba(255,255,255,0.4)" },
  count: { fontSize: text.sizeXs, lineHeight: text.lineXs, fontVariantNumeric: "tabular-nums", color: colors.inkFaint },
});
