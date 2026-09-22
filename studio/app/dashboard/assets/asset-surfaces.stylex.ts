import * as stylex from "@stylexjs/stylex";
import { colors, motion, space, stroke, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

const SM = "@media (min-width: 640px)";
const LG = "@media (min-width: 1024px)";
const XL = "@media (min-width: 1280px)";
const XXL = "@media (min-width: 1536px)";
const MAP_ZOOM = "--asset-map-zoom";

export const maps = stylex.create({
  grid: { display: "grid", gridTemplateColumns: "repeat(1, minmax(0, 1fr))", gap: space.s4, [SM]: { gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }, [LG]: { gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }, [XL]: { gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }, [XXL]: { gridTemplateColumns: "repeat(5, minmax(0, 1fr))" } },
  error: { borderWidth: stroke.hairline, borderStyle: "solid", borderColor: colors.critical, backgroundColor: colors.criticalWash, paddingInline: space.s4, paddingBlock: space.s3, fontSize: text.sizeSm, lineHeight: text.lineSm, color: colors.critical },
  empty: { display: "grid", minHeight: "20rem", placeItems: "center", borderWidth: stroke.hairline, borderStyle: "dashed", borderColor: colors.hairline, paddingInline: space.s6, textAlign: "center" },
  // The loading box is the same frame without `px-6`.
  emptyFlush: { display: "grid", minHeight: "20rem", placeItems: "center", borderWidth: stroke.hairline, borderStyle: "dashed", borderColor: colors.hairline, textAlign: "center" },
  loadingText: { fontSize: text.sizeSm, lineHeight: text.lineSm, color: colors.inkFaint },
  emptyInner: { maxWidth: "28rem" },
  emptyIcon: { marginInline: "auto", width: "2rem", height: "2rem", color: colors.inkGhost },
  emptyText: { marginTop: space.s3, fontSize: text.sizeSm, lineHeight: text.lineSm, color: colors.inkMuted },
  emptyHint: { marginTop: space.s1, fontSize: text.sizeXs, lineHeight: text.lineXs, color: colors.inkFaint },
  upload: { marginTop: space.s5, ":hover": { backgroundColor: "#f3ec62" } },
  card: { [MAP_ZOOM]: { default: "none", ":hover": "scale(1.025)" }, overflow: "hidden", backgroundColor: colors.fillFaint, transitionProperty: "border-color, background-color", transitionDuration: motion.durStandard, transitionTimingFunction: motion.easeStandard, ":hover": { borderColor: colors.hairlineStrong, backgroundColor: colors.fillSubtle } },
  well: { position: "relative", aspectRatio: "4 / 3", overflow: "hidden", backgroundImage: "radial-gradient(circle at 50% 42%, #29313a, #101317 68%)" },
  thumbnail: { objectFit: "cover", transform: `var(${MAP_ZOOM})`, transitionProperty: "transform", transitionDuration: motion.durSlow, transitionTimingFunction: motion.easeStandard },
  placeholder: { display: "grid", height: "100%", placeItems: "center" },
  placeholderIcon: { width: "1.75rem", height: "1.75rem", color: colors.inkGhost },
  body: { padding: space.s4 },
  name: { fontSize: text.sizeSm, lineHeight: text.lineSm, fontWeight: text.weightSemibold },
  locality: { marginTop: space.s2, display: "flex", alignItems: "center", gap: space.s1_5, overflow: "hidden", fontSize: text.sizeXs, lineHeight: text.lineXs, color: colors.inkFaint },
  pin: { flexShrink: 0, width: "0.75rem", height: "0.75rem" },
  id: { marginTop: space.s3, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontSize: text.sizeMicro, color: colors.inkFaint },
  // On `Button variant="outline"`: `bg-transparent` pinned the rest state only,
  // the variant's :hover still repainted the background, so it is restated.
  author: { marginTop: space.s3, width: "100%", },
});

export const preview = stylex.create({
  root: { position: "relative", height: "18rem", overflow: "hidden", backgroundColor: "#101317" },
  host: { position: "absolute", inset: 0 },
  loading: { pointerEvents: "none", position: "absolute", inset: 0, display: "grid", placeItems: "center", fontSize: text.sizeXs, lineHeight: text.lineXs, color: colors.inkFaint },
  error: { position: "absolute", inset: 0, display: "grid", placeItems: "center", paddingInline: space.s8, textAlign: "center", fontSize: text.sizeSm, lineHeight: text.lineSm, color: colors.critical },
});

export const picker = stylex.create({
  root: { display: "flex", flexDirection: "column", gap: space.s3 },
  // `focus-visible:outline-none` is Tailwind's transparent 2px outline, not `outline: none`,
  // so forced-colours mode still has an outline to repaint.
  drop: { display: "flex", minHeight: "7rem", width: "100%", flexDirection: "column", alignItems: "center", justifyContent: "center", borderWidth: stroke.hairline, borderStyle: "dashed", borderColor: colors.hairlineStrong, backgroundColor: colors.fillFaint, paddingInline: space.s6, textAlign: "center", transitionProperty: "border-color, background-color", transitionDuration: motion.durStandard, transitionTimingFunction: motion.easeStandard, ":hover": { borderColor: colors.accentLineSubtle, backgroundColor: colors.accentWash }, ":disabled": { cursor: "not-allowed", opacity: 0.45 } },
  addIcon: { marginBottom: space.s2, width: "1.5rem", height: "1.5rem", color: colors.accent },
  label: { fontSize: text.sizeSm, lineHeight: text.lineSm, fontWeight: text.weightMedium },
  hint: { marginTop: space.s1, fontSize: text.sizeXs, lineHeight: text.lineXs, color: colors.inkFaint },
  images: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: space.s3, [SM]: { gridTemplateColumns: "repeat(4, minmax(0, 1fr))" } },
  image: { position: "relative", overflow: "hidden", backgroundColor: colors.fillFaint },
  imagePreview: { aspectRatio: "1", width: "100%", objectFit: "cover" },
  front: { position: "absolute", left: "0.5rem", top: "0.5rem", backgroundColor: colors.accent, paddingInline: space.s2, paddingBlock: space.s0_5, color: "#000" },
  remove: { position: "absolute", right: "0.375rem", top: "0.375rem", backgroundColor: colors.scrimHeavy, padding: space.s1, color: colors.inkSecondary, ":hover": { color: colors.ink } },
  tinyIcon: { width: "0.875rem", height: "0.875rem" },
  controls: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: space.s1, paddingInline: space.s1_5, paddingBlock: space.s1_5 },
  move: { padding: space.s1, color: colors.inkMuted, ":hover": { backgroundColor: colors.fillStrong, color: colors.ink }, ":disabled": { opacity: 0.2 } },
  view: { minWidth: 0, fontSize: text.sizeMicro, color: colors.inkMuted },
  note: { fontSize: text.sizeXs, lineHeight: text.lineSm, color: colors.inkMuted },
});
