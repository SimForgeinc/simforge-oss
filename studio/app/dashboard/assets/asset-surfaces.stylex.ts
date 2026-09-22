import * as stylex from "@stylexjs/stylex";
import { colors, motion, space, stroke, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

const SM = "@media (min-width: 640px)";
const LG = "@media (min-width: 1024px)";
const XL = "@media (min-width: 1280px)";
const XXL = "@media (min-width: 1536px)";
const MAP_ZOOM = "--asset-map-zoom";
const SURFACE = "rgba(255,255,255,0.025)";

export const maps = stylex.create({
  grid: { display: "grid", gridTemplateColumns: "repeat(1, minmax(0, 1fr))", gap: space.s4, [SM]: { gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }, [LG]: { gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }, [XL]: { gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }, [XXL]: { gridTemplateColumns: "repeat(5, minmax(0, 1fr))" } },
  error: { borderWidth: stroke.hairline, borderStyle: "solid", borderColor: "rgba(248,113,113,0.2)", borderRadius: "0.5rem", backgroundColor: "rgba(248,113,113,0.05)", paddingInline: space.s4, paddingBlock: space.s3, fontSize: text.sizeSm, lineHeight: text.lineSm, color: "#fecaca" },
  empty: { display: "grid", minHeight: "20rem", placeItems: "center", borderWidth: stroke.hairline, borderStyle: "dashed", borderColor: "rgba(255,255,255,0.1)", borderRadius: "0.75rem", paddingInline: space.s6, textAlign: "center" },
  // The loading box is the same frame without `px-6`.
  emptyFlush: { display: "grid", minHeight: "20rem", placeItems: "center", borderWidth: stroke.hairline, borderStyle: "dashed", borderColor: "rgba(255,255,255,0.1)", borderRadius: "0.75rem", textAlign: "center" },
  loadingText: { fontSize: text.sizeSm, lineHeight: text.lineSm, color: colors.inkFaint },
  emptyInner: { maxWidth: "28rem" },
  emptyIcon: { marginInline: "auto", width: "2rem", height: "2rem", color: "rgba(255,255,255,0.2)" },
  emptyText: { marginTop: space.s3, fontSize: text.sizeSm, lineHeight: text.lineSm, color: "rgba(255,255,255,0.55)" },
  emptyHint: { marginTop: space.s1, fontSize: text.sizeXs, lineHeight: text.lineXs, color: colors.inkFaint },
  upload: { marginTop: space.s5, backgroundColor: colors.accent, color: "#000", ":hover": { backgroundColor: "#f3ec62" } },
  card: { [MAP_ZOOM]: { default: "none", ":hover": "scale(1.025)" }, overflow: "hidden", borderWidth: stroke.hairline, borderStyle: "solid", borderColor: colors.hairline, borderRadius: "0.75rem", backgroundColor: SURFACE, transitionProperty: "border-color, background-color", transitionDuration: motion.durStandard, transitionTimingFunction: motion.easeStandard, ":hover": { borderColor: "rgba(255,255,255,0.2)", backgroundColor: "rgba(255,255,255,0.045)" } },
  well: { position: "relative", aspectRatio: "4 / 3", overflow: "hidden", backgroundImage: "radial-gradient(circle at 50% 42%, #29313a, #101317 68%)" },
  thumbnail: { objectFit: "cover", transform: `var(${MAP_ZOOM})`, transitionProperty: "transform", transitionDuration: "300ms", transitionTimingFunction: motion.easeStandard },
  placeholder: { display: "grid", height: "100%", placeItems: "center" },
  placeholderIcon: { width: "1.75rem", height: "1.75rem", color: "rgba(255,255,255,0.15)" },
  body: { padding: space.s4 },
  name: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: text.sizeSm, lineHeight: text.lineSm, fontWeight: text.weightSemibold },
  locality: { marginTop: space.s2, display: "flex", alignItems: "center", gap: space.s1_5, overflow: "hidden", fontSize: text.sizeXs, lineHeight: text.lineXs, color: colors.inkFaint },
  pin: { flexShrink: 0, width: "0.75rem", height: "0.75rem" },
  localityText: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  id: { marginTop: space.s3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontSize: "10px", color: "rgba(255,255,255,0.3)" },
  // On `Button variant="outline"`: `bg-transparent` pinned the rest state only,
  // the variant's :hover still repainted the background, so it is restated.
  author: { marginTop: space.s3, width: "100%", borderColor: "rgba(255,255,255,0.1)", backgroundColor: { default: "transparent", ":hover": colors.hoverWash } },
});

export const preview = stylex.create({
  root: { position: "relative", height: "18rem", overflow: "hidden", borderWidth: stroke.hairline, borderStyle: "solid", borderColor: "rgba(255,255,255,0.1)", borderRadius: "0.75rem", backgroundColor: "#101317" },
  host: { position: "absolute", inset: 0 },
  loading: { pointerEvents: "none", position: "absolute", inset: 0, display: "grid", placeItems: "center", fontSize: text.sizeXs, lineHeight: text.lineXs, color: colors.inkFaint },
  error: { position: "absolute", inset: 0, display: "grid", placeItems: "center", paddingInline: space.s8, textAlign: "center", fontSize: text.sizeSm, lineHeight: text.lineSm, color: colors.critical },
});

export const picker = stylex.create({
  root: { display: "flex", flexDirection: "column", gap: space.s3 },
  input: { position: "absolute", width: "1px", height: "1px", padding: 0, margin: "-1px", overflow: "hidden", clip: "rect(0, 0, 0, 0)", whiteSpace: "nowrap", borderWidth: 0 },
  // `focus-visible:outline-none` is Tailwind's transparent 2px outline, not `outline: none`,
  // so forced-colours mode still has an outline to repaint.
  drop: { display: "flex", minHeight: "7rem", width: "100%", flexDirection: "column", alignItems: "center", justifyContent: "center", borderWidth: stroke.hairline, borderStyle: "dashed", borderColor: "rgba(255,255,255,0.15)", borderRadius: "0.75rem", backgroundColor: SURFACE, paddingInline: space.s6, textAlign: "center", transitionProperty: "border-color, background-color", transitionDuration: motion.durStandard, transitionTimingFunction: motion.easeStandard, ":hover": { borderColor: "rgba(232,224,68,0.4)", backgroundColor: "rgba(232,224,68,0.03)" }, ":focus-visible": { outlineWidth: stroke.thick, outlineStyle: "solid", outlineColor: "transparent", outlineOffset: "2px", boxShadow: `0 0 0 2px ${colors.accent}` }, ":disabled": { cursor: "not-allowed", opacity: 0.45 } },
  addIcon: { marginBottom: space.s2, width: "1.5rem", height: "1.5rem", color: colors.accent },
  label: { fontSize: text.sizeSm, lineHeight: text.lineSm, fontWeight: text.weightMedium },
  hint: { marginTop: space.s1, fontSize: text.sizeXs, lineHeight: text.lineXs, color: colors.inkFaint },
  images: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: space.s3, [SM]: { gridTemplateColumns: "repeat(4, minmax(0, 1fr))" } },
  image: { position: "relative", overflow: "hidden", borderWidth: stroke.hairline, borderStyle: "solid", borderColor: "rgba(255,255,255,0.1)", borderRadius: "0.75rem", backgroundColor: "rgba(255,255,255,0.03)" },
  imagePreview: { aspectRatio: "1", width: "100%", objectFit: "cover" },
  front: { position: "absolute", left: "0.5rem", top: "0.5rem", borderRadius: "9999px", backgroundColor: colors.accent, paddingInline: space.s2, paddingBlock: space.s0_5, fontSize: "10px", fontWeight: text.weightSemibold, textTransform: "uppercase", letterSpacing: text.trackingWide, color: "#000" },
  remove: { position: "absolute", right: "0.375rem", top: "0.375rem", borderRadius: "9999px", backgroundColor: "rgba(0,0,0,0.7)", padding: space.s1, color: colors.inkSecondary, ":hover": { color: colors.ink } },
  tinyIcon: { width: "0.875rem", height: "0.875rem" },
  controls: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: space.s1, paddingInline: space.s1_5, paddingBlock: space.s1_5 },
  move: { borderRadius: "0.25rem", padding: space.s1, color: "rgba(255,255,255,0.55)", ":hover": { backgroundColor: colors.fillStrong, color: colors.ink }, ":disabled": { opacity: 0.2 } },
  view: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "10px", color: colors.inkMuted },
  note: { fontSize: text.sizeXs, lineHeight: text.lineSm, color: "rgba(255,255,255,0.4)" },
});
