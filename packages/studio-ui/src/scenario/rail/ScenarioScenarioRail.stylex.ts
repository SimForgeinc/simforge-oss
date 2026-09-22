import * as stylex from "@stylexjs/stylex";
import { colors, layout, motion, space, stroke, text } from "../../stylex/tokens.stylex";

export const styles = stylex.create({
  row: { borderBottomWidth: stroke.hairline, borderBottomStyle: "solid", borderBottomColor: colors.border, ":last-child": { borderBottomWidth: 0 } },
  documentButton: { display: "flex", width: "100%", flexDirection: "column", gap: space.s0_5, borderLeftWidth: stroke.thick, borderLeftStyle: "solid", backgroundColor: "transparent", paddingInline: space.s2, paddingBlock: space.s2_5, textAlign: "left", outline: { default: "none", ":focus-visible": `2px solid ${colors.ring}` }, outlineOffset: 2 },
  activeDocument: { borderLeftColor: colors.accent, color: colors.text },
  idleDocument: { borderLeftColor: { default: "transparent", ":hover": colors.accent }, color: { default: colors.mutedForeground, ":hover": colors.text } },
  // flex h-full w-[220px] shrink-0 flex-col border-r border-white/15 bg-transparent
  scenarioScenarioRail: {
    display: "flex",
    height: "100%",
    width: "220px",
    flexShrink: 0,
    flexDirection: "column",
    borderRightWidth: stroke.hairline,
    borderRightStyle: "solid",
    borderColor: "rgb(255 255 255 / 0.15)",
    backgroundColor: "transparent",
  },
  // space-y-2 border-b border-white/15 p-3
  scenarioScenarioHeader: {
    borderBottomWidth: stroke.hairline,
    borderBottomStyle: "solid",
    borderColor: "rgb(255 255 255 / 0.15)",
    padding: space.s3,
    display: "flex",
    flexDirection: "column",
    gap: space.s2,
  },
  // flex min-w-0 items-center justify-between gap-2
  divFlex: {
    display: "flex",
    minWidth: 0,
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.s2,
  },
  // font-meta text-micro font-bold uppercase tracking-meta-wider text-foreground
  scenarios: {
    fontFamily: text.fontMeta,
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaWider,
    color: colors.text,
  },
  // font-meta text-micro tabular-nums text-white/70
  spanMetaMicro: {
    fontFamily: text.fontMeta,
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    fontVariantNumeric: "tabular-nums",
    color: colors.inkSecondary,
  },
  // flex items-center justify-between gap-2
  divFlex2: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.s2,
  },
  // flex min-w-0 flex-1 items-center gap-1 truncate font-meta text-micro uppercase tracking-meta-wider text-white/75 transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
  backToAllDatasetsButton: {
    display: "flex",
    minWidth: 0,
    flex: "1 1 0%",
    alignItems: "center",
    gap: space.s1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontFamily: text.fontMeta,
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaWider,
    color: { default: "rgb(255 255 255 / 0.75)", ":hover": colors.primary },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionDuration: motion.durStandard,
    transitionTimingFunction: motion.easeStandard,
    outline: { default: null, ":focus-visible": "2px solid transparent" },
    outlineOffset: { default: null, ":focus-visible": "2px" },
    boxShadow: { default: null, ":focus-visible": `0 0 0 2px ${colors.ring}` },
  },
  // size-3 shrink-0
  chevronleftIcon: {
    width: space.s3,
    height: space.s3,
    flexShrink: 0,
  },
  // truncate
  spanTruncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  // min-w-0 flex-1 truncate font-meta text-micro uppercase tracking-meta-wider text-white/75 transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
  openTheFullScenarioListLink: {
    minWidth: 0,
    flex: "1 1 0%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontFamily: text.fontMeta,
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaWider,
    color: { default: "rgb(255 255 255 / 0.75)", ":hover": colors.primary },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionDuration: motion.durStandard,
    transitionTimingFunction: motion.easeStandard,
    outline: { default: null, ":focus-visible": "2px solid transparent" },
    outlineOffset: { default: null, ":focus-visible": "2px" },
    boxShadow: { default: null, ":focus-visible": `0 0 0 2px ${colors.ring}` },
  },
  // mr-1 inline size-3
  layoutlistIcon: {
    marginRight: space.s1,
    display: "inline",
    width: space.s3,
    height: space.s3,
  },
  // size-3.5
  barchart3Icon: {
    width: "0.875rem",
    height: "0.875rem",
  },
  // flex items-center gap-1
  divFlex3: {
    display: "flex",
    alignItems: "center",
    gap: space.s1,
  },
  // size-3.5
  chevronupIcon: {
    width: "0.875rem",
    height: "0.875rem",
  },
  // size-3.5
  chevrondownIcon: {
    width: "0.875rem",
    height: "0.875rem",
  },
  // size-3
  pauseIcon: {
    width: space.s3,
    height: space.s3,
  },
  // size-3
  playIcon: {
    width: space.s3,
    height: space.s3,
  },
  // size-3
  plusIcon: {
    width: space.s3,
    height: space.s3,
  },
  // h-px w-full bg-white/15
  timeUntilTheNextScenario: {
    height: "1px",
    width: "100%",
    backgroundColor: colors.fillStronger,
  },
  // h-full bg-primary transition-[width] duration-100 ease-linear motion-reduce:transition-none
  div: {
    height: "100%",
    backgroundColor: colors.primary,
    transitionProperty: { default: "width", [layout.reducedMotion]: "none" },
    transitionDuration: "100ms",
    transitionTimingFunction: motion.easeLinear,
  },
  // scenario-glass-scrollbar min-h-0 flex-1 overflow-y-auto px-3
  div2: {
    minHeight: 0,
    flex: "1 1 0%",
    overflowY: "auto",
    paddingInline: space.s3,
  },
  // px-1 py-2 text-meta text-destructive
  alert: {
    paddingInline: space.s1,
    paddingBlock: space.s2,
    fontSize: text.sizeMeta,
    lineHeight: text.lineXs,
    color: colors.danger,
  },
  // px-1 py-2 text-meta text-white/75
  noScenariosInThisDatasetYet: {
    paddingInline: space.s1,
    paddingBlock: space.s2,
    fontSize: text.sizeMeta,
    lineHeight: text.lineXs,
    color: "rgb(255 255 255 / 0.75)",
  },
  // line-clamp-2 text-meta font-medium leading-tight
  spanMetaMedium: {
    display: "-webkit-box",
    WebkitLineClamp: 2,
    WebkitBoxOrient: "vertical",
    overflow: "hidden",
    fontSize: text.sizeMeta,
    lineHeight: text.lineTight,
    fontWeight: text.weightMedium,
  },
  // truncate font-meta text-micro uppercase tracking-meta-tight text-white/70
  spanTruncateMetaMicro: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontFamily: text.fontMeta,
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaTight,
    color: colors.inkSecondary,
  },
  // font-meta text-micro uppercase tracking-meta-tight text-green-400
  rendered: {
    fontFamily: text.fontMeta,
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaTight,
    color: "rgb(74 222 128 / 1)",
  },
});
