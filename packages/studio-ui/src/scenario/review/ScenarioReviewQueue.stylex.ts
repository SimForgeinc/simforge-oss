import * as stylex from "@stylexjs/stylex";
import { colors, space, text } from "../../stylex/tokens.stylex";

export const styles = stylex.create({
  // flex min-h-full flex-col bg-background
  divFlex: {
    display: "flex",
    minHeight: "100%",
    flexDirection: "column",
    backgroundColor: colors.bg,
  },
  // border-b border-border/70 bg-card/25 px-5 py-3 sm:px-6
  div: {
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderColor: "hsl(var(--border) / 0.7)",
    backgroundColor: "hsl(var(--card) / 0.25)",
    paddingInline: { default: "1.25rem", "@media (min-width: 640px)": space.xxl },
    paddingBlock: space.lg,
  },
  // flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground
  reviewQueueKeyboardShortcuts: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: "1.25rem",
    rowGap: space.md,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.mutedForeground,
  },
  // font-medium text-foreground
  shortcuts: {
    fontWeight: text.weightMedium,
    color: colors.text,
  },
  // rounded border border-border px-1.5 py-0.5 font-mono text-foreground
  kbdMono: {
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: colors.border,
    paddingInline: space.sm,
    paddingBlock: space.xxs,
    fontFamily: text.fontMono,
    color: colors.text,
  },
  // rounded border border-border px-1.5 py-0.5 font-mono text-foreground
  kbdMono2: {
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: colors.border,
    paddingInline: space.sm,
    paddingBlock: space.xxs,
    fontFamily: text.fontMono,
    color: colors.text,
  },
  // border-b border-destructive/40 bg-destructive/10 px-5 py-3 text-sm text-destructive sm:px-6
  alert: {
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderColor: "hsl(var(--destructive) / 0.4)",
    backgroundColor: "hsl(var(--destructive) / 0.1)",
    paddingInline: { default: "1.25rem", "@media (min-width: 640px)": space.xxl },
    paddingBlock: space.lg,
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    color: colors.danger,
  },
  // flex-1 px-5 py-5 sm:px-6
  div2: {
    flex: "1 1 0%",
    paddingInline: { default: "1.25rem", "@media (min-width: 640px)": space.xxl },
    paddingBlock: "1.25rem",
  },
  // size-6
  clipboardcheckIcon: {
    width: space.xxl,
    height: space.xxl,
  },
  // grid gap-4 lg:grid-cols-2 xl:grid-cols-3
  ulGrid: {
    display: "grid",
    gap: space.xl,
    gridTemplateColumns: { default: null, "@media (min-width: 1024px)": "repeat(2, minmax(0, 1fr))", "@media (min-width: 1280px)": "repeat(3, minmax(0, 1fr))" },
  },
  // min-w-0 space-y-1
  div3: {
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: space.xs,
  },
  // truncate text-sm font-semibold text-foreground
  h3TruncateSmSemibold: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    fontWeight: text.weightSemibold,
    color: colors.text,
  },
  // text-xs text-muted-foreground
  pXs: {
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.mutedForeground,
  },
  // line-clamp-2 text-xs text-muted-foreground/90
  pXs2: {
    display: "-webkit-box",
    WebkitLineClamp: 2,
    WebkitBoxOrient: "vertical",
    overflow: "hidden",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: "hsl(var(--muted-foreground) / 0.9)",
  },
  // flex flex-wrap items-center gap-1.5
  divFlex2: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space.sm,
  },
  // mt-auto flex items-center gap-1.5
  rate: {
    marginTop: "auto",
    display: "flex",
    alignItems: "center",
    gap: space.sm,
  },
  // mt-5 flex justify-center
  divFlex3: {
    marginTop: "1.25rem",
    display: "flex",
    justifyContent: "center",
  },
});
