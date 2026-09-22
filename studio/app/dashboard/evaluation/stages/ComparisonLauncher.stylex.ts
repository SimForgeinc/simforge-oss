import * as stylex from "@stylexjs/stylex";
import { colors, space, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

const spin = stylex.keyframes({ from: { transform: "rotate(0deg)" }, to: { transform: "rotate(360deg)" } });

export const styles = stylex.create({
  // text-base
  runANewComparisonCardTitle: {
    fontSize: text.sizeBase,
    lineHeight: "1.5rem",
  },
  // flex flex-col gap-4
  cardcontentFlex: {
    display: "flex",
    flexDirection: "column",
    gap: space.s4,
  },
  // grid gap-3 sm:grid-cols-2
  divGrid: {
    display: "grid",
    gap: space.s3,
    gridTemplateColumns: { default: null, "@media (min-width: 640px)": "repeat(2, minmax(0, 1fr))" },
  },
  // flex flex-col gap-1 text-xs
  labelFlexXs: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
  },
  // text-muted-foreground
  kind: {
    color: colors.mutedForeground,
  },
  // rounded border bg-transparent px-2 py-1 text-sm
  selectSm: {
    borderWidth: "1px",
    borderStyle: "solid",
    backgroundColor: "transparent",
    paddingInline: space.s2,
    paddingBlock: space.s1,
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
  },
  // flex flex-col gap-1 text-xs
  labelFlexXs2: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
  },
  // text-muted-foreground
  mode: {
    color: colors.mutedForeground,
  },
  // rounded border bg-transparent px-2 py-1 text-sm
  selectSm2: {
    borderWidth: "1px",
    borderStyle: "solid",
    backgroundColor: "transparent",
    paddingInline: space.s2,
    paddingBlock: space.s1,
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
  },
  // flex flex-col gap-1 text-xs sm:col-span-2
  labelFlexXs3: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    gridColumn: { default: null, "@media (min-width: 640px)": "span 2 / span 2" },
  },
  // text-muted-foreground
  episodeSpec: {
    color: colors.mutedForeground,
  },
  // rounded border bg-transparent px-2 py-1 font-mono text-sm
  inputMonoSm: {
    borderWidth: "1px",
    borderStyle: "solid",
    backgroundColor: "transparent",
    paddingInline: space.s2,
    paddingBlock: space.s1,
    fontFamily: text.fontMono,
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
  },
  // flex flex-col gap-1 text-xs sm:col-span-2
  labelFlexXs4: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    gridColumn: { default: null, "@media (min-width: 640px)": "span 2 / span 2" },
  },
  // text-muted-foreground
  frameSource: {
    color: colors.mutedForeground,
  },
  // rounded border bg-transparent px-2 py-1 font-mono text-sm
  inputMonoSm2: {
    borderWidth: "1px",
    borderStyle: "solid",
    backgroundColor: "transparent",
    paddingInline: space.s2,
    paddingBlock: space.s1,
    fontFamily: text.fontMono,
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
  },
  // flex flex-col gap-1 text-xs
  labelFlexXs5: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
  },
  // text-muted-foreground
  seeds: {
    color: colors.mutedForeground,
  },
  // rounded border bg-transparent px-2 py-1 font-mono text-sm
  inputMonoSm3: {
    borderWidth: "1px",
    borderStyle: "solid",
    backgroundColor: "transparent",
    paddingInline: space.s2,
    paddingBlock: space.s1,
    fontFamily: text.fontMono,
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
  },
  // flex flex-col gap-1 text-xs
  labelFlexXs6: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
  },
  // text-muted-foreground
  stepsPerEpisode: {
    color: colors.mutedForeground,
  },
  // rounded border bg-transparent px-2 py-1 font-mono text-sm
  inputMonoSm4: {
    borderWidth: "1px",
    borderStyle: "solid",
    backgroundColor: "transparent",
    paddingInline: space.s2,
    paddingBlock: space.s1,
    fontFamily: text.fontMono,
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
  },
  // flex flex-col gap-1 text-xs
  labelFlexXs7: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
  },
  // text-muted-foreground
  decisionRate: {
    color: colors.mutedForeground,
  },
  // rounded border bg-transparent px-2 py-1 font-mono text-sm
  inputMonoSm5: {
    borderWidth: "1px",
    borderStyle: "solid",
    backgroundColor: "transparent",
    paddingInline: space.s2,
    paddingBlock: space.s1,
    fontFamily: text.fontMono,
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
  },
  // flex flex-col gap-1 text-xs
  labelFlexXs8: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
  },
  // text-muted-foreground
  deadline: {
    color: colors.mutedForeground,
  },
  // rounded border bg-transparent px-2 py-1 font-mono text-sm
  inputMonoSm6: {
    borderWidth: "1px",
    borderStyle: "solid",
    backgroundColor: "transparent",
    paddingInline: space.s2,
    paddingBlock: space.s1,
    fontFamily: text.fontMono,
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
  },
  // flex flex-col gap-2
  divFlex: {
    display: "flex",
    flexDirection: "column",
    gap: space.s2,
  },
  // flex flex-wrap items-center gap-2 rounded border p-2
  divFlex2: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space.s2,
    borderWidth: "1px",
    borderStyle: "solid",
    padding: space.s2,
  },
  // font-mono text-[10px]
  badgeMono: {
    fontFamily: text.fontMono,
    fontSize: "10px",
  },
  // rounded border bg-transparent px-2 py-1 text-sm
  selectSm3: {
    borderWidth: "1px",
    borderStyle: "solid",
    backgroundColor: "transparent",
    paddingInline: space.s2,
    paddingBlock: space.s1,
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
  },
  // rounded border bg-transparent px-2 py-1 text-sm
  selectSm4: {
    borderWidth: "1px",
    borderStyle: "solid",
    backgroundColor: "transparent",
    paddingInline: space.s2,
    paddingBlock: space.s1,
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
  },
  // w-36 rounded border bg-transparent px-2 py-1 font-mono text-xs
  inputMonoXs: {
    width: "9rem",
    borderWidth: "1px",
    borderStyle: "solid",
    backgroundColor: "transparent",
    paddingInline: space.s2,
    paddingBlock: space.s1,
    fontFamily: text.fontMono,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
  },
  // ml-auto text-muted-foreground hover:text-foreground
  removeColumnButton: {
    marginLeft: "auto",
    color: { default: colors.mutedForeground, ":hover": colors.text },
  },
  // h-4 w-4
  x: {
    height: space.s4,
    width: space.s4,
  },
  // w-full text-xs text-amber-600 dark:text-amber-400
  pXs: {
    width: "100%",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: "rgb(251 191 36 / 1)",
  },
  // self-start
  button: {
    alignSelf: "flex-start",
  },
  // mr-1.5 h-3.5 w-3.5
  addAModelColumnPlus: {
    marginRight: space.s1_5,
    height: "0.875rem",
    width: "0.875rem",
  },
  // list-disc pl-5 text-xs text-muted-foreground
  ulXs: {
    listStyleType: "disc",
    paddingLeft: "1.25rem",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.mutedForeground,
  },
  // flex items-center gap-3
  divFlex3: {
    display: "flex",
    alignItems: "center",
    gap: space.s3,
  },
  // mr-1.5 h-3.5 w-3.5 animate-spin
  loader2: {
    marginRight: space.s1_5,
    height: "0.875rem",
    width: "0.875rem",
    animationName: spin,
    animationDuration: "1s",
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
  },
  // text-xs hover:underline
  comparisonLink: {
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    textDecoration: { default: null, ":hover": "underline" },
  },
  // flex flex-col gap-1 rounded border p-2 text-xs
  divFlexXs: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
    borderWidth: "1px",
    borderStyle: "solid",
    padding: space.s2,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
  },
  // text-destructive
  p: {
    color: colors.danger,
  },
  // font-medium
  spanMedium: {
    fontWeight: text.weightMedium,
  },
  // text-amber-600 dark:text-amber-400
  refused: {
    color: "rgb(251 191 36 / 1)",
  },
});
