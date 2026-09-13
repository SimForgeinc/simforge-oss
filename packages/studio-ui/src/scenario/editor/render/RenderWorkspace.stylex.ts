import * as stylex from "@stylexjs/stylex";
import { colors, text, space } from "../../../stylex/tokens.stylex";

/*
 * A gallery tile's entrance, staggered by index via `--render-tile-index` set
 * on the element, capped so a long gallery does not make the last tile arrive
 * noticeably late.
 */
const tileEnter = stylex.keyframes({
  from: { opacity: 0, transform: "translate3d(0, 8px, 0) scale(0.985)" },
  to: { opacity: 1, transform: "none" },
});

export const styles = stylex.create({
  tileEnter: {
    animationName: {
      default: tileEnter,
      "@media (prefers-reduced-motion: reduce)": "none",
    },
    animationDuration: "280ms",
    animationTimingFunction: "cubic-bezier(0.2, 0.8, 0.2, 1)",
    animationFillMode: "both",
    animationDelay: "calc(min(var(--render-tile-index, 0), 11) * 28ms)",
  },
  // render-glass-pane render-hairline flex min-h-0 flex-1 flex-col border-l backdrop-blur-2xl backdrop-saturate-150
  flexColFill: {
    display: "flex",
    minHeight: "0px",
    flex: "1 1 0%",
    flexDirection: "column",
    borderLeftWidth: "1px",
    backdropFilter: "blur(40px) saturate(1.5)",
    backgroundImage: "linear-gradient(180deg, rgb(9 11 16 / 46%) 0%, rgb(9 11 16 / 62%) 100%)",
    borderColor: "rgb(255 255 255 / 10%)",
  },
  // flex shrink-0 items-center gap-2 border-b render-hairline px-4 py-2.5
  flexCenterTight: {
    display: "flex",
    flexShrink: "0",
    alignItems: "center",
    gap: space.md,
    borderBottomWidth: "1px",
    paddingLeft: space.xl,
    paddingRight: space.xl,
    paddingTop: "0.625rem",
    paddingBottom: "0.625rem",
    borderColor: "rgb(255 255 255 / 10%)",
  },
  // min-w-0 flex-1
  fillNarrowable: {
    minWidth: "0px",
    flex: "1 1 0%",
  },
  // truncate text-sm font-semibold text-foreground
  smInkSemibold: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    fontWeight: text.weightSemibold,
    color: colors.text,
  },
  // truncate text-micro uppercase tracking-meta text-muted-foreground
  capsMicroMuted: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: colors.mutedForeground,
  },
  // size-3.5
  size35: {
    width: "0.875rem",
    height: "0.875rem",
  },
  // size-4
  size4: {
    width: "1rem",
    height: "1rem",
  },
  // render-view-enter flex shrink-0 flex-wrap items-center gap-2 border-b render-hairline px-4 py-2.5
  flexCenterWrap: {
    display: "flex",
    flexShrink: "0",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space.md,
    borderBottomWidth: "1px",
    paddingLeft: space.xl,
    paddingRight: space.xl,
    paddingTop: "0.625rem",
    paddingBottom: "0.625rem",
    borderColor: "rgb(255 255 255 / 10%)",
  },
  // flex items-center gap-1
  flexCenterGap1: {
    display: "flex",
    alignItems: "center",
    gap: space.xs,
  },
  // min-h-0 flex-1 overflow-y-auto p-3
  fillScrollYShrinkable: {
    minHeight: "0px",
    flex: "1 1 0%",
    overflowY: "auto",
    padding: space.lg,
  },
  // mb-3 flex flex-col gap-1
  flexColGap1: {
    marginBottom: space.lg,
    display: "flex",
    flexDirection: "column",
    gap: space.xs,
  },
  // flex items-center gap-2 border border-border bg-muted/40 px-2.5 py-1.5 backdrop-blur
  flexCenterBordered: {
    display: "flex",
    alignItems: "center",
    gap: space.md,
    borderWidth: "1px",
    borderColor: colors.border,
    backgroundColor: "hsl(var(--muted) / 0.4)",
    paddingLeft: "0.625rem",
    paddingRight: "0.625rem",
    paddingTop: space.sm,
    paddingBottom: space.sm,
    backdropFilter: "blur(8px)",
  },
  // size-3.5 shrink-0 text-muted-foreground
  tightMuted: {
    width: "0.875rem",
    height: "0.875rem",
    flexShrink: "0",
    color: colors.mutedForeground,
  },
  // min-w-0 flex-1 truncate text-micro text-muted-foreground
  fillMicroMuted: {
    minWidth: "0px",
    flex: "1 1 0%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    color: colors.mutedForeground,
  },
  // size-3
  size3: {
    width: "0.75rem",
    height: "0.75rem",
  },
  // min-h-72
  minH72: {
    minHeight: "18rem",
  },
  // flex flex-col items-center gap-2 px-6 py-12 text-center
  flexColCenter: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space.md,
    paddingLeft: space.xxl,
    paddingRight: space.xxl,
    paddingTop: "3rem",
    paddingBottom: "3rem",
    textAlign: "center",
  },
  // font-heavy text-2xl tracking-tight text-foreground/20
  xxlHeavy: {
    fontFamily: text.fontHeavy,
    fontSize: text.size2xl,
    lineHeight: "2rem",
    letterSpacing: "-0.025em",
    color: "hsl(var(--foreground) / 0.2)",
  },
  // text-xs text-muted-foreground
  xsMuted: {
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.mutedForeground,
  },
  // grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4
  gridCols1Gap3: {
    display: "grid",
    gridTemplateColumns: {
      default: "repeat(1, minmax(0, 1fr))",
      "@media (min-width: 640px)": "repeat(2, minmax(0, 1fr))",
      "@media (min-width: 1280px)": "repeat(3, minmax(0, 1fr))",
      "@media (min-width: 1536px)": "repeat(4, minmax(0, 1fr))",
    },
    gap: space.lg,
  },
  // mt-3 text-micro text-muted-foreground
  microMuted: {
    marginTop: space.lg,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    color: colors.mutedForeground,
  },
  /*
   * The backend filter tabs. `focus-visible:outline-none` is Tailwind's
   * transparent outline (kept so a forced-colours mode still shows focus) plus
   * the 2px ring as a shadow; the ring lives in both states because
   * `stylex.props()` resolves a property to a single argument.
   */
  // px-2 py-1 text-micro uppercase tracking-meta text-primary bg-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
  filterTabActive: {
    paddingLeft: space.md,
    paddingRight: space.md,
    paddingTop: space.xs,
    paddingBottom: space.xs,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: colors.primary,
    backgroundColor: "hsl(var(--primary) / 0.15)",
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
  // px-2 py-1 text-micro uppercase tracking-meta text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
  filterTab: {
    paddingLeft: space.md,
    paddingRight: space.md,
    paddingTop: space.xs,
    paddingBottom: space.xs,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: {
      default: colors.mutedForeground,
      ":hover": colors.text,
    },
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
});
