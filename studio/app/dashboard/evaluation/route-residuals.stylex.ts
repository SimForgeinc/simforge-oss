import * as stylex from "@stylexjs/stylex";
import { colors, motion, space, stroke, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

const spin = stylex.keyframes({ from: { transform: "rotate(0deg)" }, to: { transform: "rotate(360deg)" } });

export const styles = stylex.create({
  content: { display: "flex", flexDirection: "column", gap: space.s5, paddingInline: space.s5, paddingBlock: space.s5, "@media (min-width: 640px)": { paddingInline: space.s6 } },
  content4: { display: "flex", flexDirection: "column", gap: space.s4, paddingInline: space.s5, paddingBlock: space.s5, "@media (min-width: 640px)": { paddingInline: space.s6 } },
  content6: { display: "flex", flexDirection: "column", rowGap: space.s6, paddingInline: space.s5, paddingBlock: space.s5, "@media (min-width: 640px)": { paddingInline: space.s6 } },
  grid4: { display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: space.s4, "@media (min-width: 640px)": { gridTemplateColumns: "repeat(4,minmax(0,1fr))" } },
  grid3: { display: "grid", gridTemplateColumns: "repeat(1,minmax(0,1fr))", gap: space.s4, "@media (min-width: 1024px)": { gridTemplateColumns: "repeat(3,minmax(0,1fr))" } },
  dlProvenance: { display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", columnGap: space.s6, rowGap: space.s2, fontSize: text.sizeSm, lineHeight: text.lineSm, "@media (min-width: 640px)": { gridTemplateColumns: "repeat(3,minmax(0,1fr))" } },
  dlState: { display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", columnGap: space.s4, rowGap: space.s2, fontFamily: text.fontMono, fontSize: text.sizeSm, lineHeight: text.lineSm },
  dlRun: { display: "grid", columnGap: space.s8, rowGap: space.s2, fontSize: text.sizeSm, lineHeight: text.lineSm, "@media (min-width: 640px)": { gridTemplateColumns: "repeat(4,minmax(0,1fr))" } },
  dlMetrics: { display: "grid", columnGap: space.s8, rowGap: space.s1, fontSize: text.sizeXs, lineHeight: text.lineXs, "@media (min-width: 640px)": { gridTemplateColumns: "repeat(3,minmax(0,1fr))" } },
  cardStack3: { display: "flex", flexDirection: "column", gap: space.s3 }, cardStack3Top: { display: "flex", flexDirection: "column", gap: space.s3, paddingTop: space.s5 },
  cardHeaderTight: { paddingBottom: space.s2 }, cardTitle: { fontSize: text.sizeBase, lineHeight: text.lineBase }, cardTitleSmall: { fontSize: text.sizeSm, lineHeight: text.lineSm, fontWeight: text.weightSemibold, color: colors.text }, cardTitleLarge: { fontFamily: text.fontMono, fontSize: text.size2xl, lineHeight: text.lineXl },
  mono: { fontFamily: text.fontMono }, monoSmall: { fontFamily: text.fontMono, fontSize: text.sizeXs, lineHeight: text.lineXs },
  /** `font-mono text-[10px]` replaced the Badge's entire `text-xs` utility, including its leading. */
  monoTiny: { fontFamily: text.fontMono, fontSize: "10px", lineHeight: "inherit" },
  muted: { color: colors.mutedForeground },
  /** `text-[10px] text-muted-foreground` — the reasoning note. */
  tinyMuted: { fontSize: "10px", color: colors.mutedForeground },
  // SVG paint: `fill-muted-foreground` on the two chart captions. `color` would
  // leave the glyphs on the UA default fill.
  svgCaptionTiny: { fontSize: "10px", fill: colors.mutedForeground },
  /** `text-[10px] uppercase text-muted-foreground` — the ego-state <dt>s. */
  tinyLabel: { fontSize: "10px", textTransform: "uppercase", color: colors.mutedForeground },
  /** `text-[10px]` alone — it rides a `Badge` variant, which owns the colour. */
  tinyBadge: { fontSize: "10px", lineHeight: "inherit" },
  /** `text-xs text-muted-foreground` — the named scale, which carries its own leading. */
  xsMuted: { fontSize: text.sizeXs, lineHeight: text.lineXs, color: colors.mutedForeground },
  /** `text-xs leading-5 text-muted-foreground` — same scale, looser leading for the run notes. */
  xsMutedRelaxed: { fontSize: text.sizeXs, lineHeight: text.lineSm, color: colors.mutedForeground },
  label: { fontSize: text.sizeXs, lineHeight: text.lineXs, textTransform: "uppercase", letterSpacing: text.trackingWide, color: colors.mutedForeground }, labelMedium: { fontSize: text.sizeXs, lineHeight: text.lineXs, fontWeight: text.weightMedium, color: colors.mutedForeground },
  textSmall: { fontSize: text.sizeSm, lineHeight: text.lineSm }, link: { ":hover": { textDecorationLine: "underline" } }, linkMedium: { fontWeight: text.weightMedium, ":hover": { textDecorationLine: "underline" } },
  /** `mt-0.5 break-all text-foreground` — provenance <dd>s hold unbroken digests/ids that must break anywhere. */
  ddBreakAll: { marginTop: space.s0_5, wordBreak: "break-all", color: colors.text },
  /** `min-w-0 truncate` — run/manifest <dd> values ellipsise inside their grid track instead of widening it. */
  truncateValue: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  numeric: { textAlign: "right", fontFamily: text.fontMono }, numericTinyMuted: { textAlign: "right", fontFamily: text.fontMono, fontSize: text.sizeXs, lineHeight: text.lineXs, color: colors.mutedForeground },
  icon: { width: "1rem", height: "1rem", marginRight: space.s1_5 }, iconBare: { width: "1rem", height: "1rem" }, iconTopShrink: { marginTop: space.s0_5, width: "1rem", height: "1rem", flexShrink: 0 },
  spinnerSm: { width: ".875rem", height: ".875rem", animationName: spin, animationDuration: motion.durSpin, animationTimingFunction: motion.easeLinear, animationIterationCount: "infinite", color: colors.mutedForeground },
  spinnerPlain: { width: "1rem", height: "1rem", animationName: spin, animationDuration: motion.durSpin, animationTimingFunction: motion.easeLinear, animationIterationCount: "infinite" },
  flexWrap: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: space.s3 }, controls: { display: "flex", alignItems: "center", gap: space.s3 }, range: { width: "100%", accentColor: "hsl(var(--primary))" }, time: { width: "11rem", flexShrink: 0, textAlign: "right", fontFamily: text.fontMono, fontSize: text.sizeXs, lineHeight: text.lineXs, color: colors.mutedForeground },
  chart: { width: "100%", cursor: "crosshair", userSelect: "none", borderRadius: ".375rem", borderWidth: stroke.hairline, borderStyle: "solid", borderColor: colors.border, backgroundColor: "hsl(var(--muted) / .3)" }, chartStatic: { width: "100%", borderRadius: ".375rem", borderWidth: stroke.hairline, borderStyle: "solid", borderColor: colors.border, backgroundColor: "hsl(var(--muted) / .3)" },
  section: { display: "flex", flexDirection: "column", rowGap: space.s2 }, resultBox: { display: "flex", alignItems: "flex-start", gap: space.s2, borderRadius: ".375rem", paddingInline: space.s3, paddingBlock: space.s2, fontSize: text.sizeSm, lineHeight: text.lineSm, borderWidth: stroke.hairline, borderStyle: "solid" },
  /** `border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300` — dark value folded. */
  promoted: { borderColor: "rgba(16,185,129,.4)", backgroundColor: "rgba(16,185,129,.1)", color: "rgb(110,231,183)" }, refused: { borderColor: "hsl(var(--destructive) / .4)", backgroundColor: "hsl(var(--destructive) / .1)", color: colors.danger },
  /**
   * `bg-emerald-500/15 text-emerald-600 dark:text-emerald-400` — dark value
   * folded. It rides the default `Badge` variant, which repaints the
   * background on :hover; the utility pinned the rest state only, so the
   * variant's hover value is restated here rather than dropped.
   */
  promotedBadge: { backgroundColor: { default: "rgba(16,185,129,.15)", ":hover": "hsl(var(--primary) / 0.8)" }, color: colors.positive },
  list: { display: "flex", flexDirection: "column", rowGap: space.s1_5 }, event: { display: "flex", alignItems: "center", gap: space.s3, borderRadius: ".375rem", borderWidth: stroke.hairline, borderStyle: "solid", borderColor: "transparent", paddingInline: space.s2, paddingBlock: space.s1, fontSize: text.sizeSm, lineHeight: text.lineSm }, reached: { backgroundColor: "hsl(var(--muted) / .5)" }, unreached: { opacity: .5 }, dot: { width: ".5rem", height: ".5rem", flexShrink: 0, borderRadius: "9999px" }, eventPosition: { fontFamily: text.fontMono, fontSize: "10px", color: colors.mutedForeground }, infractionBadge: { fontFamily: text.fontMono, fontSize: "10px", lineHeight: "inherit" }, frames: { display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: space.s2 }, image: { width: "100%", borderRadius: ".25rem", borderWidth: stroke.hairline, borderStyle: "solid", borderColor: colors.border }, centerCaption: { marginTop: space.s1, textAlign: "center" }, whitespace: { whiteSpace: "pre-wrap", fontSize: text.sizeSm, lineHeight: text.lineBase, color: colors.text }, actionData: { borderRadius: ".375rem", backgroundColor: "hsl(var(--muted) / .4)", padding: space.s2, fontFamily: text.fontMono, fontSize: text.sizeXs, lineHeight: text.lineXs, color: colors.mutedForeground }, outputList: { borderWidth: stroke.hairline, borderStyle: "solid", borderColor: colors.border, fontSize: text.sizeXs, lineHeight: text.lineXs }, outputItem: { paddingInline: space.s3, paddingBlock: space.s2, fontFamily: text.fontMono, color: colors.mutedForeground, borderBottomWidth: stroke.hairline, borderBottomStyle: "solid", borderBottomColor: colors.border },
});
