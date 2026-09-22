import * as stylex from "@stylexjs/stylex";
import { colors, layers, motion, shadows, space, stroke, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

const SM = "@media (min-width: 640px)";
const SURFACE = "rgba(255,255,255,0.025)";
const spin = stylex.keyframes({ from: { transform: "rotate(0deg)" }, to: { transform: "rotate(360deg)" } });

export const dialog = stylex.create({
  overlay: { position: "fixed", inset: 0, zIndex: layers.dialog, backgroundColor: colors.scrimHeavy, backdropFilter: motion.blurMd },
  // `outline-none` is Tailwind's transparent 2px outline, not `outline: none`,
  // so forced-colours mode still has an outline to repaint.
  content: { position: "fixed", left: "50%", top: "50%", zIndex: layers.dialogTop, width: "min(760px, calc(100vw - 2rem))", maxHeight: "92vh", transform: "translate(-50%, -50%)", overflowY: "auto", borderWidth: stroke.hairline, borderStyle: "solid", borderColor: "rgba(255,255,255,0.1)", backgroundColor: "#0d1014", padding: space.s6, color: colors.ink, boxShadow: "0 25px 50px -12px rgba(0,0,0,0.5)", outlineWidth: stroke.thick, outlineStyle: "solid", outlineColor: "transparent", outlineOffset: "2px" },
  title: { display: "flex", alignItems: "center", gap: space.s2, fontSize: text.size2xl, lineHeight: text.lineXl, fontWeight: text.weightSemibold, letterSpacing: text.trackingTight },
  description: { marginTop: space.s1, fontSize: text.sizeSm, lineHeight: text.lineSm, color: colors.inkMuted },
  close: { position: "absolute", right: "1rem", top: "1rem", padding: space.s2, color: colors.inkMuted, ":hover": { backgroundColor: "rgba(255,255,255,0.05)", color: colors.ink }, ":disabled": { opacity: 0.4 } },
  form: { marginTop: space.s6, display: "flex", flexDirection: "column", gap: space.s5 },
  grid: { display: "grid", gap: space.s4, [SM]: { gridTemplateColumns: "repeat(2, minmax(0, 1fr))" } },
  span2: { [SM]: { gridColumn: "span 2" } },
  footer: { marginTop: space.s5, display: "flex", flexDirection: "column", gap: space.s5 },
  progressText: { marginBottom: space.s1, display: "flex", justifyContent: "space-between", fontSize: text.sizeXs, lineHeight: text.lineXs, color: colors.inkMuted },
  progress: { height: "0.375rem", overflow: "hidden", backgroundColor: colors.glassRaised },
  progressBar: { height: "100%", backgroundColor: colors.accent, transitionProperty: "width", transitionDuration: motion.durStandard },
  progressPulse: { animationName: spin, animationDuration: motion.durSpin, animationTimingFunction: motion.easeLinear, animationIterationCount: "infinite" },
  // The two dropzones share every layout/hover utility but differ in their
  // focus treatment, so the focus states live in the two variant keys below:
  // the asset dialog's <div> takes `focus-visible:ring-2`, the map panel's
  // <label> takes `cursor-pointer focus-within:border-[#E8E044]`.
  drop: { display: "flex", minHeight: "8rem", width: "100%", flexDirection: "column", alignItems: "center", justifyContent: "center", borderWidth: stroke.hairline, borderStyle: "dashed", borderColor: "rgba(255,255,255,0.15)", backgroundColor: SURFACE, paddingInline: space.s6, textAlign: "center", transitionProperty: "border-color, background-color", transitionDuration: motion.durStandard, ":hover": { borderColor: "rgba(232,224,68,0.4)", backgroundColor: "rgba(232,224,68,0.03)" } },
  /** `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044]` */
  dropFocusRing: { ":focus-visible": { outlineWidth: stroke.thick, outlineStyle: "solid", outlineColor: "transparent", outlineOffset: "2px", boxShadow: `0 0 0 2px ${colors.accent}` } },
  /** `cursor-pointer focus-within:border-[#E8E044] focus-within:outline-none` */
  dropPointer: { cursor: "pointer", ":focus-within": { borderColor: colors.accent, outlineWidth: stroke.thick, outlineStyle: "solid", outlineColor: "transparent", outlineOffset: "2px" } },
  panel: { marginTop: space.s6, display: "flex", flexDirection: "column", gap: space.s5 },
  card: { borderWidth: stroke.hairline, borderStyle: "solid", borderColor: "rgba(255,255,255,0.1)", backgroundColor: SURFACE, padding: space.s4 },
  tabGroup: { marginTop: space.s5, display: "flex", width: "fit-content", borderWidth: stroke.hairline, borderStyle: "solid", borderColor: "rgba(255,255,255,0.1)", backgroundColor: SURFACE, padding: space.s1 },
  tab: { display: "flex", alignItems: "center", gap: space.s1_5, paddingInline: space.s4, paddingBlock: space.s1_5, fontSize: text.sizeXs, lineHeight: text.lineXs, color: "rgba(255,255,255,0.4)", ":hover": { color: colors.ink }, ":disabled": { opacity: 0.4 } },
  tabActive: { backgroundColor: colors.fillStrong, color: colors.ink },
  stat: { borderWidth: stroke.hairline, borderStyle: "solid", borderColor: "rgba(255,255,255,0.07)", backgroundColor: "rgba(255,255,255,0.03)", padding: space.s3 },
  // Only the four utilities the gallery toolbar layered on the primitive:
  // `mx-auto max-w-[1500px] border-b-0 bg-transparent px-0 sm:px-0`. Layout
  // (flex, wrap, centring, gap) stays the primitive's.
  toolbar: { maxWidth: "1500px", marginInline: "auto", borderBottomWidth: 0, backgroundColor: "transparent", paddingInline: 0 },
  iconSm: { width: "0.875rem", height: "0.875rem" },
  iconAccent: { marginBottom: space.s3, width: "1.5rem", height: "1.5rem", color: colors.accent },
  // The two "loading preview" boxes are unrelated: the drawer's is a bordered
  // 18rem card on the theme tokens, the generate dialog's is a bare 16/7 slot.
  drawerPreviewLoading: { display: "grid", height: "18rem", placeItems: "center", borderWidth: stroke.hairline, borderStyle: "solid", borderColor: colors.border, backgroundColor: colors.card, fontSize: text.sizeXs, lineHeight: text.lineXs, color: colors.mutedForeground },
  generatePreviewLoading: { display: "flex", aspectRatio: "16 / 7", alignItems: "center", justifyContent: "center", color: "rgba(255,255,255,0.3)" },
  previewSpinner: { marginRight: space.s2, width: "1.25rem", height: "1.25rem" },
  drawerTitle: { paddingRight: space.s8, fontSize: text.size2xl, lineHeight: text.lineXl },
  statLabel: { fontSize: "10px", textTransform: "uppercase", letterSpacing: text.trackingWider, color: colors.inkFaint },
  statValue: { marginTop: space.s1, fontSize: text.sizeSm, lineHeight: text.lineSm, fontVariantNumeric: "tabular-nums" },
  // `grid gap-5 md:grid-cols-[240px_1fr]` — the preflight summary only, at the
  // md breakpoint and with a literal first track.
  preflightGrid: { display: "grid", gap: space.s5, "@media (min-width: 768px)": { gridTemplateColumns: "240px 1fr" } },
  statText: { marginTop: space.s1, fontSize: text.sizeSm, lineHeight: text.lineSm, color: colors.inkSecondary },
  mutedTextMt2: { marginTop: space.s2, fontSize: text.sizeXs, lineHeight: text.lineXs, color: "rgba(255,255,255,0.4)" },
  helpText: { marginTop: space.s1_5, fontSize: text.sizeXs, lineHeight: text.lineSm, color: "rgba(255,255,255,0.4)" },
  faintText: { fontSize: text.sizeXs, lineHeight: text.lineXs, color: colors.inkFaint },
  alignEndRow: { display: "flex", alignItems: "flex-end" },
  uploadLabelMb: { marginBottom: space.s1, fontSize: text.sizeXs, lineHeight: text.lineXs, color: colors.inkMuted },
  padOnly: { padding: space.s4 },
  mutedTextMt1: { marginTop: space.s1, fontSize: text.sizeXs, lineHeight: text.lineXs, color: "rgba(255,255,255,0.4)" },
  hintMt2: { marginTop: space.s2, fontSize: text.sizeXs, lineHeight: text.lineXs, color: colors.inkFaint },
  noteMt1: { marginTop: space.s1, fontSize: text.sizeXs, lineHeight: text.lineXs, color: "rgba(255,255,255,0.55)" },
  noteMt2: { marginTop: space.s2, fontSize: text.sizeXs, lineHeight: text.lineXs, color: "rgba(255,255,255,0.55)" },
  dlXs: { display: "flex", flexDirection: "column", gap: space.s2, fontSize: text.sizeXs, lineHeight: text.lineXs },
  dlLabel: { color: colors.inkFaint },
  truncate: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  // Drawer copy runs on the theme tokens; the upload/generate dialogs are
  // deliberately on white alphas, so these do not share a key.
  drawerNote: { fontSize: text.sizeXs, lineHeight: text.lineSm, color: colors.mutedForeground },
  drawerClipTag: { fontSize: text.sizeXs, lineHeight: text.lineXs, color: colors.mutedForeground },
  drawerBody: { fontSize: text.sizeSm, lineHeight: text.lineBase, color: "hsl(var(--foreground) / 0.8)" },
  drawerBodyMuted: { marginTop: space.s2, fontSize: text.sizeSm, lineHeight: text.lineSm, color: colors.mutedForeground },
  uploadLocality: { marginTop: space.s1, display: "flex", alignItems: "center", gap: space.s1_5, fontSize: text.sizeXs, lineHeight: text.lineXs, color: colors.inkMuted },
  uploadWarnTitle: { fontSize: text.sizeSm, lineHeight: text.lineSm, fontWeight: text.weightSemibold, color: "#fef3c7" },
  uploadWarnNote: { marginTop: space.s1, fontSize: text.sizeXs, lineHeight: text.lineSm, color: "rgba(254,243,199,0.7)" },
  tagList: { display: "flex", flexWrap: "wrap", gap: space.s1_5 },
  tag: { borderWidth: stroke.hairline, borderStyle: "solid", borderColor: colors.border, paddingInline: space.s2_5, paddingBlock: space.s1, fontSize: text.sizeXs, lineHeight: text.lineXs, color: colors.mutedForeground },
  sectionHeading: { fontSize: text.sizeXs, lineHeight: text.lineXs, fontWeight: text.weightSemibold, textTransform: "uppercase", letterSpacing: text.trackingWider, color: colors.mutedForeground },
  clipList: { marginTop: space.s2, display: "flex", flexDirection: "column", gap: space.s1, borderWidth: stroke.hairline, borderStyle: "solid", borderColor: colors.border, padding: space.s3, fontSize: text.sizeSm, lineHeight: text.lineSm },
  // `divide-y divide-white/[0.06]` moved onto the rows; the layer list has no
  // padding or row gap of its own, unlike the drawer's clip list.
  layerList: { marginTop: space.s2, borderWidth: stroke.hairline, borderStyle: "solid", borderColor: "rgba(255,255,255,0.07)", },
  layerRow: { display: "flex", alignItems: "center", gap: space.s2, paddingInline: space.s3, paddingBlock: space.s2, fontSize: text.sizeSm, lineHeight: text.lineSm, borderTopWidth: stroke.hairline, borderTopStyle: "solid", borderTopColor: "rgba(255,255,255,0.06)", ":first-child": { borderTopWidth: 0 } },
  layerId: { flexShrink: 0 },
  layerFile: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: text.fontMono, fontSize: text.sizeXs, lineHeight: text.lineXs, color: "rgba(255,255,255,0.3)" },
  layerMeta: { marginLeft: "auto", flexShrink: 0, fontVariantNumeric: "tabular-nums", fontSize: text.sizeXs, lineHeight: text.lineXs, color: "rgba(255,255,255,0.4)" },
  listRow: { display: "flex", justifyContent: "space-between", gap: space.s3 },
  drawerMono: { wordBreak: "break-all", backgroundColor: "hsl(var(--muted) / 0.4)", paddingInline: space.s3, paddingBlock: space.s2, fontFamily: text.fontMono, fontSize: text.sizeXs, lineHeight: text.lineXs, color: colors.mutedForeground },
  uploadMono: { marginTop: space.s1, wordBreak: "break-all", backgroundColor: "rgba(0,0,0,0.3)", paddingInline: space.s3, paddingBlock: space.s2, fontFamily: text.fontMono, color: "rgba(255,255,255,0.6)" },
  fieldLabel: { fontSize: text.sizeXs, lineHeight: text.lineXs, color: colors.inkMuted },
  fieldControl: { marginTop: space.s1 },
  actionsRow: { display: "flex", justifyContent: "flex-end", gap: space.s2 },
  preview: { aspectRatio: "1", width: "100%", borderWidth: stroke.hairline, borderStyle: "solid", borderColor: "rgba(255,255,255,0.1)", backgroundImage: "radial-gradient(circle,#27303a,#101317)", objectFit: "contain" },
  stack: { display: "flex", flexDirection: "column", gap: space.s3 },
  grid2: { display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: space.s3 },
  errorText: { fontSize: text.sizeSm, lineHeight: text.lineSm, color: colors.critical },
  recent: { marginTop: space.s5, borderWidth: stroke.hairline, borderStyle: "solid", borderColor: "rgba(232,224,68,0.2)", backgroundColor: "rgba(232,224,68,0.04)", padding: space.s4 },
  recentList: { marginTop: space.s2, display: "flex", flexDirection: "column", gap: space.s2 },
  recentItem: { display: "flex", width: "100%", alignItems: "center", justifyContent: "space-between", backgroundColor: colors.fillSubtle, paddingInline: space.s3, paddingBlock: space.s2, textAlign: "left", fontSize: text.sizeSm, lineHeight: text.lineSm, ":hover": { backgroundColor: colors.glassRaised } },
  accentText: { color: colors.accent },
  subText: { marginTop: space.s1, display: "block", fontSize: "11px", lineHeight: text.lineXs, color: colors.inkFaint },
  dropHint: { marginTop: space.s1, fontSize: text.sizeXs, lineHeight: text.lineXs, color: colors.inkFaint },
  cardSuccess: { borderWidth: stroke.hairline, borderStyle: "solid", borderColor: "rgba(52,211,153,0.2)", backgroundColor: "rgba(52,211,153,0.06)", padding: space.s4 },
  cardWarning: { borderWidth: stroke.hairline, borderStyle: "solid", borderColor: "rgba(252,211,77,0.25)", backgroundColor: "rgba(252,211,77,0.05)", padding: space.s4 },
  searchIcon: { pointerEvents: "none", position: "absolute", left: "0.75rem", top: "50%", width: "1rem", height: "1rem", transform: "translateY(-50%)", color: colors.mutedForeground },
  searchSpinner: { color: colors.primary },
  clearButton: { position: "absolute", right: "0.5rem", top: "50%", display: "grid", width: "1.5rem", height: "1.5rem", placeItems: "center", transform: "translateY(-50%)", color: colors.mutedForeground, transitionProperty: "color", transitionDuration: motion.durStandard, transitionTimingFunction: motion.easeStandard, ":hover": { color: colors.text }, ":focus-visible": { outlineWidth: stroke.thick, outlineStyle: "solid", outlineColor: "transparent", outlineOffset: "2px", boxShadow: shadows.ring } },
  toolbarCount: { flexShrink: 0, fontSize: text.sizeXs, lineHeight: text.lineXs, color: colors.mutedForeground },
  cellStrong: { fontWeight: text.weightMedium },
  srOnly: { position: "absolute", width: "1px", height: "1px", padding: 0, margin: "-1px", overflow: "hidden", clip: "rect(0,0,0,0)", whiteSpace: "nowrap", borderWidth: 0 },
  titleText: { fontWeight: text.weightMedium },
  searchWrap: { position: "relative", minWidth: 0, flex: 1, [SM]: { maxWidth: "24rem" } },
  // [&::-webkit-search-cancel-button]:hidden — WebKit draws its own clear
  // affordance inside `type="search"`; the toolbar supplies one of its own.
  searchInput: { height: "2.25rem", paddingLeft: "2.25rem", paddingRight: "2.25rem", "::-webkit-search-cancel-button": { display: "none" } },
  generateCard: { borderWidth: stroke.hairline, borderStyle: "solid", borderColor: "rgba(232,224,68,0.2)", backgroundColor: "rgba(232,224,68,0.03)", padding: space.s4 },
  generateHeading: { fontSize: "10px", fontWeight: text.weightSemibold, textTransform: "uppercase", letterSpacing: text.trackingMetaWider, color: colors.accent },
  generateText: { marginTop: space.s1_5, fontSize: text.sizeXs, lineHeight: text.lineSm, color: "rgba(255,255,255,0.5)" },
  artifactList: { marginTop: space.s3, display: "flex", flexDirection: "column", gap: space.s1_5 },
  artifactItem: { display: "flex", alignItems: "flex-start", gap: space.s2, fontSize: text.sizeXs, lineHeight: text.lineSm, color: "rgba(255,255,255,0.5)" },
  artifactDot: { marginTop: space.s2, width: "0.25rem", height: "0.25rem", flexShrink: 0, backgroundColor: "rgba(232,224,68,0.6)" },
  toolbarGroup: { marginLeft: "auto" },
  toolbarCountValue: { fontVariantNumeric: "tabular-nums", color: colors.text },
  iconButton: { width: "0.875rem", height: "0.875rem" },
  toolbarSelect: { height: "2.25rem", fontSize: text.sizeXs, lineHeight: text.lineXs },
  // `sm:w-48` / `sm:w-40` over the trigger's own `w-full`: `width` is one
  // merge key, so the default has to be restated alongside the 640px step.
  toolbarActor: { width: { default: "100%", [SM]: "12rem" } },
  toolbarCarla: { width: { default: "100%", [SM]: "10rem" } },
  toolbarSort: { height: "2.25rem", display: "inline-flex", alignItems: "center", gap: space.s1_5, fontSize: text.sizeXs, lineHeight: text.lineXs },
  detailSheet: { width: "100%", overflowY: "auto", borderColor: colors.border, backgroundColor: colors.bg, [SM]: { maxWidth: "36rem" } },
  renameForm: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: space.s2 },
  inputCompact: { height: "2.25rem", minWidth: 0, flex: 1 },
  buttonCompact: { height: "2.25rem" },
  deleteBox: { borderWidth: stroke.hairline, borderStyle: "solid", borderColor: "hsl(var(--destructive) / 0.5)", backgroundColor: "hsl(var(--destructive) / 0.1)", padding: space.s3 },
  deleteHeading: { fontSize: text.sizeSm, lineHeight: text.lineSm, fontWeight: text.weightSemibold },
  usageLoading: { marginTop: space.s2, display: "inline-flex", alignItems: "center", gap: space.s1_5, fontSize: text.sizeXs, lineHeight: text.lineXs, color: colors.mutedForeground },
  usageIcon: { width: "0.75rem", height: "0.75rem" },
  usageWarning: { marginTop: space.s2, display: "inline-flex", alignItems: "center", gap: space.s2, borderWidth: stroke.hairline, borderStyle: "solid", borderColor: "hsl(var(--primary) / 0.4)", backgroundColor: "hsl(var(--primary) / 0.1)", paddingInline: space.s2_5, paddingBlock: space.s1_5, fontSize: text.sizeSm, lineHeight: text.lineSm, fontWeight: text.weightSemibold, color: colors.primary },
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
  uploadBar: { height: "0.375rem", overflow: "hidden", backgroundColor: colors.glassRaised },
  uploadBarFill: { height: "100%", backgroundColor: colors.accent, transitionProperty: "width", transitionDuration: motion.durStandard },
  uploadText: { fontSize: text.sizeSm, lineHeight: text.lineSm, color: colors.critical },
  uploadActions: { display: "flex", justifyContent: "flex-end", gap: space.s2 },
  uploadDropLabel: { fontSize: text.sizeSm, lineHeight: text.lineSm, fontWeight: text.weightMedium },
  uploadImage: { aspectRatio: "1", width: "100%", borderWidth: stroke.hairline, borderStyle: "solid", borderColor: "rgba(255,255,255,0.1)", backgroundImage: "radial-gradient(circle,#27303a,#101317)", objectFit: "contain" },
  uploadMeta: { marginTop: space.s2, fontSize: text.sizeXs, lineHeight: text.lineXs, color: "rgba(255,255,255,0.4)" },
  uploadLabel: { fontSize: text.sizeXs, lineHeight: text.lineXs, color: colors.inkMuted },
  uploadField: { marginTop: space.s1 },
  motionOption: { borderWidth: stroke.hairline, borderStyle: "solid", borderColor: "rgba(255,255,255,0.12)", backgroundColor: "rgba(255,255,255,0.03)", padding: space.s3, textAlign: "left", ":hover": { backgroundColor: colors.fill } },
  motionOptionActive: { borderColor: colors.accentLine, backgroundColor: colors.accentWash },
  motionTitle: { display: "block", fontSize: text.sizeSm, lineHeight: text.lineSm, color: colors.ink },
  motionDescription: { marginTop: space.s0_5, display: "block", fontSize: text.sizeXs, lineHeight: text.lineSm, color: "rgba(255,255,255,0.55)" },
  warningText: { fontSize: text.sizeXs, lineHeight: text.lineXs, color: "rgba(253,230,138,0.7)" },
  clipsTitle: { fontSize: text.sizeXs, lineHeight: text.lineXs, color: colors.inkMuted },
  clipsText: { marginTop: space.s1, fontSize: text.sizeSm, lineHeight: text.lineSm, color: colors.inkSecondary },
  successText: { fontSize: text.sizeSm, lineHeight: text.lineSm, fontWeight: text.weightMedium, color: "#d1fae5" },
  // These three sit on `Button variant="outline"`, whose own :hover repaints
  // background (and, for `autoSize`, colour). `bg-transparent` / `text-…` only
  // ever pinned the rest state in Tailwind — the variant's pseudo-class rule
  // still won on hover — so the hover values are restated here: a caller style
  // replaces the whole property group, conditions included.
  uploadFullButton: { width: "100%", borderColor: "rgba(255,255,255,0.1)", backgroundColor: { default: "transparent", ":hover": colors.hoverWash } },
  uploadTransparent: { borderColor: "rgba(255,255,255,0.1)", backgroundColor: { default: "transparent", ":hover": colors.hoverWash } },
  autoSize: { borderColor: "rgba(232,224,68,0.4)", backgroundColor: { default: "transparent", ":hover": colors.accentWash }, color: { default: colors.accent, ":hover": colors.hoverWashText } },
  uploadMotionGrid: { display: "grid", gap: space.s2, [SM]: { gridTemplateColumns: "repeat(2, minmax(0, 1fr))" } },
});

export const drawer = stylex.create({
  root: { display: "flex", flexDirection: "column", gap: space.s6 },
  stats: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: space.s3, fontSize: text.sizeSm, lineHeight: text.lineSm },
  tile: { borderWidth: stroke.hairline, borderStyle: "solid", borderColor: colors.border, backgroundColor: "hsl(var(--muted) / 0.3)", padding: space.s3 },
  eyebrow: { fontSize: "10px", textTransform: "uppercase", letterSpacing: text.trackingWider, color: colors.mutedForeground },
  value: { marginTop: space.s1, fontVariantNumeric: "tabular-nums" },
  valueCapitalize: { marginTop: space.s1, textTransform: "capitalize" },
  valueUppercase: { marginTop: space.s1, textTransform: "uppercase" },
  actions: { display: "flex", flexWrap: "wrap", gap: space.s2 },
  section: { display: "flex", flexDirection: "column", gap: space.s3 },
});