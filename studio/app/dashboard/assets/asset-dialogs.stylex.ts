import * as stylex from "@stylexjs/stylex";
import { colors, motion, space, stroke, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

const SM = "@media (min-width: 640px)";

export const dialog = stylex.create({
  form: { marginTop: space.s6, display: "flex", flexDirection: "column", gap: space.s5 },
  grid: { display: "grid", gap: space.s4, [SM]: { gridTemplateColumns: "repeat(2, minmax(0, 1fr))" } },
  span2: { [SM]: { gridColumn: "span 2" } },
  // The two dropzones share every layout/hover utility but differ in their
  // focus treatment, so the focus states live in the two variant keys below:
  // the asset dialog's <div> takes `focus-visible:ring-2`, the map panel's
  // <label> takes `cursor-pointer focus-within:border-[#E8E044]`.
  drop: { display: "flex", minHeight: "8rem", width: "100%", flexDirection: "column", alignItems: "center", justifyContent: "center", borderWidth: stroke.hairline, borderStyle: "dashed", borderColor: colors.hairlineStrong, backgroundColor: colors.fillFaint, paddingInline: space.s6, textAlign: "center", transitionProperty: "border-color, background-color", transitionDuration: motion.durStandard, ":hover": { borderColor: colors.accentLineSubtle, backgroundColor: colors.accentWash } },
  /** `cursor-pointer focus-within:border-[#E8E044] focus-within:outline-none` */
  dropPointer: { cursor: "pointer", ":focus-within": { borderColor: colors.accent, outlineWidth: stroke.thick, outlineStyle: "solid", outlineColor: "transparent", outlineOffset: "2px" } },
  panel: { marginTop: space.s6, display: "flex", flexDirection: "column", gap: space.s5 },
  tabGroup: { marginTop: space.s5, display: "flex", width: "fit-content", backgroundColor: colors.fillFaint, padding: space.s1 },
  tab: { display: "flex", alignItems: "center", gap: space.s1_5, paddingInline: space.s4, paddingBlock: space.s1_5, fontSize: text.sizeXs, lineHeight: text.lineXs, color: colors.inkMuted, ":hover": { color: colors.ink }, ":disabled": { opacity: 0.4 } },
  tabActive: { backgroundColor: colors.fillStrong, color: colors.ink },
  stat: { backgroundColor: colors.fillFaint, padding: space.s3 },
  // Only the four utilities the gallery toolbar layered on the primitive:
  // `mx-auto max-w-[1500px] border-b-0 bg-transparent px-0 sm:px-0`. Layout
  // (flex, wrap, centring, gap) stays the primitive's.
  toolbar: { maxWidth: "1500px", marginInline: "auto", borderBottomWidth: 0, backgroundColor: "transparent", paddingInline: 0 },
  iconSm: { width: "0.875rem", height: "0.875rem" },
  iconAccent: { marginBottom: space.s3, width: "1.5rem", height: "1.5rem", color: colors.accent },
  // The drawer's loading preview: a bordered 18rem card on the theme tokens.
  drawerPreviewLoading: { display: "grid", height: "18rem", placeItems: "center", backgroundColor: colors.card, fontSize: text.sizeXs, lineHeight: text.lineXs, color: colors.mutedForeground },
  drawerTitle: { paddingRight: space.s8, fontSize: text.size2xl, lineHeight: text.lineXl },
  statLabel: { color: colors.inkFaint },
  statValue: { marginTop: space.s1, fontSize: text.sizeSm, lineHeight: text.lineSm, fontVariantNumeric: "tabular-nums" },
  // `grid gap-5 md:grid-cols-[240px_1fr]` — the preflight summary only, at the
  // md breakpoint and with a literal first track.
  preflightGrid: { display: "grid", gap: space.s5, "@media (min-width: 768px)": { gridTemplateColumns: "240px 1fr" } },
  statText: { marginTop: space.s1, fontSize: text.sizeSm, lineHeight: text.lineSm, color: colors.inkSecondary },
  mutedTextMt2: { marginTop: space.s2, fontSize: text.sizeXs, lineHeight: text.lineXs, color: colors.inkMuted },
  helpText: { marginTop: space.s1_5, fontSize: text.sizeXs, lineHeight: text.lineSm, color: colors.inkMuted },
  faintText: { fontSize: text.sizeXs, lineHeight: text.lineXs, color: colors.inkFaint },
  alignEndRow: { display: "flex", alignItems: "flex-end" },
  uploadLabelMb: { marginBottom: space.s1, fontSize: text.sizeXs, lineHeight: text.lineXs, color: colors.inkMuted },
  dlXs: { display: "flex", flexDirection: "column", gap: space.s2, fontSize: text.sizeXs, lineHeight: text.lineXs },
  dlLabel: { color: colors.inkFaint },
  // Drawer copy runs on the theme tokens; the upload dialog is deliberately on
  // white alphas, so these do not share a key.
  drawerNote: { fontSize: text.sizeXs, lineHeight: text.lineSm, color: colors.mutedForeground },
  drawerClipTag: { fontSize: text.sizeXs, lineHeight: text.lineXs, color: colors.mutedForeground },
  drawerBody: { fontSize: text.sizeSm, lineHeight: text.lineBase, color: colors.inkSecondary },
  drawerBodyMuted: { marginTop: space.s2, fontSize: text.sizeSm, lineHeight: text.lineSm, color: colors.mutedForeground },
  uploadLocality: { marginTop: space.s1, display: "flex", alignItems: "center", gap: space.s1_5, fontSize: text.sizeXs, lineHeight: text.lineXs, color: colors.inkMuted },
  uploadWarnTitle: { fontSize: text.sizeSm, lineHeight: text.lineSm, fontWeight: text.weightSemibold, color: colors.warning },
  uploadWarnNote: { marginTop: space.s1, fontSize: text.sizeXs, lineHeight: text.lineSm, color: colors.warning },
  tagList: { display: "flex", flexWrap: "wrap", gap: space.s1_5 },
  tag: { paddingInline: space.s2_5, paddingBlock: space.s1, fontSize: text.sizeXs, lineHeight: text.lineXs, color: colors.mutedForeground },
  sectionHeading: { color: colors.mutedForeground },
  clipList: { marginTop: space.s2, display: "flex", flexDirection: "column", gap: space.s1, padding: space.s3, fontSize: text.sizeSm, lineHeight: text.lineSm },
  // `divide-y divide-white/[0.06]` moved onto the rows; the layer list has no
  // padding or row gap of its own, unlike the drawer's clip list.
  layerList: { marginTop: space.s2, },
  layerRow: { display: "flex", alignItems: "center", gap: space.s2, paddingInline: space.s3, paddingBlock: space.s2, fontSize: text.sizeSm, lineHeight: text.lineSm, borderTopWidth: stroke.hairline, borderTopStyle: "solid", borderTopColor: colors.hairlineSubtle, ":first-child": { borderTopWidth: 0 } },
  layerId: { flexShrink: 0 },
  layerFile: { fontFamily: text.fontMono, fontSize: text.sizeXs, lineHeight: text.lineXs, color: colors.inkFaint },
  layerMeta: { marginLeft: "auto", flexShrink: 0, fontVariantNumeric: "tabular-nums", fontSize: text.sizeXs, lineHeight: text.lineXs, color: colors.inkMuted },
  listRow: { display: "flex", justifyContent: "space-between", gap: space.s3 },
  drawerMono: { wordBreak: "break-all", backgroundColor: colors.fillSubtle, paddingInline: space.s3, paddingBlock: space.s2, fontFamily: text.fontMono, fontSize: text.sizeXs, lineHeight: text.lineXs, color: colors.mutedForeground },
  uploadMono: { marginTop: space.s1, wordBreak: "break-all", backgroundColor: colors.scrimLight, paddingInline: space.s3, paddingBlock: space.s2, fontFamily: text.fontMono, color: colors.inkSecondary },
  fieldLabel: { fontSize: text.sizeXs, lineHeight: text.lineXs, color: colors.inkMuted },
  fieldControl: { marginTop: space.s1 },
  preview: { aspectRatio: "1", width: "100%", backgroundImage: "radial-gradient(circle,#27303a,#101317)", objectFit: "contain" },
  stack: { display: "flex", flexDirection: "column", gap: space.s3 },
  grid2: { display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: space.s3 },
  dropHint: { marginTop: space.s1, fontSize: text.sizeXs, lineHeight: text.lineXs, color: colors.inkFaint },
  cardSuccess: { borderWidth: stroke.hairline, borderStyle: "solid", borderColor: colors.positive, backgroundColor: colors.positiveWash, padding: space.s4 },
  cardWarning: { borderWidth: stroke.hairline, borderStyle: "solid", borderColor: colors.warning, backgroundColor: colors.warningWash, padding: space.s4 },
  searchIcon: { pointerEvents: "none", position: "absolute", left: "0.75rem", top: "50%", width: "1rem", height: "1rem", transform: "translateY(-50%)", color: colors.mutedForeground },
  searchSpinner: { color: colors.primary },
  clearButton: { position: "absolute", right: "0.5rem", top: "50%", display: "grid", width: "1.5rem", height: "1.5rem", placeItems: "center", transform: "translateY(-50%)", color: colors.mutedForeground, transitionProperty: "color", transitionDuration: motion.durStandard, transitionTimingFunction: motion.easeStandard, ":hover": { color: colors.text }, },
  toolbarCount: { flexShrink: 0, fontSize: text.sizeXs, lineHeight: text.lineXs, color: colors.mutedForeground },
  cellStrong: { fontWeight: text.weightMedium },
  titleText: { fontWeight: text.weightMedium },
  searchWrap: { position: "relative", minWidth: 0, flex: 1, [SM]: { maxWidth: "24rem" } },
  // [&::-webkit-search-cancel-button]:hidden — WebKit draws its own clear
  // affordance inside `type="search"`; the toolbar supplies one of its own.
  searchInput: { paddingLeft: "2.25rem", paddingRight: "2.25rem", "::-webkit-search-cancel-button": { display: "none" } },
  generateCard: { borderWidth: stroke.hairline, borderStyle: "solid", borderColor: colors.accentLineSubtle, backgroundColor: colors.accentWash, padding: space.s4 },
  generateHeading: { color: colors.accent },
  generateText: { marginTop: space.s1_5, fontSize: text.sizeXs, lineHeight: text.lineSm, color: colors.inkMuted },
  artifactList: { marginTop: space.s3, display: "flex", flexDirection: "column", gap: space.s1_5 },
  artifactItem: { display: "flex", alignItems: "flex-start", gap: space.s2, fontSize: text.sizeXs, lineHeight: text.lineSm, color: colors.inkMuted },
  artifactDot: { marginTop: space.s2, width: "0.25rem", height: "0.25rem", flexShrink: 0, backgroundColor: "rgba(232,224,68,0.6)" },
  toolbarGroup: { marginLeft: "auto" },
  toolbarCountValue: { fontVariantNumeric: "tabular-nums", color: colors.text },
  iconButton: { width: "0.875rem", height: "0.875rem" },
  toolbarSelect: { height: "2.25rem", fontSize: text.sizeXs, lineHeight: text.lineXs },
  // `sm:w-48` / `sm:w-40` over the trigger's own `w-full`: `width` is one
  // merge key, so the default has to be restated alongside the 640px step.
  toolbarActor: { width: { default: "100%", [SM]: "12rem" } },
  toolbarCarla: { width: { default: "100%", [SM]: "10rem" } },
  toolbarSort: { display: "inline-flex", alignItems: "center", gap: space.s1_5, },
  detailSheet: { width: "100%", overflowY: "auto", borderColor: colors.hairline, backgroundColor: colors.bg, [SM]: { maxWidth: "36rem" } },
  renameForm: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: space.s2 },
  inputCompact: { minWidth: 0, flex: 1 },
  deleteBox: { borderWidth: stroke.hairline, borderStyle: "solid", borderColor: colors.critical, backgroundColor: colors.criticalWash, padding: space.s3 },
  deleteHeading: { fontSize: text.sizeSm, lineHeight: text.lineSm, fontWeight: text.weightSemibold },
  usageLoading: { marginTop: space.s2, display: "inline-flex", alignItems: "center", gap: space.s1_5, fontSize: text.sizeXs, lineHeight: text.lineXs, color: colors.mutedForeground },
  usageIcon: { width: "0.75rem", height: "0.75rem" },
  usageWarning: { marginTop: space.s2, display: "inline-flex", alignItems: "center", gap: space.s2, borderWidth: stroke.hairline, borderStyle: "solid", borderColor: colors.accentLineSubtle, backgroundColor: colors.accentWash, paddingInline: space.s2_5, paddingBlock: space.s1_5, fontSize: text.sizeSm, lineHeight: text.lineSm, fontWeight: text.weightSemibold, color: colors.primary },
  usageWarningIcon: { width: "1rem", height: "1rem" },
  usageNote: { marginTop: space.s2, fontSize: text.sizeXs, lineHeight: text.lineXs, color: colors.mutedForeground },
  deleteActions: { marginTop: space.s3, display: "flex", flexWrap: "wrap", gap: space.s2 },
  errorDanger: { fontSize: text.sizeSm, lineHeight: text.lineSm, color: colors.critical },
  uploadPreviewGrid: { display: "grid", gap: space.s5, [SM]: { gridTemplateColumns: "240px 1fr" } },
  uploadControls: { display: "flex", flexDirection: "column", gap: space.s3 },
  uploadGrid2: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: space.s3 },
  uploadGrid: { display: "grid", gap: space.s4, [SM]: { gridTemplateColumns: "repeat(2, minmax(0, 1fr))" } },
  uploadSpan2: { [SM]: { gridColumn: "span 2" } },
  uploadRow: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: space.s2 },
  uploadBottom: { marginTop: space.s5, display: "flex", flexDirection: "column", gap: space.s5 },
  uploadStatus: { marginBottom: space.s1, display: "flex", justifyContent: "space-between", fontSize: text.sizeXs, lineHeight: text.lineXs, color: colors.inkMuted },
  uploadBar: { height: "0.375rem", overflow: "hidden", backgroundColor: colors.fill },
  uploadBarFill: { height: "100%", backgroundColor: colors.accent, transitionProperty: "width", transitionDuration: motion.durStandard },
  uploadText: { fontSize: text.sizeSm, lineHeight: text.lineSm, color: colors.critical },
  uploadActions: { display: "flex", justifyContent: "flex-end", gap: space.s2 },
  uploadDropLabel: { fontSize: text.sizeSm, lineHeight: text.lineSm, fontWeight: text.weightMedium },
  uploadImage: { aspectRatio: "1", width: "100%", backgroundImage: "radial-gradient(circle,#27303a,#101317)", objectFit: "contain" },
  uploadMeta: { marginTop: space.s2, fontSize: text.sizeXs, lineHeight: text.lineXs, color: colors.inkMuted },
  uploadLabel: { fontSize: text.sizeXs, lineHeight: text.lineXs, color: colors.inkMuted },
  uploadField: { marginTop: space.s1 },
  motionOption: { backgroundColor: colors.fillFaint, padding: space.s3, textAlign: "left", ":hover": { backgroundColor: colors.fill } },
  motionOptionActive: { borderColor: colors.accentLine, backgroundColor: colors.accentWash },
  motionTitle: { display: "block", fontSize: text.sizeSm, lineHeight: text.lineSm, color: colors.ink },
  motionDescription: { marginTop: space.s0_5, display: "block", fontSize: text.sizeXs, lineHeight: text.lineSm, color: colors.inkMuted },
  warningText: { fontSize: text.sizeXs, lineHeight: text.lineXs, color: colors.warning },
  clipsTitle: { fontSize: text.sizeXs, lineHeight: text.lineXs, color: colors.inkMuted },
  clipsText: { marginTop: space.s1, fontSize: text.sizeSm, lineHeight: text.lineSm, color: colors.inkSecondary },
  // These three sit on `Button variant="outline"`, whose own :hover repaints
  // background (and, for `autoSize`, colour). `bg-transparent` / `text-…` only
  // ever pinned the rest state in Tailwind — the variant's pseudo-class rule
  // still won on hover — so the hover values are restated here: a caller style
  // replaces the whole property group, conditions included.
  uploadFullButton: { width: "100%", },
  uploadMotionGrid: { display: "grid", gap: space.s2, [SM]: { gridTemplateColumns: "repeat(2, minmax(0, 1fr))" } },
});

export const drawer = stylex.create({
  root: { display: "flex", flexDirection: "column", gap: space.s6 },
  stats: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: space.s3, fontSize: text.sizeSm, lineHeight: text.lineSm },
  tile: { backgroundColor: colors.fillFaint, padding: space.s3 },
  eyebrow: { color: colors.mutedForeground },
  value: { marginTop: space.s1, fontVariantNumeric: "tabular-nums" },
  valueCapitalize: { marginTop: space.s1, textTransform: "capitalize" },
  valueUppercase: { marginTop: space.s1, textTransform: "uppercase" },
  actions: { display: "flex", flexWrap: "wrap", gap: space.s2 },
  section: { display: "flex", flexDirection: "column", gap: space.s3 },
});