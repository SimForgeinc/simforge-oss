import * as stylex from "@stylexjs/stylex";
import { colors, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

const SM = "@media (min-width: 640px)";
const LG = "@media (min-width: 1024px)";
const XL = "@media (min-width: 1280px)";
const XXL = "@media (min-width: 1536px)";
const MAP_ZOOM = "--asset-map-zoom";
const ACCENT = "#E8E044";
const SURFACE = "rgba(255,255,255,0.025)";
const EASE = "cubic-bezier(0.4, 0, 0.2, 1)";

export const gallery = stylex.create({
  root: { minHeight: "100%", backgroundColor: colors.bg, color: colors.text },
  toolbar: { position: "sticky", top: 0, zIndex: 20, borderBottomWidth: "1px", borderBottomStyle: "solid", borderBottomColor: colors.border, backgroundColor: "hsl(var(--background) / 0.85)", paddingInline: "1.25rem", backdropFilter: "blur(8px)", [SM]: { paddingInline: "2rem" } },
  main: { paddingInline: "1.25rem", paddingBlock: "1.5rem", [SM]: { paddingInline: "2rem" } },
  measure: { width: "100%", maxWidth: "1500px", marginInline: "auto" },
  alert: { marginBottom: "1rem", borderWidth: "1px", borderStyle: "solid", borderColor: "rgba(248,113,113,0.2)", borderRadius: "0.5rem", backgroundColor: "rgba(248,113,113,0.05)", paddingInline: "1rem", paddingBlock: "0.75rem", fontSize: text.sizeSm, lineHeight: "1.25rem", color: "#fecaca" },
  actions: { display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "center", gap: "0.5rem" },
  icon: { width: "1.75rem", height: "1.75rem" },
  emptyState: { borderWidth: 1, borderStyle: "dashed", borderColor: colors.border },
  loadMore: { marginTop: "2rem", display: "flex", justifyContent: "center" },
  spinner: { animationName: stylex.keyframes({ from: { transform: "rotate(0deg)" }, to: { transform: "rotate(360deg)" } }), animationDuration: "1s", animationTimingFunction: "linear", animationIterationCount: "infinite" },
});

export const maps = stylex.create({
  grid: { display: "grid", gridTemplateColumns: "repeat(1, minmax(0, 1fr))", gap: "1rem", [SM]: { gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }, [LG]: { gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }, [XL]: { gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }, [XXL]: { gridTemplateColumns: "repeat(5, minmax(0, 1fr))" } },
  error: { borderWidth: "1px", borderStyle: "solid", borderColor: "rgba(248,113,113,0.2)", borderRadius: "0.5rem", backgroundColor: "rgba(248,113,113,0.05)", paddingInline: "1rem", paddingBlock: "0.75rem", fontSize: text.sizeSm, lineHeight: "1.25rem", color: "#fecaca" },
  empty: { display: "grid", minHeight: "20rem", placeItems: "center", borderWidth: "1px", borderStyle: "dashed", borderColor: "rgba(255,255,255,0.1)", borderRadius: "0.75rem", paddingInline: "1.5rem", textAlign: "center" },
  // The loading box is the same frame without `px-6`.
  emptyFlush: { display: "grid", minHeight: "20rem", placeItems: "center", borderWidth: "1px", borderStyle: "dashed", borderColor: "rgba(255,255,255,0.1)", borderRadius: "0.75rem", textAlign: "center" },
  loadingText: { fontSize: text.sizeSm, lineHeight: "1.25rem", color: "rgba(255,255,255,0.35)" },
  emptyInner: { maxWidth: "28rem" },
  emptyIcon: { marginInline: "auto", width: "2rem", height: "2rem", color: "rgba(255,255,255,0.2)" },
  emptyText: { marginTop: "0.75rem", fontSize: text.sizeSm, lineHeight: "1.25rem", color: "rgba(255,255,255,0.55)" },
  emptyHint: { marginTop: "0.25rem", fontSize: text.sizeXs, lineHeight: "1rem", color: "rgba(255,255,255,0.35)" },
  upload: { marginTop: "1.25rem", backgroundColor: ACCENT, color: "#000", ":hover": { backgroundColor: "#f3ec62" } },
  card: { [MAP_ZOOM]: { default: "none", ":hover": "scale(1.025)" }, overflow: "hidden", borderWidth: "1px", borderStyle: "solid", borderColor: "rgba(255,255,255,0.08)", borderRadius: "0.75rem", backgroundColor: SURFACE, transitionProperty: "border-color, background-color", transitionDuration: "150ms", transitionTimingFunction: EASE, ":hover": { borderColor: "rgba(255,255,255,0.2)", backgroundColor: "rgba(255,255,255,0.045)" } },
  well: { position: "relative", aspectRatio: "4 / 3", overflow: "hidden", backgroundImage: "radial-gradient(circle at 50% 42%, #29313a, #101317 68%)" },
  thumbnail: { objectFit: "cover", transform: `var(${MAP_ZOOM})`, transitionProperty: "transform", transitionDuration: "300ms", transitionTimingFunction: EASE },
  placeholder: { display: "grid", height: "100%", placeItems: "center" },
  placeholderIcon: { width: "1.75rem", height: "1.75rem", color: "rgba(255,255,255,0.15)" },
  body: { padding: "1rem" },
  name: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: text.sizeSm, lineHeight: "1.25rem", fontWeight: 600 },
  locality: { marginTop: "0.5rem", display: "flex", alignItems: "center", gap: "0.375rem", overflow: "hidden", fontSize: text.sizeXs, lineHeight: "1rem", color: "rgba(255,255,255,0.35)" },
  pin: { flexShrink: 0, width: "0.75rem", height: "0.75rem" },
  localityText: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  id: { marginTop: "0.75rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontSize: "10px", color: "rgba(255,255,255,0.3)" },
  // On `Button variant="outline"`: `bg-transparent` pinned the rest state only,
  // the variant's :hover still repainted the background, so it is restated.
  author: { marginTop: "0.75rem", width: "100%", borderColor: "rgba(255,255,255,0.1)", backgroundColor: { default: "transparent", ":hover": "hsl(var(--accent))" } },
});

export const preview = stylex.create({
  root: { position: "relative", height: "18rem", overflow: "hidden", borderWidth: "1px", borderStyle: "solid", borderColor: "rgba(255,255,255,0.1)", borderRadius: "0.75rem", backgroundColor: "#101317" },
  host: { position: "absolute", inset: 0 },
  loading: { pointerEvents: "none", position: "absolute", inset: 0, display: "grid", placeItems: "center", fontSize: text.sizeXs, lineHeight: "1rem", color: "rgba(255,255,255,0.35)" },
  error: { position: "absolute", inset: 0, display: "grid", placeItems: "center", paddingInline: "2rem", textAlign: "center", fontSize: text.sizeSm, lineHeight: "1.25rem", color: "#fca5a5" },
});

export const picker = stylex.create({
  root: { display: "flex", flexDirection: "column", gap: "0.75rem" },
  input: { position: "absolute", width: "1px", height: "1px", padding: 0, margin: "-1px", overflow: "hidden", clip: "rect(0, 0, 0, 0)", whiteSpace: "nowrap", borderWidth: 0 },
  // `focus-visible:outline-none` is Tailwind's transparent 2px outline, not `outline: none`,
  // so forced-colours mode still has an outline to repaint.
  drop: { display: "flex", minHeight: "7rem", width: "100%", flexDirection: "column", alignItems: "center", justifyContent: "center", borderWidth: "1px", borderStyle: "dashed", borderColor: "rgba(255,255,255,0.15)", borderRadius: "0.75rem", backgroundColor: SURFACE, paddingInline: "1.5rem", textAlign: "center", transitionProperty: "border-color, background-color", transitionDuration: "150ms", transitionTimingFunction: EASE, ":hover": { borderColor: "rgba(232,224,68,0.4)", backgroundColor: "rgba(232,224,68,0.03)" }, ":focus-visible": { outlineWidth: "2px", outlineStyle: "solid", outlineColor: "transparent", outlineOffset: "2px", boxShadow: `0 0 0 2px ${ACCENT}` }, ":disabled": { cursor: "not-allowed", opacity: 0.45 } },
  addIcon: { marginBottom: "0.5rem", width: "1.5rem", height: "1.5rem", color: ACCENT },
  label: { fontSize: text.sizeSm, lineHeight: "1.25rem", fontWeight: 500 },
  hint: { marginTop: "0.25rem", fontSize: text.sizeXs, lineHeight: "1rem", color: "rgba(255,255,255,0.35)" },
  images: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "0.75rem", [SM]: { gridTemplateColumns: "repeat(4, minmax(0, 1fr))" } },
  image: { position: "relative", overflow: "hidden", borderWidth: "1px", borderStyle: "solid", borderColor: "rgba(255,255,255,0.1)", borderRadius: "0.75rem", backgroundColor: "rgba(255,255,255,0.03)" },
  imagePreview: { aspectRatio: "1", width: "100%", objectFit: "cover" },
  front: { position: "absolute", left: "0.5rem", top: "0.5rem", borderRadius: "9999px", backgroundColor: ACCENT, paddingInline: "0.5rem", paddingBlock: "0.125rem", fontSize: "10px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.025em", color: "#000" },
  remove: { position: "absolute", right: "0.375rem", top: "0.375rem", borderRadius: "9999px", backgroundColor: "rgba(0,0,0,0.7)", padding: "0.25rem", color: "rgba(255,255,255,0.7)", ":hover": { color: "#fff" } },
  tinyIcon: { width: "0.875rem", height: "0.875rem" },
  controls: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.25rem", paddingInline: "0.375rem", paddingBlock: "0.375rem" },
  move: { borderRadius: "0.25rem", padding: "0.25rem", color: "rgba(255,255,255,0.55)", ":hover": { backgroundColor: "rgba(255,255,255,0.1)", color: "#fff" }, ":disabled": { opacity: 0.2 } },
  view: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "10px", color: "rgba(255,255,255,0.45)" },
  note: { fontSize: text.sizeXs, lineHeight: "1.25rem", color: "rgba(255,255,255,0.4)" },
});
export const assetPage = stylex.create({
  root: { minHeight: "100%", backgroundColor: colors.bg },
  chrome: { borderBottomWidth: "1px", borderBottomStyle: "solid", borderBottomColor: colors.border, backgroundColor: colors.bg, paddingInline: "1.25rem", [SM]: { paddingInline: "2rem" } },
  measure: { width: "100%", maxWidth: "1500px", marginInline: "auto" },
  skeletonLabel: { width: "6rem", height: "0.75rem" },
  skeletonTitle: { marginTop: "0.625rem", width: "14rem", height: "2rem" },
  skeletonDescription: { marginTop: "0.75rem", width: "100%", maxWidth: "36rem", height: "1rem" },
  skeletonButton: { marginTop: "1.25rem", width: "10rem", height: "2.25rem", borderRadius: "0.375rem" },
  content: { paddingInline: "1.25rem", paddingBlock: "1.5rem", [SM]: { paddingInline: "2rem" } },
});
