import * as stylex from "@stylexjs/stylex";
import { colors, space, stroke, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

const SM = "@media (min-width: 640px)";

export const setup = stylex.create({
  shell: { position: "relative", display: "grid", minHeight: "100%", placeItems: "center", overflow: "hidden", paddingInline: space.s5, paddingBlock: space.s10, [SM]: { padding: space.s8 } },
  content: { position: "relative", width: "100%", maxWidth: "38rem", padding: space.s6, color: colors.ink, [SM]: { padding: "2.25rem" } },
  header: { display: "flex", alignItems: "flex-start", gap: space.s4 },
  headerIcon: { display: "grid", width: "3rem", height: "3rem", flexShrink: 0, placeItems: "center", color: colors.accent },
  eyebrow: { color: colors.accent },
  title: { marginTop: space.s1, fontSize: text.size2xl, lineHeight: text.lineXl, fontWeight: text.weightSemibold },
  description: { marginTop: space.s2, fontSize: text.sizeSm, lineHeight: text.lineBase, color: colors.inkMuted },
  // mt-6 border-y border-white/10 py-4
  selection: { marginTop: space.s6, borderBlockWidth: stroke.hairline, borderBlockStyle: "solid", borderBlockColor: colors.hairline, paddingBlock: space.s4 },
  selectionHead: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: space.s3 },
  selectionLegend: { color: colors.inkMuted },
  selectionActions: { display: "flex", gap: space.s3, fontSize: text.sizeMeta },
  // Baseline `text-[#E8E044]` / `text-white/45` on a bare <button>: colour only.
  // The rest is Tailwind preflight's button reset; no hover and no focus style,
  // so the UA focus ring stands (and survives forced colours).
  actionButton: { borderWidth: 0, padding: 0, backgroundColor: "transparent", color: colors.inkMuted, cursor: "pointer" },
  actionPrimary: { color: colors.accent },
  mapGrid: { display: "grid", maxHeight: "10rem", gap: space.s1, marginTop: space.s3, overflowY: "auto", [SM]: { gridTemplateColumns: "repeat(2, minmax(0, 1fr))" } },
  mapOption: { display: "flex", minWidth: 0, alignItems: "center", gap: space.s2, paddingInline: space.s2, paddingBlock: space.s2, fontSize: text.sizeXs, lineHeight: text.lineXs, color: colors.inkSecondary },
  checkbox: { width: "0.875rem", height: "0.875rem", accentColor: colors.accent },
  // mt-4 flex flex-wrap items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3
  notice: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: space.s3, marginTop: space.s4, backgroundColor: colors.fillFaint, paddingInline: space.s4, paddingBlock: space.s3 },
  noticeIcon: { width: space.s4, height: space.s4, flexShrink: 0, color: colors.accent },
  noticeText: { minWidth: 0, flex: 1, fontSize: text.sizeXs, lineHeight: text.lineSm, color: colors.inkMuted },
  error: { marginTop: space.s2, fontSize: text.sizeXs, lineHeight: text.lineXs, color: colors.warning },
  preparation: { marginTop: space.s8 },
  // mt-5 border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive
  errorBox: { marginTop: space.s5, borderWidth: stroke.hairline, borderStyle: "solid", borderColor: "color-mix(in srgb, hsl(var(--destructive)) 40%, transparent)", backgroundColor: "color-mix(in srgb, hsl(var(--destructive)) 10%, transparent)", padding: space.s3, fontSize: text.sizeSm, lineHeight: text.lineSm, color: colors.danger },
  footer: { display: "flex", flexDirection: "column", gap: space.s3, marginTop: space.s8, [SM]: { flexDirection: "row" } },
  // pointer-events-auto max-w-xl border-t border-white/15 pt-3
  panel: { pointerEvents: "auto", maxWidth: "36rem", borderTopWidth: stroke.hairline, borderTopStyle: "solid", borderTopColor: colors.hairlineStrong, paddingTop: space.s3 },
  panelLabel: { color: colors.inkMuted },
  // mt-2 flex flex-wrap items-center gap-3 rounded-2xl border border-white/10 bg-black/35 px-4 py-3
  locked: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: space.s3, marginTop: space.s2, backgroundColor: colors.scrimLight, paddingInline: space.s4, paddingBlock: space.s3 },
  lockedIcon: { width: space.s4, height: space.s4, flexShrink: 0, color: colors.accent },
  lockedText: { minWidth: 0, flex: 1, fontSize: text.sizeXs, lineHeight: text.lineSm, color: colors.inkSecondary },
  // divide-y divide-white/10: the container draws nothing, and each row after
  // the first carries the rule above it. `:not(:first-child)` is Tailwind's
  // `& > :not([hidden]) ~ :not([hidden])` for a list of visible siblings.
  rows: { marginTop: space.s1_5 },
  row: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: space.s3, paddingBlock: space.s2, borderTopWidth: { default: 0, ":not(:first-child)": stroke.hairline }, borderTopStyle: { default: null, ":not(:first-child)": "solid" }, borderTopColor: { default: null, ":not(:first-child)": colors.hairline } },
  rowIcon: { display: "grid", width: "1.75rem", height: "1.75rem", flexShrink: 0, placeItems: "center", color: colors.accent },
  rowBody: { minWidth: 0, flex: 1 },
  rowTitle: { display: "flex", alignItems: "center", gap: space.s2, fontSize: text.sizeXs, lineHeight: text.lineXs, fontWeight: text.weightSemibold, color: colors.ink },
  // rounded-full border border-white/10 px-2 py-0.5 font-meta text-[8px] ...
  pill: { paddingInline: space.s2, paddingBlock: space.s0_5, color: colors.inkMuted },
  pillReady: { borderColor: colors.accentLineSubtle, backgroundColor: colors.accentWash, color: colors.accent },
  rowDetail: { marginTop: space.s0_5, fontSize: text.sizeMeta, lineHeight: text.lineXs, color: colors.inkMuted },
  track: { height: "0.25rem", marginTop: space.s1_5, overflow: "hidden", backgroundColor: colors.fillStrong },
  fill: { height: "100%", width: "var(--map-install-progress)", backgroundColor: colors.accent, transitionProperty: "width", transitionDuration: "500ms" },
  alert: { width: "100%", fontSize: text.sizeMeta, color: colors.warning },
  gate: { height: "100%", minHeight: 0 },
  gateHidden: { visibility: "hidden" },
  compactButton: { display: "inline-flex", alignItems: "center", gap: space.s1_5, paddingInline: space.s3, },
  primaryButton: { flex: 1, },
  iconSmall: { width: "0.875rem", height: "0.875rem" },
  // `mr-1 size-3.5` on the cloud-connect button only.
  iconSmallMr1: { width: "0.875rem", height: "0.875rem", marginInlineEnd: space.s1 },
  iconWithMargin: { width: "1rem", height: "1rem", marginInlineEnd: space.s2 },
});
