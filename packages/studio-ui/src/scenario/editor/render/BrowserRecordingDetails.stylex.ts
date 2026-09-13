import * as stylex from "@stylexjs/stylex";
import { colors, text, space } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // min-h-0 flex-1 overflow-y-auto p-4
  fillScrollYShrinkable: {
    minHeight: "0px",
    flex: "1 1 0%",
    overflowY: "auto",
    padding: space.xl,
  },
  // flex items-center gap-2
  flexCenterGap2: {
    display: "flex",
    alignItems: "center",
    gap: space.md,
  },
  // size-4
  size4: {
    width: "1rem",
    height: "1rem",
  },
  // min-w-0 flex-1
  fillNarrowable: {
    minWidth: "0px",
    flex: "1 1 0%",
  },
  // text-sm font-semibold
  smSemibold: {
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    fontWeight: text.weightSemibold,
  },
  // truncate font-mono text-micro text-muted-foreground
  monoMicroMuted: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontFamily: text.fontMono,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    color: colors.mutedForeground,
  },
  // mt-3 text-xs text-destructive
  xsDanger: {
    marginTop: space.lg,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.danger,
  },
  // min-h-72
  minH72: {
    minHeight: "18rem",
  },
  // mt-4 aspect-video w-full render-glass border bg-black
  borderedWideVideo: {
    marginTop: space.xl,
    aspectRatio: "16 / 9",
    width: "100%",
    borderWidth: "1px",
    backgroundColor: colors.glass,
    borderColor: "rgb(255 255 255 / 10%)",
  },
  // mt-3
  mt3: {
    marginTop: space.lg,
  },
  // flex items-baseline justify-between gap-3
  flexBetweenBaseline: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: space.lg,
  },
  // text-xs font-semibold uppercase tracking-meta
  capsXsSemibold: {
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    fontWeight: text.weightSemibold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
  },
  // font-mono text-micro text-muted-foreground
  monoMicroMuted2: {
    fontFamily: text.fontMono,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    color: colors.mutedForeground,
  },
  // mt-2 flex gap-2 overflow-x-auto pb-1
  flexGap2ScrollX: {
    marginTop: space.md,
    display: "flex",
    gap: space.md,
    overflowX: "auto",
    paddingBottom: space.xs,
  },
  // motionStyles.editorMotion + shrink-0 border render-hairline px-2.5 py-1.5 text-xs render-glass render-glass-hover aria-pressed:border-foreground/40 aria-pressed:bg-foreground/10 aria-pressed:text-foreground
  tightXsBordered: {
    flexShrink: "0",
    borderWidth: "1px",
    paddingLeft: "0.625rem",
    paddingRight: "0.625rem",
    paddingTop: space.sm,
    paddingBottom: space.sm,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    backgroundColor: {
      default: colors.glass,
      ":hover": colors.chipStrong,
    },
    borderColor: "rgb(255 255 255 / 10%)",
  },
  // mt-4
  mt4: {
    marginTop: space.xl,
  },
  // mt-2 grid gap-3 sm:grid-cols-2
  gridGap3: {
    marginTop: space.md,
    display: "grid",
    gap: space.lg,
    gridTemplateColumns: {
      default: null,
      "@media (min-width: 640px)": "repeat(2, minmax(0, 1fr))",
    },
  },
  // render-glass border p-2
  borderedPad2: {
    borderWidth: "1px",
    padding: space.md,
    backgroundColor: colors.glass,
    borderColor: "rgb(255 255 255 / 10%)",
  },
  // aspect-video w-full bg-black
  wideVideo: {
    aspectRatio: "16 / 9",
    width: "100%",
    backgroundColor: "rgb(0 0 0 / 1)",
  },
  // mt-1.5 truncate font-mono text-micro text-muted-foreground
  monoMicroMuted3: {
    marginTop: space.sm,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontFamily: text.fontMono,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    color: colors.mutedForeground,
  },
  // mt-4 grid grid-cols-2 gap-3 border-y render-hairline py-3 text-xs
  gridXsCols2: {
    marginTop: space.xl,
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: space.lg,
    borderTopWidth: "1px",
    borderBottomWidth: "1px",
    paddingTop: space.lg,
    paddingBottom: space.lg,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    borderColor: "rgb(255 255 255 / 10%)",
  },
  // mt-3 border border-destructive/40 p-3 text-xs text-destructive
  xsDangerBordered: {
    marginTop: space.lg,
    borderWidth: "1px",
    borderColor: "hsl(var(--destructive) / 0.4)",
    padding: space.lg,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.danger,
  },
  // font-medium
  medium: {
    fontWeight: text.weightMedium,
  },
  // mt-1 whitespace-pre-wrap text-micro
  micro: {
    marginTop: space.xs,
    whiteSpace: "pre-wrap",
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
  },
  // mt-2 text-xs text-muted-foreground
  xsMuted: {
    marginTop: space.md,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.mutedForeground,
  },
  /*
   * `space-y-*` is a `> * + *` rule with no StyleX form — StyleX styles only
   * the element they are applied to — so the margin it handed down now sits on
   * the child that received it, and only the first child goes without.
   */
  // mt-2
  listMt2: {
    marginTop: space.md,
  },
  // (was the file list's space-y-1)
  rowStackedXs: {
    marginTop: space.xs,
  },
  // flex items-center gap-2 render-glass border p-2 text-xs
  flexCenterXs: {
    display: "flex",
    alignItems: "center",
    gap: space.md,
    borderWidth: "1px",
    padding: space.md,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    backgroundColor: colors.glass,
    borderColor: "rgb(255 255 255 / 10%)",
  },
  // min-w-0 flex-1 truncate
  fillTruncateNarrowable: {
    minWidth: "0px",
    flex: "1 1 0%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  // motionStyles.editorMotion + grid size-8 place-items-center render-glass border render-glass-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
  gridCenteredBordered: {
    display: "grid",
    width: "2rem",
    height: "2rem",
    placeItems: "center",
    borderWidth: "1px",
    backgroundColor: {
      default: colors.glass,
      ":hover": colors.chipStrong,
    },
    borderColor: "rgb(255 255 255 / 10%)",
    outline: {
      default: null,
      ":focus-visible": "2px solid transparent",
    },
    outlineOffset: {
      default: null,
      ":focus-visible": "2px",
    },
    boxShadow: {
      default: null,
      ":focus-visible": "0 0 0 2px hsl(var(--ring))",
    },
  },
  // size-3.5
  size35: {
    width: "0.875rem",
    height: "0.875rem",
  },
  // text-micro text-muted-foreground
  microMuted: {
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    color: colors.mutedForeground,
  },
  // border render-hairline px-1.5 py-0.5 text-micro uppercase tracking-meta text-muted-foreground
  capsMicroMuted: {
    borderWidth: "1px",
    paddingLeft: space.sm,
    paddingRight: space.sm,
    paddingTop: space.xxs,
    paddingBottom: space.xxs,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: colors.mutedForeground,
    borderColor: "rgb(255 255 255 / 10%)",
  },
  // min-w-0
  narrowable: {
    minWidth: "0px",
  },
  // text-muted-foreground
  muted: {
    color: colors.mutedForeground,
  },

  // aria-pressed:border-foreground/40 aria-pressed:bg-foreground/10 aria-pressed:text-foreground
  // Applied off the same boolean that drives `aria-pressed`, which is what the
  // attribute selector was reading anyway.
  cameraChipSelected: {
    borderColor: "hsl(var(--foreground) / 0.4)",
    backgroundColor: "hsl(var(--foreground) / 0.1)",
    color: colors.text,
  },
  // truncate font-mono text-micro
  detailValueMono: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontFamily: text.fontMono,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
  },
  // truncate font-medium
  detailValue: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontWeight: text.weightMedium,
  },
});
