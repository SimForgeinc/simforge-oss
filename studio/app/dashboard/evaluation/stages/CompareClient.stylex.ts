import * as stylex from "@stylexjs/stylex";
import { colors, space, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

export const styles = stylex.create({
  verdict: { fontSize: text.sizeXs, borderColor: "transparent" },
  verdictMatched: { color: colors.signalGreen, backgroundColor: colors.muted },
  verdictDifferent: { color: colors.accent, backgroundColor: colors.muted },
  verdictUnknown: { color: colors.mutedForeground, backgroundColor: colors.muted },
  verdictInvalid: { color: colors.danger, backgroundColor: colors.muted },
  disclosureIcon: { width: "0.75rem", height: "0.75rem", transitionProperty: "transform", transitionDuration: "150ms" },
  disclosureOpen: { transform: "rotate(180deg)" },
  // grid grid-cols-2 gap-2
  dlGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: space.md,
  },
  // text-xs text-muted-foreground
  episodes: {
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.mutedForeground,
  },
  // font-mono
  ddMono: {
    fontFamily: text.fontMono,
  },
  // text-xs text-muted-foreground
  meanScore: {
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.mutedForeground,
  },
  // font-mono
  ddMono2: {
    fontFamily: text.fontMono,
  },
  // text-xs text-amber-700 dark:text-amber-400
  cameraHistoryWasResampled: {
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: "rgb(251 191 36 / 1)",
  },
  // flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground
  buttonFlexXs: {
    display: "flex",
    alignItems: "center",
    gap: space.xs,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: { default: colors.mutedForeground, ":hover": colors.text },
  },
  // grid grid-cols-1 gap-1 border-t pt-2 text-[11px]
  dlGrid2: {
    display: "grid",
    gridTemplateColumns: "repeat(1, minmax(0, 1fr))",
    gap: space.xs,
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    paddingTop: space.md,
    fontSize: "11px",
  },
  // flex items-baseline justify-between gap-2
  divFlex: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: space.md,
  },
  // text-muted-foreground
  dt: {
    color: colors.mutedForeground,
  },
  // truncate font-mono
  ddTruncateMono: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontFamily: text.fontMono,
  },
  // pt-1
  div: {
    paddingTop: space.xs,
  },
  // hover:underline
  openColumnRunLink: {
    textDecoration: { default: null, ":hover": "underline" },
  },
  // space-y-1 border-b py-3 last:border-b-0
  div2: {
    borderBottomWidth: { default: "1px", ":last-child": 0 },
    borderBottomStyle: "solid",
    paddingBlock: space.lg,
    display: "flex",
    flexDirection: "column",
    gap: space.xs,
  },
  // flex flex-wrap items-baseline gap-2
  divFlex2: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "baseline",
    gap: space.md,
  },
  // text-sm font-medium
  spanSmMedium: {
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    fontWeight: text.weightMedium,
  },
  // bg-amber-500/15 text-[10px] text-amber-700 border-transparent dark:text-amber-400
  readingsOnlyBadge: {
    backgroundColor: "rgb(245 158 11 / 0.15)",
    fontSize: "10px",
    color: "rgb(251 191 36 / 1)",
    borderColor: "transparent",
  },
  // grid gap-2 sm:grid-cols-3
  divGrid: {
    display: "grid",
    gap: space.md,
    gridTemplateColumns: { default: null, "@media (min-width: 640px)": "repeat(3, minmax(0, 1fr))" },
  },
  // text-sm
  divSm: {
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
  },
  // text-xs text-muted-foreground
  divXs: {
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.mutedForeground,
  },
  // font-mono
  divMono: {
    fontFamily: text.fontMono,
  },
  // ml-1 text-[10px] text-muted-foreground
  span: {
    marginLeft: space.xs,
    fontSize: "10px",
    color: colors.mutedForeground,
  },
  // text-[11px] text-muted-foreground
  excluded: {
    fontSize: "11px",
    color: colors.mutedForeground,
  },
  // text-muted-foreground
  noRun: {
    color: colors.mutedForeground,
  },
  // text-muted-foreground
  thisRunCouldNotAssessThisMet: {
    color: colors.mutedForeground,
  },
  // text-muted-foreground
  span2: {
    color: colors.mutedForeground,
  },
  // space-x-1
  tablecell: {
    display: "flex",
    flexDirection: "row",
    gap: space.xs,
  },
  // font-mono text-[10px] text-muted-foreground
  spanMono: {
    fontFamily: text.fontMono,
    fontSize: "10px",
    color: colors.mutedForeground,
  },
  // text-xs text-muted-foreground
  none: {
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.mutedForeground,
  },
  /** `font-medium` on a table cell whose content is a scenario link */
  linkMedium: {
    fontWeight: text.weightMedium,
  },
});
