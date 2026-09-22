import * as stylex from "@stylexjs/stylex";
import { colors, space, text } from "../../stylex/tokens.stylex";

export const styles = stylex.create({
  row: { borderBottomWidth: 1, borderBottomStyle: "solid", borderBottomColor: colors.border, ":last-child": { borderBottomWidth: 0 } },
  documentButton: { display: "flex", width: "100%", flexDirection: "column", gap: space.xxs, borderLeftWidth: 2, borderLeftStyle: "solid", backgroundColor: "transparent", paddingInline: space.md, paddingBlock: "0.625rem", textAlign: "left", outline: { default: "none", ":focus-visible": `2px solid ${colors.ring}` }, outlineOffset: 2 },
  activeDocument: { borderLeftColor: colors.accent, color: colors.text },
  idleDocument: { borderLeftColor: { default: "transparent", ":hover": colors.accent }, color: { default: colors.mutedForeground, ":hover": colors.text } },
  // flex h-full w-[220px] shrink-0 flex-col border-r border-white/15 bg-transparent
  scenarioScenarioRail: {
    display: "flex",
    height: "100%",
    width: "220px",
    flexShrink: 0,
    flexDirection: "column",
    borderRightWidth: "1px",
    borderRightStyle: "solid",
    borderColor: "rgb(255 255 255 / 0.15)",
    backgroundColor: "transparent",
  },
  // space-y-2 border-b border-white/15 p-3
  scenarioScenarioHeader: {
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderColor: "rgb(255 255 255 / 0.15)",
    padding: space.lg,
    display: "flex",
    flexDirection: "column",
    gap: space.md,
  },
  // flex min-w-0 items-center justify-between gap-2
  divFlex: {
    display: "flex",
    minWidth: 0,
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.md,
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
    color: "rgb(255 255 255 / 0.7)",
  },
  // flex items-center justify-between gap-2
  divFlex2: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.md,
  },
  // flex min-w-0 flex-1 items-center gap-1 truncate font-meta text-micro uppercase tracking-meta-wider text-white/75 transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
  backToAllDatasetsButton: {
    display: "flex",
    minWidth: 0,
    flex: "1 1 0%",
    alignItems: "center",
    gap: space.xs,
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
    transitionDuration: "150ms",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    outline: { default: null, ":focus-visible": "2px solid transparent" },
    outlineOffset: { default: null, ":focus-visible": "2px" },
    boxShadow: { default: null, ":focus-visible": `0 0 0 2px ${colors.ring}` },
  },
  // size-3 shrink-0
  chevronleftIcon: {
    width: space.lg,
    height: space.lg,
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
    transitionDuration: "150ms",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    outline: { default: null, ":focus-visible": "2px solid transparent" },
    outlineOffset: { default: null, ":focus-visible": "2px" },
    boxShadow: { default: null, ":focus-visible": `0 0 0 2px ${colors.ring}` },
  },
  // mr-1 inline size-3
  layoutlistIcon: {
    marginRight: space.xs,
    display: "inline",
    width: space.lg,
    height: space.lg,
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
    gap: space.xs,
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
    width: space.lg,
    height: space.lg,
  },
  // size-3
  playIcon: {
    width: space.lg,
    height: space.lg,
  },
  // size-3
  plusIcon: {
    width: space.lg,
    height: space.lg,
  },
  // h-px w-full bg-white/15
  timeUntilTheNextScenario: {
    height: "1px",
    width: "100%",
    backgroundColor: "rgb(255 255 255 / 0.15)",
  },
  // h-full bg-primary transition-[width] duration-100 ease-linear motion-reduce:transition-none
  div: {
    height: "100%",
    backgroundColor: colors.primary,
    transitionProperty: { default: "width", "@media (prefers-reduced-motion: reduce)": "none" },
    transitionDuration: "100ms",
    transitionTimingFunction: "linear",
  },
  // scenario-glass-scrollbar min-h-0 flex-1 overflow-y-auto px-3
  div2: {
    minHeight: 0,
    flex: "1 1 0%",
    overflowY: "auto",
    paddingInline: space.lg,
  },
  // px-1 py-2 text-meta text-destructive
  alert: {
    paddingInline: space.xs,
    paddingBlock: space.md,
    fontSize: text.sizeMeta,
    lineHeight: text.lineMeta,
    color: colors.danger,
  },
  // px-1 py-2 text-meta text-white/75
  noScenariosInThisDatasetYet: {
    paddingInline: space.xs,
    paddingBlock: space.md,
    fontSize: text.sizeMeta,
    lineHeight: text.lineMeta,
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
    color: "rgb(255 255 255 / 0.7)",
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
