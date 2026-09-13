/**
 * StyleX styles for the map-assets surfaces: the gallery and catalog, the map
 * detail page and its tabs, the add and edit forms, and the detail sections.
 *
 * Every rule is translated one-for-one from the Tailwind its component shipped
 * with, quoted verbatim in the doc comment above it — literal rems where the
 * utility compiled to a literal rem, Tailwind's own transition curve and
 * durations, and the palette resolved through the same `hsl(var(--token))`
 * bridges `styles.css` defines, so the theme still switches at runtime.
 *
 * Radii are absent throughout, deliberately. `tailwind.config.js` resolves the
 * whole `borderRadius` scale to `0` under the sharp-corner mandate, so every
 * `rounded-*` quoted in these comments contributed nothing to render. Writing
 * a radius here would round corners the product keeps square.
 *
 * `dark:` variants are folded into the base rule: `layout.tsx` fixes `dark` on
 * the `<html>` element, so the dark value is the only value that ever renders.
 *
 * `space-y-*` stacks are flex columns with the same `gap`: every child in them
 * is a block-level box with no vertical margin, so the `> * + *` margin and the
 * gap lay out identically.
 *
 * What is left in `bridge` are the utilities StyleX genuinely cannot own,
 * because they are not selectors on the element being styled. Those stay as
 * Tailwind classes, keyed by the rule they belong to.
 */

import * as stylex from "@stylexjs/stylex";

/** `animate-spin`. */
const spin = stylex.keyframes({
  from: { transform: "rotate(0deg)" },
  to: { transform: "rotate(360deg)" },
});

/** `animate-pulse`. */
const pulse = stylex.keyframes({
  "0%, 100%": { opacity: 1 },
  "50%": { opacity: 0.5 },
});

/**
 * `animate-in slide-in-from-right-2`. `tailwindcss-animate`'s `enter` keyframe
 * declares only a `from`, so the rest — opacity 1, unit scale, no rotation —
 * is the element's own computed state and needs no declaration here.
 */
const slideInFromRight2 = stylex.keyframes({
  from: { transform: "translate3d(0.5rem, 0, 0)" },
});

/** `animate-in slide-in-from-bottom-2`. */
const slideInFromBottom2 = stylex.keyframes({
  from: { transform: "translate3d(0, 0.5rem, 0)" },
});

/**
 * State published by a hovered ancestor for its descendants to read.
 *
 * A StyleX rule compiles to an atomic class on the one element it is applied
 * to, so a descendant cannot select an ancestor's `:hover` the way Tailwind's
 * `group-hover:*` does. Where the descendant's resting value is declared here
 * too, the Tailwind variant also loses the cascade outright — StyleX guards
 * every atomic rule with repeated `:not(#\#)`, which outranks the descendant
 * selector. The ancestor therefore publishes the hovered value as a custom
 * property and the descendant reads it; the transition stays on the
 * descendant, so it animates exactly as the `group-hover:*` rule did.
 */
export const hovered = stylex.defineVars({
  /** `MapMediaPanel`'s resize grip dot: `group-hover:bg-muted-foreground/60`. */
  resizeDotColor: "hsl(var(--border))",
  /** `MapCard`'s "Open Map" affordance: `group-hover:opacity-100`. */
  cardActionOpacity: "0",
  /** `VideosSection`'s preview scrim: `group-hover:bg-black/10`. */
  videoScrimColor: "rgba(0, 0, 0, 0)",
  /** `VideosSection`'s artifact label: `group-hover:text-foreground`. */
  videoLabelColor: "hsl(var(--muted-foreground))",
  /** `MapDetailRightPanel`'s collapse icon: `group-hover/rail:opacity-100`. */
  railIconOpacity: "0",
});

export const styles = stylex.create({
  /**
   * mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground
   */
  s_0: {
    marginBottom: "0.5rem",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.025em",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * animate-in slide-in-from-right-2 duration-200 ease-out absolute right-0 top-0 z-20 flex
   * h-full w-80 flex-col border-l border-border bg-background shadow-xl
   */
  s_1: {
    animationName: slideInFromRight2,
    animationDuration: "200ms",
    animationTimingFunction: "cubic-bezier(0, 0, 0.2, 1)",
    position: "absolute",
    right: "0",
    top: "0",
    zIndex: 20,
    display: "flex",
    height: "100%",
    width: "20rem",
    flexDirection: "column",
    borderLeftWidth: "1px",
    borderLeftStyle: "solid",
    borderColor: "hsl(var(--border))",
    backgroundColor: "hsl(var(--background))",
    boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1)",
  },
  /**
   * flex shrink-0 items-center gap-2 border-b border-border px-3 py-2.5
   */
  s_2: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: "0.5rem",
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderColor: "hsl(var(--border))",
    paddingInline: "0.75rem",
    paddingBlock: "0.625rem",
  },
  /**
   * truncate text-sm font-semibold leading-snug
   */
  s_7: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "0.875rem",
    lineHeight: 1.375,
    fontWeight: 600,
  },
  /**
   * flex-1 space-y-5 overflow-y-auto p-3
   */
  s_8: {
    display: "flex",
    flexDirection: "column",
    gap: "1.25rem",
    flex: "1 1 0%",
    overflowY: "auto",
    padding: "0.75rem",
  },
  /**
   * text-[11px] italic text-muted-foreground
   */
  s_22: {
    fontSize: "11px",
    fontStyle: "italic",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * rounded-md border border-border p-2
   */
  s_23: {
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "hsl(var(--border))",
    padding: "0.5rem",
  },
  /**
   * mb-1 flex items-center justify-between
   */
  s_24: {
    marginBottom: "0.25rem",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  /**
   * text-[11px] font-medium text-muted-foreground
   */
  s_25: {
    fontSize: "11px",
    fontWeight: 500,
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * text-[11px] text-muted-foreground hover:text-destructive
   */
  s_26: {
    fontSize: "11px",
    color: { default: "hsl(var(--muted-foreground))", ":hover": "hsl(var(--destructive))" },
  },
  /**
   * text-[11px] font-medium text-primary hover:underline
   */
  s_32: {
    fontSize: "11px",
    fontWeight: 500,
    color: "hsl(var(--primary))",
    textDecorationLine: { default: null, ":hover": "underline" },
  },
  /**
   * mb-0.5 block text-[11px] text-muted-foreground
   */
  s_37: {
    marginBottom: "0.125rem",
    display: "block",
    fontSize: "11px",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * h-7 font-mono text-xs
   */
  s_38: {
    height: "1.75rem",
    fontFamily: "var(--font-mono), ui-monospace, monospace",
    fontSize: "0.75rem",
    lineHeight: "1rem",
  },
  /**
   * ml-1.5 rounded-full bg-yellow-950/60 px-1.5 py-px text-[10px] font-semibold
   * text-yellow-300
   */
  s_39: {
    marginLeft: "0.375rem",
    backgroundColor: "rgba(66, 32, 6, 0.6)",
    paddingInline: "0.375rem",
    paddingBlock: "1px",
    fontSize: "10px",
    fontWeight: 600,
    color: "#fde047",
  },
  /**
   * mb-2 flex flex-wrap gap-1
   */
  s_40: {
    marginBottom: "0.5rem",
    display: "flex",
    flexWrap: "wrap",
    gap: "0.25rem",
  },
  /**
   * inline-flex items-center gap-1 rounded border border-yellow-500/40 bg-yellow-500/10
   * px-1.5 py-0.5 font-mono text-xs text-yellow-400
   */
  s_41: {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.25rem",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "rgba(234, 179, 8, 0.4)",
    backgroundColor: "rgba(234, 179, 8, 0.1)",
    paddingInline: "0.375rem",
    paddingBlock: "0.125rem",
    fontFamily: "var(--font-mono), ui-monospace, monospace",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    color: "#facc15",
  },
  /**
   * text-yellow-400/60 transition-colors hover:text-yellow-400
   */
  s_42: {
    color: { default: "rgba(250, 204, 21, 0.6)", ":hover": "#facc15" },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
  },
  /**
   * relative mb-2
   */
  s_44: {
    position: "relative",
    marginBottom: "0.5rem",
  },
  /**
   * absolute left-0 top-8 z-20 w-72 rounded-md border border-border bg-background shadow-lg
   */
  s_46: {
    position: "absolute",
    left: "0",
    top: "2rem",
    zIndex: 20,
    width: "18rem",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "hsl(var(--border))",
    backgroundColor: "hsl(var(--background))",
    boxShadow: "0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -4px rgba(0, 0, 0, 0.1)",
  },
  /**
   * flex items-center gap-1.5 rounded border border-border px-2 py-1
   */
  s_79: {
    display: "flex",
    alignItems: "center",
    gap: "0.375rem",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "hsl(var(--border))",
    paddingInline: "0.5rem",
    paddingBlock: "0.25rem",
  },
  /**
   * min-w-0 flex-1 truncate text-xs text-muted-foreground
   */
  s_81: {
    minWidth: 0,
    flex: "1 1 0%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * shrink-0 text-muted-foreground/60 transition-colors hover:text-destructive
   */
  s_83: {
    flexShrink: 0,
    color: { default: "hsl(var(--muted-foreground) / 0.6)", ":hover": "hsl(var(--destructive))" },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
  },
  /**
   * flex items-center gap-1.5 rounded border border-border px-2 py-1.5
   */
  s_89: {
    display: "flex",
    alignItems: "center",
    gap: "0.375rem",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "hsl(var(--border))",
    paddingInline: "0.5rem",
    paddingBlock: "0.375rem",
  },
  /**
   * min-w-0 flex-1 truncate text-xs
   */
  s_91: {
    minWidth: 0,
    flex: "1 1 0%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "0.75rem",
    lineHeight: "1rem",
  },
  /**
   * h-6 w-20 shrink-0 px-1.5 text-xs
   */
  s_92: {
    height: "1.5rem",
    width: "5rem",
    flexShrink: 0,
    paddingInline: "0.375rem",
    fontSize: "0.75rem",
    lineHeight: "1rem",
  },
  /**
   * mb-2 flex items-center gap-2 rounded border border-emerald-500/30 bg-emerald-500/5 px-2
   * py-1.5
   */
  s_95: {
    marginBottom: "0.5rem",
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "rgba(16, 185, 129, 0.3)",
    backgroundColor: "rgba(16, 185, 129, 0.05)",
    paddingInline: "0.5rem",
    paddingBlock: "0.375rem",
  },
  /**
   * size-3.5 shrink-0 text-emerald-500
   */
  s_96: {
    width: "0.875rem",
    height: "0.875rem",
    flexShrink: 0,
    color: "#10b981",
  },
  /**
   * flex-1 text-xs text-emerald-400
   */
  s_97: {
    flex: "1 1 0%",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    color: "#34d399",
  },
  /**
   * shrink-0 text-xs text-muted-foreground/60 transition-colors hover:text-destructive
   */
  s_98: {
    flexShrink: 0,
    fontSize: "0.75rem",
    lineHeight: "1rem",
    color: { default: "hsl(var(--muted-foreground) / 0.6)", ":hover": "hsl(var(--destructive))" },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
  },
  /**
   * mb-2 flex items-center gap-2 rounded border border-amber-500/30 bg-amber-500/5 px-2
   * py-1.5
   */
  s_100: {
    marginBottom: "0.5rem",
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "rgba(245, 158, 11, 0.3)",
    backgroundColor: "rgba(245, 158, 11, 0.05)",
    paddingInline: "0.5rem",
    paddingBlock: "0.375rem",
  },
  /**
   * size-3.5 shrink-0 text-amber-500
   */
  s_101: {
    width: "0.875rem",
    height: "0.875rem",
    flexShrink: 0,
    color: "#f59e0b",
  },
  /**
   * flex-1 text-xs text-amber-400
   */
  s_102: {
    flex: "1 1 0%",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    color: "#fbbf24",
  },
  /**
   * mb-2 flex items-center gap-2 rounded border border-border px-2 py-1.5
   */
  s_105: {
    marginBottom: "0.5rem",
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "hsl(var(--border))",
    paddingInline: "0.5rem",
    paddingBlock: "0.375rem",
  },
  /**
   * flex-1 text-xs text-muted-foreground
   */
  s_107: {
    flex: "1 1 0%",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * font-mono text-foreground
   */
  s_109: {
    fontFamily: "var(--font-mono), ui-monospace, monospace",
    color: "hsl(var(--foreground))",
  },
  /**
   * shrink-0 text-muted-foreground/60 transition-colors hover:text-foreground
   */
  s_110: {
    flexShrink: 0,
    color: { default: "hsl(var(--muted-foreground) / 0.6)", ":hover": "hsl(var(--foreground))" },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
  },
  /**
   * h-1.5 w-full overflow-hidden rounded-full bg-muted
   */
  s_113: {
    height: "0.375rem",
    width: "100%",
    overflow: "hidden",
    backgroundColor: "hsl(var(--muted))",
  },
  /**
   * h-full rounded-full bg-primary transition-all duration-200
   */
  s_114: {
    height: "100%",
    backgroundColor: "hsl(var(--primary))",
    transitionProperty: "all",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "200ms",
  },
  /**
   * mb-2 text-[11px] text-muted-foreground
   */
  s_117: {
    marginBottom: "0.5rem",
    fontSize: "11px",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * mr-1.5 size-3
   */
  s_121: {
    marginRight: "0.375rem",
    width: "0.75rem",
    height: "0.75rem",
  },
  /**
   * shrink-0 space-y-2 border-t border-border p-3
   */
  s_122: {
    display: "flex",
    flexDirection: "column",
    gap: "0.5rem",
    flexShrink: 0,
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderColor: "hsl(var(--border))",
    padding: "0.75rem",
  },
  /**
   * flex gap-2
   */
  s_124: {
    display: "flex",
    gap: "0.5rem",
  },
  /**
   * animate-in slide-in-from-bottom-2 duration-200 ease-out absolute bottom-3 right-3 z-30
   * flex flex-col overflow-hidden rounded-lg border border-border bg-background shadow-xl
   */
  s_127: {
    animationName: slideInFromBottom2,
    animationDuration: "200ms",
    animationTimingFunction: "cubic-bezier(0, 0, 0.2, 1)",
    position: "absolute",
    bottom: "0.75rem",
    right: "0.75rem",
    zIndex: 30,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "hsl(var(--border))",
    backgroundColor: "hsl(var(--background))",
    boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1)",
  },
  /**
   * group absolute left-0 top-0 z-10 flex size-4 cursor-nwse-resize items-center
   * justify-center
   *
   * The `group` marker is gone: its one descendant now reads `hovered`.
   */
  s_128: {
    position: "absolute",
    left: "0",
    top: "0",
    zIndex: 10,
    display: "flex",
    width: "1rem",
    height: "1rem",
    cursor: "nwse-resize",
    alignItems: "center",
    justifyContent: "center",
    [hovered.resizeDotColor]: "hsl(var(--border))",
    ":hover": {
      [hovered.resizeDotColor]: "hsl(var(--muted-foreground) / 0.6)",
    },
  },
  /**
   * size-1.5 rounded-full bg-border transition-colors group-hover:bg-muted-foreground/60
   */
  s_129: {
    width: "0.375rem",
    height: "0.375rem",
    backgroundColor: hovered.resizeDotColor,
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
  },
  /**
   * flex h-8 shrink-0 items-center justify-between border-b border-border pl-5 pr-2
   */
  s_130: {
    display: "flex",
    height: "2rem",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderColor: "hsl(var(--border))",
    paddingLeft: "1.25rem",
    paddingRight: "0.5rem",
  },
  /**
   * truncate text-xs font-medium
   */
  s_131: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    fontWeight: 500,
  },
  /**
   * h-6 w-6 shrink-0
   */
  s_132: {
    height: "1.5rem",
    width: "1.5rem",
    flexShrink: 0,
  },
  /**
   * bg-black
   */
  s_134: {
    backgroundColor: "#000",
  },
  /**
   * h-full w-full object-contain
   */
  s_135: {
    height: "100%",
    width: "100%",
    objectFit: "contain",
  },
  /**
   * p-6
   */
  s_136: {
    padding: "1.5rem",
  },
  /**
   * text-lg font-semibold mb-2
   */
  s_137: {
    fontSize: "1.125rem",
    lineHeight: "1.75rem",
    fontWeight: 600,
    marginBottom: "0.5rem",
  },
  /**
   * text-sm text-muted-foreground mb-4
   */
  s_138: {
    fontSize: "0.875rem",
    lineHeight: "1.25rem",
    color: "hsl(var(--muted-foreground))",
    marginBottom: "1rem",
  },
  /**
   * text-sm px-4 py-2 rounded-md bg-primary text-primary-foreground hover:bg-primary/90
   */
  s_139: {
    fontSize: "0.875rem",
    lineHeight: "1.25rem",
    paddingInline: "1rem",
    paddingBlock: "0.5rem",
    backgroundColor: { default: "hsl(var(--primary))", ":hover": "hsl(var(--primary) / 0.9)" },
    color: "hsl(var(--primary-foreground))",
  },
  /**
   * rounded-md border border-destructive/40 bg-destructive/5 p-3
   */
  s_140: {
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "hsl(var(--destructive) / 0.4)",
    backgroundColor: "hsl(var(--destructive) / 0.05)",
    padding: "0.75rem",
  },
  /**
   * flex w-full items-center gap-2 text-left
   */
  s_141: {
    display: "flex",
    width: "100%",
    alignItems: "center",
    gap: "0.5rem",
    textAlign: "left",
  },
  /**
   * mt-0.5 size-4 shrink-0 text-destructive
   */
  s_142: {
    marginTop: "0.125rem",
    width: "1rem",
    height: "1rem",
    flexShrink: 0,
    color: "hsl(var(--destructive))",
  },
  /**
   * flex-1 text-xs font-semibold uppercase tracking-wide text-destructive
   */
  s_143: {
    flex: "1 1 0%",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.025em",
    color: "hsl(var(--destructive))",
  },
  /**
   * mb-2 text-[11px] leading-relaxed text-muted-foreground
   */
  s_145: {
    marginBottom: "0.5rem",
    fontSize: "11px",
    lineHeight: 1.625,
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * mb-1.5 text-[11px] text-muted-foreground
   */
  s_147: {
    marginBottom: "0.375rem",
    fontSize: "11px",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * mb-2 break-all rounded border border-border bg-muted/40 px-2 py-1 font-mono text-[10px]
   * text-foreground
   */
  s_148: {
    marginBottom: "0.5rem",
    wordBreak: "break-all",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "hsl(var(--border))",
    backgroundColor: "hsl(var(--muted) / 0.4)",
    paddingInline: "0.5rem",
    paddingBlock: "0.25rem",
    fontFamily: "var(--font-mono), ui-monospace, monospace",
    fontSize: "10px",
    color: "hsl(var(--foreground))",
  },
  /**
   * mb-2 h-8 font-mono text-xs
   */
  s_150: {
    marginBottom: "0.5rem",
    height: "2rem",
    fontFamily: "var(--font-mono), ui-monospace, monospace",
    fontSize: "0.75rem",
    lineHeight: "1rem",
  },
  /**
   * mb-2 text-[11px] text-destructive
   */
  s_151: {
    marginBottom: "0.5rem",
    fontSize: "11px",
    color: "hsl(var(--destructive))",
  },
  /**
   * relative flex-1 max-w-md
   */
  s_153: {
    position: "relative",
    flex: "1 1 0%",
    maxWidth: "28rem",
  },
  /**
   * pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground
   */
  s_154: {
    pointerEvents: "none",
    position: "absolute",
    left: "0.75rem",
    top: "50%",
    width: "1rem",
    height: "1rem",
    transform: "translateY(-50%)",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * h-9 pl-9 text-sm
   */
  s_155: {
    height: "2.25rem",
    paddingLeft: "2.25rem",
    fontSize: "0.875rem",
    lineHeight: "1.25rem",
  },
  /**
   * absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground
   */
  s_156: {
    position: "absolute",
    right: "0.75rem",
    top: "50%",
    transform: "translateY(-50%)",
    color: { default: "hsl(var(--muted-foreground))", ":hover": "hsl(var(--foreground))" },
  },
  /**
   * text-xs text-muted-foreground shrink-0
   */
  s_158: {
    fontSize: "0.75rem",
    lineHeight: "1rem",
    color: "hsl(var(--muted-foreground))",
    flexShrink: 0,
  },
  /**
   * ml-auto
   */
  s_159: {
    marginLeft: "auto",
  },
  /**
   * h-9 gap-1.5 text-xs
   */
  s_160: {
    height: "2.25rem",
    gap: "0.375rem",
    fontSize: "0.75rem",
    lineHeight: "1rem",
  },
  /**
   * flex items-center rounded-md border border-border bg-muted/30 p-0.5
   */
  s_162: {
    display: "flex",
    alignItems: "center",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "hsl(var(--border))",
    backgroundColor: "hsl(var(--muted) / 0.3)",
    padding: "0.125rem",
  },
  /**
   * flex items-center gap-1.5
   */
  s_167: {
    display: "flex",
    alignItems: "center",
    gap: "0.375rem",
  },
  /**
   * flex h-full min-h-0
   */
  s_168: {
    display: "flex",
    height: "100%",
    minHeight: 0,
  },
  /**
   * w-80 shrink-0 border-r border-border overflow-y-auto
   */
  s_169: {
    width: "20rem",
    flexShrink: 0,
    borderRightWidth: "1px",
    borderRightStyle: "solid",
    borderColor: "hsl(var(--border))",
    overflowY: "auto",
  },
  /**
   * px-4 py-8 text-xs text-muted-foreground text-center
   */
  s_170: {
    paddingInline: "1rem",
    paddingBlock: "2rem",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    color: "hsl(var(--muted-foreground))",
    textAlign: "center",
  },
  /**
   * text-sm font-medium truncate
   */
  s_171: {
    fontSize: "0.875rem",
    lineHeight: "1.25rem",
    fontWeight: 500,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  /**
   * text-xs text-muted-foreground truncate mt-0.5
   */
  s_172: {
    fontSize: "0.75rem",
    lineHeight: "1rem",
    color: "hsl(var(--muted-foreground))",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    marginTop: "0.125rem",
  },
  /**
   * mt-1.5
   */
  s_174: {
    marginTop: "0.375rem",
  },
  /**
   * flex flex-wrap gap-1 mt-1.5
   */
  s_175: {
    display: "flex",
    flexWrap: "wrap",
    gap: "0.25rem",
    marginTop: "0.375rem",
  },
  /**
   * inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-[9px] font-medium
   * text-primary border border-primary/20
   */
  s_176: {
    display: "inline-flex",
    alignItems: "center",
    backgroundColor: "hsl(var(--primary) / 0.1)",
    paddingInline: "0.5rem",
    paddingBlock: "0.125rem",
    fontSize: "9px",
    fontWeight: 500,
    color: "hsl(var(--primary))",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "hsl(var(--primary) / 0.2)",
  },
  /**
   * inline-flex items-center rounded-full bg-muted/50 px-2 py-0.5 text-[9px]
   * text-muted-foreground
   */
  s_177: {
    display: "inline-flex",
    alignItems: "center",
    backgroundColor: "hsl(var(--muted) / 0.5)",
    paddingInline: "0.5rem",
    paddingBlock: "0.125rem",
    fontSize: "9px",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * size-6 animate-pulse rounded-full bg-muted/50
   */
  s_181: {
    width: "1.5rem",
    height: "1.5rem",
    animationName: pulse,
    animationDuration: "2s",
    animationTimingFunction: "cubic-bezier(0.4, 0, 0.6, 1)",
    animationIterationCount: "infinite",
    backgroundColor: "hsl(var(--muted) / 0.5)",
  },
  /**
   * object-cover transition-transform duration-300 group-hover:scale-105
   */
  s_182: {
    objectFit: "cover",
    transitionProperty: "transform",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "300ms",
  },
  /**
   * h-full w-full object-cover transition-transform duration-300 group-hover:scale-105
   */
  s_183: {
    height: "100%",
    width: "100%",
    objectFit: "cover",
    transitionProperty: "transform",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "300ms",
  },
  /**
   * group flex flex-col overflow-hidden rounded-lg border border-border bg-card
   * transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-black/20
   * hover:border-border/80
   */
  s_184: {
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: { default: "hsl(var(--border))", ":hover": "hsl(var(--border) / 0.8)" },
    backgroundColor: "hsl(var(--card))",
    transitionProperty: "all",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "200ms",
    transform: { default: null, ":hover": "translateY(-0.125rem)" },
    boxShadow: { default: null, ":hover": "0 10px 15px -3px rgba(0, 0, 0, 0.2), 0 4px 6px -4px rgba(0, 0, 0, 0.2)" },
    [hovered.cardActionOpacity]: "0",
    ":hover": {
      [hovered.cardActionOpacity]: "1",
    },
  },
  /**
   * relative aspect-video w-full overflow-hidden bg-muted/30
   */
  s_185: {
    position: "relative",
    aspectRatio: "16 / 9",
    width: "100%",
    overflow: "hidden",
    backgroundColor: "hsl(var(--muted) / 0.3)",
  },
  /**
   * flex h-full w-full items-center justify-center text-muted-foreground/30
   */
  s_186: {
    display: "flex",
    height: "100%",
    width: "100%",
    alignItems: "center",
    justifyContent: "center",
    color: "hsl(var(--muted-foreground) / 0.3)",
  },
  /**
   * flex flex-1 flex-col gap-2.5 p-3.5
   */
  s_187: {
    display: "flex",
    flex: "1 1 0%",
    flexDirection: "column",
    gap: "0.625rem",
    padding: "0.875rem",
  },
  /**
   * text-sm font-semibold leading-snug truncate group-hover:text-primary transition-colors
   */
  s_188: {
    fontSize: "0.875rem",
    lineHeight: 1.375,
    fontWeight: 600,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
  },
  /**
   * mt-0.5 text-xs text-muted-foreground truncate
   */
  s_189: {
    marginTop: "0.125rem",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    color: "hsl(var(--muted-foreground))",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  /**
   * inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium
   * text-primary border border-primary/20
   */
  s_191: {
    display: "inline-flex",
    alignItems: "center",
    backgroundColor: "hsl(var(--primary) / 0.1)",
    paddingInline: "0.5rem",
    paddingBlock: "0.125rem",
    fontSize: "10px",
    fontWeight: 500,
    color: "hsl(var(--primary))",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "hsl(var(--primary) / 0.2)",
  },
  /**
   * mt-auto pt-1
   */
  s_193: {
    marginTop: "auto",
    paddingTop: "0.25rem",
  },
  /**
   * inline-flex items-center gap-1 text-xs font-medium text-primary opacity-0
   * transition-opacity group-hover:opacity-100
   */
  s_194: {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.25rem",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    fontWeight: 500,
    color: "hsl(var(--primary))",
    opacity: hovered.cardActionOpacity,
    transitionProperty: "opacity",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
  },
  /**
   * grid grid-cols-1 gap-4 p-4 md:grid-cols-2 xl:grid-cols-3
   */
  s_196: {
    display: "grid",
    gridTemplateColumns: { default: "repeat(1, minmax(0, 1fr))", "@media (min-width: 768px)": "repeat(2, minmax(0, 1fr))", "@media (min-width: 1280px)": "repeat(3, minmax(0, 1fr))" },
    gap: "1rem",
    padding: "1rem",
  },
  /**
   * fixed inset-0 z-40 bg-black/65 backdrop-blur-sm data-[state=closed]:animate-out
   * data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0
   */
  s_197: {
    position: "fixed",
    inset: "0",
    zIndex: 40,
    backgroundColor: "rgba(0, 0, 0, 0.65)",
    backdropFilter: "blur(4px)",
  },
  /**
   * fixed inset-x-3 bottom-3 top-[4.25rem] z-50 overflow-hidden border border-white/15
   * bg-background shadow-2xl outline-none data-[state=closed]:animate-out
   * data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95
   * data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95
   * sm:inset-x-5 sm:bottom-5 lg:inset-x-8 lg:bottom-8
   */
  s_198: {
    position: "fixed",
    left: { default: "0.75rem", "@media (min-width: 640px)": "1.25rem", "@media (min-width: 1024px)": "2rem" },
    right: { default: "0.75rem", "@media (min-width: 640px)": "1.25rem", "@media (min-width: 1024px)": "2rem" },
    bottom: { default: "0.75rem", "@media (min-width: 640px)": "1.25rem", "@media (min-width: 1024px)": "2rem" },
    top: "4.25rem",
    zIndex: 50,
    overflow: "hidden",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "rgba(255, 255, 255, 0.15)",
    backgroundColor: "hsl(var(--background))",
    boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.25)",
    /*
     * `outline-none` is Tailwind's transparent 2px outline, not `outline:
     * none`: it suppresses the UA ring without erasing the control's outline
     * in forced-colours mode, where the transparent outline is repainted as a
     * visible one.
     */
    outlineWidth: "2px",
    outlineStyle: "solid",
    outlineColor: "transparent",
    outlineOffset: "2px",
  },
  /**
   * flex-1 min-h-0 overflow-hidden
   */
  s_206: {
    flex: "1 1 0%",
    minHeight: 0,
    overflow: "hidden",
  },
  /**
   * h-full overflow-y-auto
   */
  s_207: {
    height: "100%",
    overflowY: "auto",
  },
  /**
   * flex flex-col items-center justify-center py-16 text-center
   */
  s_208: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    paddingBlock: "4rem",
    textAlign: "center",
  },
  /**
   * text-sm text-muted-foreground
   */
  s_209: {
    fontSize: "0.875rem",
    lineHeight: "1.25rem",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * mt-2 text-xs text-primary hover:text-primary/80
   */
  s_210: {
    marginTop: "0.5rem",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    color: { default: "hsl(var(--primary))", ":hover": "hsl(var(--primary) / 0.8)" },
  },
  /**
   * fixed inset-0 z-40 grid place-items-center bg-black/65 backdrop-blur-sm
   */
  s_211: {
    position: "fixed",
    inset: "0",
    zIndex: 40,
    display: "grid",
    placeItems: "center",
    backgroundColor: "rgba(0, 0, 0, 0.65)",
    backdropFilter: "blur(4px)",
  },
  /**
   * flex items-center gap-2 bg-black/75 px-4 py-3 text-sm text-white
   */
  s_212: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    backgroundColor: "rgba(0, 0, 0, 0.75)",
    paddingInline: "1rem",
    paddingBlock: "0.75rem",
    fontSize: "0.875rem",
    lineHeight: "1.25rem",
    color: "#fff",
  },
  /**
   * size-4 animate-spin text-[#E8E044]
   */
  s_213: {
    width: "1rem",
    height: "1rem",
    animationName: spin,
    animationDuration: "1s",
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
    color: "#E8E044",
  },
  /**
   * absolute inset-0 isolate
   */
  s_214: {
    position: "absolute",
    inset: "0",
    isolation: "isolate",
  },
  /**
   * grid size-10 place-items-center border border-white/20 bg-black/25 text-white/85
   * backdrop-blur-md transition-colors hover:border-white/45 hover:bg-white/10
   * hover:text-white focus-visible:outline-none focus-visible:ring-2
   * focus-visible:ring-[#E8E044] disabled:pointer-events-none disabled:opacity-30
   */
  s_216: {
    display: "grid",
    width: "2.5rem",
    height: "2.5rem",
    placeItems: "center",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: { default: "rgba(255, 255, 255, 0.2)", ":hover": "rgba(255, 255, 255, 0.45)" },
    backgroundColor: { default: "rgba(0, 0, 0, 0.25)", ":hover": "rgba(255, 255, 255, 0.1)" },
    color: { default: "rgba(255, 255, 255, 0.85)", ":hover": "#fff" },
    backdropFilter: "blur(12px)",
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
    /*
     * `focus-visible:outline-none` is Tailwind's transparent 2px outline, not
     * `outline: none`: the focus ring above is a box-shadow, which
     * forced-colours mode discards, and this transparent outline is what
     * remains visible there.
     */
    outlineWidth: { default: null, ":focus-visible": "2px" },
    outlineStyle: { default: null, ":focus-visible": "solid" },
    outlineColor: { default: null, ":focus-visible": "transparent" },
    outlineOffset: { default: null, ":focus-visible": "2px" },
    pointerEvents: { default: null, ":disabled": "none" },
    opacity: { default: null, ":disabled": 0.3 },
    boxShadow: { default: null, ":focus-visible": "0 0 0 2px #E8E044" },
  },
  /**
   * mr-1.5 size-4
   */
  s_219: {
    marginRight: "0.375rem",
    width: "1rem",
    height: "1rem",
  },
  /**
   * h-full
   */
  s_220: {
    height: "100%",
  },
  /**
   * relative h-full min-h-[32rem] overflow-hidden bg-[#07100d] text-white
   */
  s_221: {
    position: "relative",
    height: "100%",
    minHeight: "32rem",
    overflow: "hidden",
    backgroundColor: "#07100d",
    color: "#fff",
  },
  /**
   * absolute inset-0
   * bg-[radial-gradient(ellipse_at_center,rgba(232,224,68,0.08),transparent_60%)]
   */
  s_223: {
    position: "absolute",
    inset: "0",
    backgroundImage: "radial-gradient(ellipse at center,rgba(232,224,68,0.08),transparent 60%)",
  },
  /**
   * pointer-events-none absolute inset-x-0 bottom-0 z-10 h-1/2 bg-gradient-to-t from-black/45
   * via-black/10 to-transparent
   */
  s_224: {
    pointerEvents: "none",
    position: "absolute",
    left: "0",
    right: "0",
    bottom: "0",
    zIndex: 10,
    height: "50%",
    backgroundImage: "linear-gradient(to top, rgba(0, 0, 0, 0.45), rgba(0, 0, 0, 0.1), transparent)",
  },
  /**
   * pointer-events-none absolute inset-x-0 top-0 z-10 h-24 bg-gradient-to-b from-black/25
   * to-transparent
   */
  s_225: {
    pointerEvents: "none",
    position: "absolute",
    left: "0",
    right: "0",
    top: "0",
    zIndex: 10,
    height: "6rem",
    backgroundImage: "linear-gradient(to bottom, rgba(0, 0, 0, 0.25), transparent)",
  },
  /**
   * absolute right-5 top-5 z-30 flex items-center gap-2 sm:right-8 sm:top-8
   */
  s_226: {
    position: "absolute",
    right: { default: "1.25rem", "@media (min-width: 640px)": "2rem" },
    top: { default: "1.25rem", "@media (min-width: 640px)": "2rem" },
    zIndex: 30,
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
  },
  /**
   * font-mono text-[9px] text-current/65
   */
  s_230: {
    fontFamily: "var(--font-mono), ui-monospace, monospace",
    fontSize: "9px",
    color: "color-mix(in srgb, currentColor 65%, transparent)",
  },
  /**
   * inline-flex h-10 items-center gap-2 border border-white/20 bg-black/45 px-3.5 text-xs
   * font-semibold text-white backdrop-blur-md transition-colors hover:border-[#E8E044]/70
   * hover:bg-black/65 focus-visible:outline-none focus-visible:ring-2
   * focus-visible:ring-[#E8E044] disabled:cursor-not-allowed disabled:opacity-40
   */
  s_231: {
    display: "inline-flex",
    height: "2.5rem",
    alignItems: "center",
    gap: "0.5rem",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: { default: "rgba(255, 255, 255, 0.2)", ":hover": "rgba(232, 224, 68, 0.7)" },
    backgroundColor: { default: "rgba(0, 0, 0, 0.45)", ":hover": "rgba(0, 0, 0, 0.65)" },
    paddingInline: "0.875rem",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    fontWeight: 600,
    color: "#fff",
    backdropFilter: "blur(12px)",
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
    /*
     * `focus-visible:outline-none` is Tailwind's transparent 2px outline, not
     * `outline: none`: the focus ring above is a box-shadow, which
     * forced-colours mode discards, and this transparent outline is what
     * remains visible there.
     */
    outlineWidth: { default: null, ":focus-visible": "2px" },
    outlineStyle: { default: null, ":focus-visible": "solid" },
    outlineColor: { default: null, ":focus-visible": "transparent" },
    outlineOffset: { default: null, ":focus-visible": "2px" },
    cursor: { default: null, ":disabled": "not-allowed" },
    opacity: { default: null, ":disabled": 0.4 },
    boxShadow: { default: null, ":focus-visible": "0 0 0 2px #E8E044" },
  },
  /**
   * size-4 text-[#E8E044]
   */
  s_232: {
    width: "1rem",
    height: "1rem",
    color: "#E8E044",
  },
  /**
   * pointer-events-none absolute bottom-0 left-0 z-10 h-[88%] w-[92%]
   * bg-[radial-gradient(ellipse_at_bottom_left,rgba(2,8,6,0.76)_0%,rgba(2,8,6,0.58)_30%,rgba(2,8,6,0.2)_55%,transparent_76%)]
   * backdrop-blur-[14px] sm:w-[78%] lg:w-[68%]
   */
  s_233: {
    pointerEvents: "none",
    position: "absolute",
    bottom: "0",
    left: "0",
    zIndex: 10,
    height: "88%",
    width: { default: "92%", "@media (min-width: 640px)": "78%", "@media (min-width: 1024px)": "68%" },
    backgroundImage: "radial-gradient(ellipse at bottom left,rgba(2,8,6,0.76) 0%,rgba(2,8,6,0.58) 30%,rgba(2,8,6,0.2) 55%,transparent 76%)",
    backdropFilter: "blur(14px)",
  },
  /**
   * absolute inset-x-0 bottom-0 z-20
   */
  s_234: {
    position: "absolute",
    left: "0",
    right: "0",
    bottom: "0",
    zIndex: 20,
  },
  /**
   * mx-auto w-full max-w-[1440px] px-5 pb-5 sm:px-8 sm:pb-8 lg:px-14 lg:pb-10
   */
  s_235: {
    marginInline: "auto",
    width: "100%",
    maxWidth: "1440px",
    paddingInline: { default: "1.25rem", "@media (min-width: 640px)": "2rem", "@media (min-width: 1024px)": "3.5rem" },
    paddingBottom: { default: "1.25rem", "@media (min-width: 640px)": "2rem", "@media (min-width: 1024px)": "2.5rem" },
  },
  /**
   * max-w-2xl
   */
  s_236: {
    maxWidth: "42rem",
  },
  /**
   * flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.24em]
   * text-[#E8E044] sm:text-[11px]
   */
  s_237: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    fontSize: { default: "10px", "@media (min-width: 640px)": "11px" },
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.24em",
    color: "#E8E044",
  },
  /**
   * mt-3 max-w-3xl text-balance text-[clamp(2.25rem,4.2vw,4.5rem)] font-semibold
   * leading-[0.96] tracking-[-0.045em] text-white
   */
  s_239: {
    marginTop: "0.75rem",
    maxWidth: "48rem",
    textWrap: "balance",
    fontSize: "clamp(2.25rem,4.2vw,4.5rem)",
    fontWeight: 600,
    lineHeight: "0.96",
    letterSpacing: "-0.045em",
    color: "#fff",
  },
  /**
   * mt-3 flex items-center gap-1.5 text-sm text-white/[0.72] sm:text-base
   */
  s_240: {
    marginTop: "0.75rem",
    display: "flex",
    alignItems: "center",
    gap: "0.375rem",
    fontSize: { default: "0.875rem", "@media (min-width: 640px)": "1rem" },
    lineHeight: { default: "1.25rem", "@media (min-width: 640px)": "1.5rem" },
    color: "rgba(255, 255, 255, 0.72)",
  },
  /**
   * size-3.5 text-[#E8E044]
   */
  s_241: {
    width: "0.875rem",
    height: "0.875rem",
    color: "#E8E044",
  },
  /**
   * mt-2 line-clamp-2 max-w-xl text-sm leading-6 text-white/[0.62]
   */
  s_242: {
    marginTop: "0.5rem",
    overflow: "hidden",
    display: "-webkit-box",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: 2,
    maxWidth: "36rem",
    fontSize: "0.875rem",
    lineHeight: "1.5rem",
    color: "rgba(255, 255, 255, 0.62)",
  },
  /**
   * mt-3 flex min-h-5 flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-white/50
   * sm:text-xs
   */
  s_243: {
    marginTop: "0.75rem",
    display: "flex",
    minHeight: "1.25rem",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: "1rem",
    rowGap: "0.25rem",
    fontSize: { default: "11px", "@media (min-width: 640px)": "0.75rem" },
    color: "rgba(255, 255, 255, 0.5)",
    lineHeight: { default: null, "@media (min-width: 640px)": "1rem" },
  },
  /**
   * pointer-events-auto inline-flex items-center gap-1 text-white/[0.58] transition-colors
   * hover:text-white
   */
  s_245: {
    pointerEvents: "auto",
    display: "inline-flex",
    alignItems: "center",
    gap: "0.25rem",
    color: { default: "rgba(255, 255, 255, 0.58)", ":hover": "#fff" },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
  },
  /**
   * mt-4
   */
  s_247: {
    marginTop: "1rem",
  },
  /**
   * mt-5 flex items-center justify-between gap-4 border-t border-white/20 pt-4 sm:mt-7
   * sm:pt-5
   */
  s_248: {
    marginTop: { default: "1.25rem", "@media (min-width: 640px)": "1.75rem" },
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "1rem",
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderColor: "rgba(255, 255, 255, 0.2)",
    paddingTop: { default: "1rem", "@media (min-width: 640px)": "1.25rem" },
  },
  /**
   * grid size-10 place-items-center border border-white/20 bg-black/25 text-white/85
   * backdrop-blur-md transition-colors hover:border-[#E8E044]/70 hover:bg-[#E8E044]/10
   * hover:text-[#E8E044] focus-visible:outline-none focus-visible:ring-2
   * focus-visible:ring-[#E8E044]
   */
  s_250: {
    display: "grid",
    width: "2.5rem",
    height: "2.5rem",
    placeItems: "center",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: { default: "rgba(255, 255, 255, 0.2)", ":hover": "rgba(232, 224, 68, 0.7)" },
    backgroundColor: { default: "rgba(0, 0, 0, 0.25)", ":hover": "rgba(232, 224, 68, 0.1)" },
    color: { default: "rgba(255, 255, 255, 0.85)", ":hover": "#E8E044" },
    backdropFilter: "blur(12px)",
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
    /*
     * `focus-visible:outline-none` is Tailwind's transparent 2px outline, not
     * `outline: none`: the focus ring above is a box-shadow, which
     * forced-colours mode discards, and this transparent outline is what
     * remains visible there.
     */
    outlineWidth: { default: null, ":focus-visible": "2px" },
    outlineStyle: { default: null, ":focus-visible": "solid" },
    outlineColor: { default: null, ":focus-visible": "transparent" },
    outlineOffset: { default: null, ":focus-visible": "2px" },
    boxShadow: { default: null, ":focus-visible": "0 0 0 2px #E8E044" },
  },
  /**
   * size-[18px]
   */
  s_251: {
    width: "18px",
    height: "18px",
  },
  /**
   * ml-2 font-mono text-[11px] tracking-[0.16em] text-white/50
   */
  s_252: {
    marginLeft: "0.5rem",
    fontFamily: "var(--font-mono), ui-monospace, monospace",
    fontSize: "11px",
    letterSpacing: "0.16em",
    color: "rgba(255, 255, 255, 0.5)",
  },
  /**
   * h-11 rounded-none bg-[#E8E044] px-4 text-sm font-semibold text-black shadow-xl
   * hover:bg-[#f0e84e] sm:px-5
   */
  s_253: {
    height: "2.75rem",
    backgroundColor: { default: "#E8E044", ":hover": "#f0e84e" },
    paddingInline: { default: "1rem", "@media (min-width: 640px)": "1.25rem" },
    fontSize: "0.875rem",
    lineHeight: "1.25rem",
    fontWeight: 600,
    color: "#000",
    boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1)",
  },
  /**
   * size-4 animate-spin
   */
  s_254: {
    width: "1rem",
    height: "1rem",
    animationName: spin,
    animationDuration: "1s",
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
  },
  /**
   * mb-1.5 block text-sm font-medium text-foreground
   */
  s_256: {
    marginBottom: "0.375rem",
    display: "block",
    fontSize: "0.875rem",
    lineHeight: "1.25rem",
    fontWeight: 500,
    color: "hsl(var(--foreground))",
  },
  /**
   * ml-0.5 text-destructive
   */
  s_257: {
    marginLeft: "0.125rem",
    color: "hsl(var(--destructive))",
  },
  /**
   * border-t border-border pt-5
   */
  s_258: {
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderColor: "hsl(var(--border))",
    paddingTop: "1.25rem",
  },
  /**
   * mb-1 text-sm font-semibold text-foreground
   */
  s_259: {
    marginBottom: "0.25rem",
    fontSize: "0.875rem",
    lineHeight: "1.25rem",
    fontWeight: 600,
    color: "hsl(var(--foreground))",
  },
  /**
   * mb-3 text-xs text-muted-foreground
   */
  s_260: {
    marginBottom: "0.75rem",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * mt-2 space-y-1
   */
  s_263: {
    display: "flex",
    flexDirection: "column",
    gap: "0.25rem",
    marginTop: "0.5rem",
  },
  /**
   * flex items-center gap-2 text-xs text-muted-foreground
   */
  s_264: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * shrink-0 font-mono text-[10px]
   */
  s_266: {
    flexShrink: 0,
    fontFamily: "var(--font-mono), ui-monospace, monospace",
    fontSize: "10px",
  },
  /**
   * mb-3 flex items-center gap-3
   */
  s_267: {
    marginBottom: "0.75rem",
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
  },
  /**
   * mb-3 flex flex-wrap gap-1.5
   */
  s_270: {
    marginBottom: "0.75rem",
    display: "flex",
    flexWrap: "wrap",
    gap: "0.375rem",
  },
  /**
   * rounded bg-blue-800/50 px-1 py-px text-[9px] font-semibold uppercase leading-none
   * text-blue-300
   */
  s_271: {
    backgroundColor: "rgba(30, 64, 175, 0.5)",
    paddingInline: "0.25rem",
    paddingBlock: "1px",
    fontSize: "9px",
    fontWeight: 600,
    textTransform: "uppercase",
    lineHeight: 1,
    color: "#93c5fd",
  },
  /**
   * relative mb-3
   */
  s_273: {
    position: "relative",
    marginBottom: "0.75rem",
  },
  /**
   * absolute left-0 top-8 z-20 w-80 rounded-md border border-border bg-background shadow-lg
   */
  s_275: {
    position: "absolute",
    left: "0",
    top: "2rem",
    zIndex: 20,
    width: "20rem",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "hsl(var(--border))",
    backgroundColor: "hsl(var(--background))",
    boxShadow: "0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -4px rgba(0, 0, 0, 0.1)",
  },
  /**
   * p-2
   */
  s_276: {
    padding: "0.5rem",
  },
  /**
   * max-h-48 overflow-y-auto
   */
  s_278: {
    maxHeight: "12rem",
    overflowY: "auto",
  },
  /**
   * px-3 py-2 text-xs text-muted-foreground
   */
  s_279: {
    paddingInline: "0.75rem",
    paddingBlock: "0.5rem",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * flex w-full items-start gap-2 px-3 py-1.5 text-left text-xs hover:bg-muted/50
   */
  s_280: {
    display: "flex",
    width: "100%",
    alignItems: "flex-start",
    gap: "0.5rem",
    paddingInline: "0.75rem",
    paddingBlock: "0.375rem",
    textAlign: "left",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    backgroundColor: { default: null, ":hover": "hsl(var(--muted) / 0.5)" },
  },
  /**
   * shrink-0 font-mono font-medium text-foreground
   */
  s_281: {
    flexShrink: 0,
    fontFamily: "var(--font-mono), ui-monospace, monospace",
    fontWeight: 500,
    color: "hsl(var(--foreground))",
  },
  /**
   * mt-2 max-w-lg space-y-1.5
   *
   * This stack keeps block flow instead of becoming a flex column: its
   * children are a full-width `<textarea>` and a shrink-to-fit `Button`, both
   * inline-level, and a flex column would blockify them and lose the line-box
   * leading the inline flow contributes. The `> * + *` margin therefore moves
   * onto the children as `stackY1_5`, with `:first-child` cancelling the first
   * — precisely what `> :not([hidden]) ~ :not([hidden])` selected.
   */
  s_284: {
    marginTop: "0.5rem",
    maxWidth: "32rem",
  },
  /**
   * w-full resize-none rounded-md border border-input bg-background px-2.5 py-1.5 font-mono
   * text-xs text-foreground placeholder:text-muted-foreground/50 focus-visible:outline-none
   * focus-visible:ring-1 focus-visible:ring-ring
   */
  s_285: {
    width: "100%",
    resize: "none",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "hsl(var(--input))",
    backgroundColor: "hsl(var(--background))",
    paddingInline: "0.625rem",
    paddingBlock: "0.375rem",
    fontFamily: "var(--font-mono), ui-monospace, monospace",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    color: "hsl(var(--foreground))",
    /*
     * `focus-visible:outline-none` is Tailwind's transparent 2px outline, not
     * `outline: none`: the focus ring above is a box-shadow, which
     * forced-colours mode discards, and this transparent outline is what
     * remains visible there.
     */
    outlineWidth: { default: null, ":focus-visible": "2px" },
    outlineStyle: { default: null, ":focus-visible": "solid" },
    outlineColor: { default: null, ":focus-visible": "transparent" },
    outlineOffset: { default: null, ":focus-visible": "2px" },
    boxShadow: { default: null, ":focus-visible": "0 0 0 1px hsl(var(--ring))" },
    "::placeholder": { color: "hsl(var(--muted-foreground) / 0.5)" },
  },
  /**
   * h-7 text-xs
   */
  s_288: {
    height: "1.75rem",
    fontSize: "0.75rem",
    lineHeight: "1rem",
  },
  /**
   * absolute inset-0 animate-pulse bg-muted
   */
  s_289: {
    position: "absolute",
    inset: "0",
    animationName: pulse,
    animationDuration: "2s",
    animationTimingFunction: "cubic-bezier(0.4, 0, 0.6, 1)",
    animationIterationCount: "infinite",
    backgroundColor: "hsl(var(--muted))",
  },
  /**
   * grid grid-cols-3 gap-2
   */
  s_291: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: "0.5rem",
  },
  /**
   * mb-1 block text-[11px] text-muted-foreground
   */
  s_296: {
    marginBottom: "0.25rem",
    display: "block",
    fontSize: "11px",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * h-8 text-xs
   */
  s_297: {
    height: "2rem",
    fontSize: "0.75rem",
    lineHeight: "1rem",
  },
  /**
   * flex h-full w-full min-h-0 flex-col
   */
  s_298: {
    display: "flex",
    height: "100%",
    width: "100%",
    minHeight: 0,
    flexDirection: "column",
  },
  /**
   * flex min-h-[400px] shrink-0 border-b border-border
   */
  s_299: {
    display: "flex",
    minHeight: "400px",
    flexShrink: 0,
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderColor: "hsl(var(--border))",
  },
  /**
   * flex-1 min-w-0 overflow-y-auto border-r border-border px-6 py-5 space-y-4
   */
  s_300: {
    display: "flex",
    flexDirection: "column",
    gap: "1rem",
    flex: "1 1 0%",
    minWidth: 0,
    overflowY: "auto",
    borderRightWidth: "1px",
    borderRightStyle: "solid",
    borderColor: "hsl(var(--border))",
    paddingInline: "1.5rem",
    paddingBlock: "1.25rem",
  },
  /**
   * rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm
   * text-destructive
   */
  s_301: {
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "hsl(var(--destructive) / 0.5)",
    backgroundColor: "hsl(var(--destructive) / 0.1)",
    paddingInline: "0.75rem",
    paddingBlock: "0.5rem",
    fontSize: "0.875rem",
    lineHeight: "1.25rem",
    color: "hsl(var(--destructive))",
  },
  /**
   * mb-2 text-xs text-muted-foreground
   */
  s_327: {
    marginBottom: "0.5rem",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * flex items-center gap-3
   */
  s_329: {
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
  },
  /**
   * truncate text-xs text-muted-foreground
   */
  s_331: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * mt-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground
   */
  s_333: {
    marginTop: "0.5rem",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "hsl(var(--border))",
    backgroundColor: "hsl(var(--muted) / 0.3)",
    paddingInline: "0.75rem",
    paddingBlock: "0.5rem",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5
   */
  s_334: {
    display: "grid",
    gridTemplateColumns: "auto 1fr",
    columnGap: "0.75rem",
    rowGap: "0.125rem",
  },
  /**
   * w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm
   * text-foreground shadow-sm placeholder:text-muted-foreground focus-visible:outline-none
   * focus-visible:ring-1 focus-visible:ring-ring
   */
  s_339: {
    width: "100%",
    resize: "none",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "hsl(var(--input))",
    backgroundColor: "hsl(var(--background))",
    paddingInline: "0.75rem",
    paddingBlock: "0.5rem",
    fontSize: "0.875rem",
    lineHeight: "1.25rem",
    color: "hsl(var(--foreground))",
    boxShadow: { default: "0 1px 2px 0 rgba(0, 0, 0, 0.05)", ":focus-visible": "0 0 0 1px hsl(var(--ring))" },
    /*
     * `focus-visible:outline-none` is Tailwind's transparent 2px outline, not
     * `outline: none`: the focus ring above is a box-shadow, which
     * forced-colours mode discards, and this transparent outline is what
     * remains visible there.
     */
    outlineWidth: { default: null, ":focus-visible": "2px" },
    outlineStyle: { default: null, ":focus-visible": "solid" },
    outlineColor: { default: null, ":focus-visible": "transparent" },
    outlineOffset: { default: null, ":focus-visible": "2px" },
    "::placeholder": { color: "hsl(var(--muted-foreground))" },
  },
  /**
   * w-full rounded-md border border-input bg-background px-3 py-2 text-sm
   * text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1
   * focus-visible:ring-ring
   */
  s_340: {
    width: "100%",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "hsl(var(--input))",
    backgroundColor: "hsl(var(--background))",
    paddingInline: "0.75rem",
    paddingBlock: "0.5rem",
    fontSize: "0.875rem",
    lineHeight: "1.25rem",
    color: "hsl(var(--foreground))",
    boxShadow: { default: "0 1px 2px 0 rgba(0, 0, 0, 0.05)", ":focus-visible": "0 0 0 1px hsl(var(--ring))" },
    /*
     * `focus-visible:outline-none` is Tailwind's transparent 2px outline, not
     * `outline: none`: the focus ring above is a box-shadow, which
     * forced-colours mode discards, and this transparent outline is what
     * remains visible there.
     */
    outlineWidth: { default: null, ":focus-visible": "2px" },
    outlineStyle: { default: null, ":focus-visible": "solid" },
    outlineColor: { default: null, ":focus-visible": "transparent" },
    outlineOffset: { default: null, ":focus-visible": "2px" },
  },
  /**
   * relative h-[400px] w-[400px] shrink-0 self-start
   */
  s_342: {
    position: "relative",
    height: "400px",
    width: "400px",
    flexShrink: 0,
    alignSelf: "flex-start",
  },
  /**
   * absolute bottom-2 right-2 z-10 flex items-center gap-1 rounded bg-black/70 px-2 py-1
   * text-[10px] text-emerald-400
   */
  s_343: {
    position: "absolute",
    bottom: "0.5rem",
    right: "0.5rem",
    zIndex: 10,
    display: "flex",
    alignItems: "center",
    gap: "0.25rem",
    backgroundColor: "rgba(0, 0, 0, 0.7)",
    paddingInline: "0.5rem",
    paddingBlock: "0.25rem",
    fontSize: "10px",
    color: "#34d399",
  },
  /**
   * flex h-full flex-col items-center justify-center gap-3 text-muted-foreground
   */
  s_345: {
    display: "flex",
    height: "100%",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "0.75rem",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * size-8 opacity-30
   */
  s_346: {
    width: "2rem",
    height: "2rem",
    opacity: 0.3,
  },
  /**
   * text-sm
   */
  s_347: {
    fontSize: "0.875rem",
    lineHeight: "1.25rem",
  },
  /**
   * p-6 space-y-6
   */
  s_348: {
    display: "flex",
    flexDirection: "column",
    gap: "1.5rem",
    padding: "1.5rem",
  },
  /**
   * flex items-center gap-3 border-t border-border pt-4
   */
  s_349: {
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderColor: "hsl(var(--border))",
    paddingTop: "1rem",
  },
  /**
   * shrink-0 border-t border-border px-6 py-3
   */
  s_350: {
    flexShrink: 0,
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderColor: "hsl(var(--border))",
    paddingInline: "1.5rem",
    paddingBlock: "0.75rem",
  },
  /**
   * flex items-center gap-1.5 text-xs text-muted-foreground transition-colors
   * hover:text-foreground
   */
  s_351: {
    display: "flex",
    alignItems: "center",
    gap: "0.375rem",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    color: { default: "hsl(var(--muted-foreground))", ":hover": "hsl(var(--foreground))" },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
  },
  /**
   * mt-2 max-h-96 overflow-auto rounded-md border border-border bg-muted/20 p-3 text-[11px]
   * leading-relaxed text-muted-foreground
   */
  s_352: {
    marginTop: "0.5rem",
    maxHeight: "24rem",
    overflow: "auto",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "hsl(var(--border))",
    backgroundColor: "hsl(var(--muted) / 0.2)",
    padding: "0.75rem",
    fontSize: "11px",
    lineHeight: 1.625,
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * flex h-full flex-col
   */
  s_353: {
    display: "flex",
    height: "100%",
    flexDirection: "column",
  },
  /**
   * flex h-11 shrink-0 items-center border-b border-border px-6
   */
  s_354: {
    display: "flex",
    height: "2.75rem",
    flexShrink: 0,
    alignItems: "center",
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderColor: "hsl(var(--border))",
    paddingInline: "1.5rem",
  },
  /**
   * text-sm font-semibold
   */
  s_355: {
    fontSize: "0.875rem",
    lineHeight: "1.25rem",
    fontWeight: 600,
  },
  /**
   * flex min-h-0 flex-1
   */
  s_356: {
    display: "flex",
    minHeight: 0,
    flex: "1 1 0%",
  },
  /**
   * inline-flex items-center gap-1 text-[10px] text-muted-foreground
   */
  s_357: {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.25rem",
    fontSize: "10px",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * inline-flex items-center gap-1 text-[10px] text-blue-400
   */
  s_359: {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.25rem",
    fontSize: "10px",
    color: "#60a5fa",
  },
  /**
   * inline-flex items-center gap-1 text-[10px] text-emerald-400
   */
  s_361: {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.25rem",
    fontSize: "10px",
    color: "#34d399",
  },
  /**
   * inline-flex items-center gap-1 text-[10px] text-destructive
   */
  s_363: {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.25rem",
    fontSize: "10px",
    color: "hsl(var(--destructive))",
  },
  /**
   * mt-1.5 flex items-center gap-2
   */
  s_365: {
    marginTop: "0.375rem",
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
  },
  /**
   * w-14 shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground
   */
  s_366: {
    width: "3.5rem",
    flexShrink: 0,
    fontSize: "10px",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * h-1 flex-1 cursor-pointer accent-primary
   */
  s_367: {
    height: "0.25rem",
    flex: "1 1 0%",
    cursor: "pointer",
    accentColor: "hsl(var(--primary))",
  },
  /**
   * w-8 shrink-0 text-right font-mono text-[10px] text-muted-foreground
   */
  s_368: {
    width: "2rem",
    flexShrink: 0,
    textAlign: "right",
    fontFamily: "var(--font-mono), ui-monospace, monospace",
    fontSize: "10px",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * text-xs font-semibold uppercase tracking-wide text-muted-foreground
   */
  s_370: {
    fontSize: "0.75rem",
    lineHeight: "1rem",
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.025em",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * flex items-center gap-1.5 rounded border border-border bg-muted/20 px-2 py-1 text-[11px]
   * font-medium text-foreground/90 transition-colors hover:bg-muted/40
   */
  s_371: {
    display: "flex",
    alignItems: "center",
    gap: "0.375rem",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "hsl(var(--border))",
    backgroundColor: { default: "hsl(var(--muted) / 0.2)", ":hover": "hsl(var(--muted) / 0.4)" },
    paddingInline: "0.5rem",
    paddingBlock: "0.25rem",
    fontSize: "11px",
    fontWeight: 500,
    color: "hsl(var(--foreground) / 0.9)",
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
  },
  /**
   * hidden
   */
  s_373: {
    display: "none",
  },
  /**
   * mt-2 flex items-start gap-1.5 rounded border border-destructive/40 bg-destructive/10
   * px-2.5 py-1.5 text-[11px] text-destructive
   */
  s_374: {
    marginTop: "0.5rem",
    display: "flex",
    alignItems: "flex-start",
    gap: "0.375rem",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "hsl(var(--destructive) / 0.4)",
    backgroundColor: "hsl(var(--destructive) / 0.1)",
    paddingInline: "0.625rem",
    paddingBlock: "0.375rem",
    fontSize: "11px",
    color: "hsl(var(--destructive))",
  },
  /**
   * mt-px size-3.5 shrink-0
   */
  s_375: {
    marginTop: "1px",
    width: "0.875rem",
    height: "0.875rem",
    flexShrink: 0,
  },
  /**
   * rounded border border-border bg-muted/20 px-2.5 py-1.5
   */
  s_377: {
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "hsl(var(--border))",
    backgroundColor: "hsl(var(--muted) / 0.2)",
    paddingInline: "0.625rem",
    paddingBlock: "0.375rem",
  },
  /**
   * relative flex size-4 shrink-0 items-center justify-center rounded-full ring-1 ring-inset
   * ring-black/20
   */
  s_379: {
    position: "relative",
    display: "flex",
    width: "1rem",
    height: "1rem",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    boxShadow: "inset 0 0 0 1px rgba(0, 0, 0, 0.2)",
  },
  /**
   * size-2.5 text-white/80
   */
  s_380: {
    width: "0.625rem",
    height: "0.625rem",
    color: "rgba(255, 255, 255, 0.8)",
  },
  /**
   * flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground
   * transition-colors hover:bg-destructive/15 hover:text-destructive
   */
  s_383: {
    display: "flex",
    width: "1.25rem",
    height: "1.25rem",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    color: { default: "hsl(var(--muted-foreground))", ":hover": "hsl(var(--destructive))" },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
    backgroundColor: { default: null, ":hover": "hsl(var(--destructive) / 0.15)" },
  },
  /**
   * mt-2 flex flex-wrap gap-1.5
   */
  s_385: {
    marginTop: "0.5rem",
    display: "flex",
    flexWrap: "wrap",
    gap: "0.375rem",
  },
  /**
   * flex size-5 items-center justify-center rounded border border-border
   * text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-muted/50
   * hover:text-foreground
   */
  s_388: {
    display: "flex",
    width: "1.25rem",
    height: "1.25rem",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: { default: "hsl(var(--border))", ":hover": "hsl(var(--foreground) / 0.3)" },
    color: { default: "hsl(var(--muted-foreground))", ":hover": "hsl(var(--foreground))" },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
    backgroundColor: { default: null, ":hover": "hsl(var(--muted) / 0.5)" },
  },
  /**
   * flex items-center justify-between gap-2 rounded border border-border p-2
   */
  s_393: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "0.5rem",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "hsl(var(--border))",
    padding: "0.5rem",
  },
  /**
   * block truncate text-xs font-medium hover:underline
   */
  s_395: {
    display: "block",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    fontWeight: 500,
    textDecorationLine: { default: null, ":hover": "underline" },
  },
  /**
   * flex flex-wrap gap-1 justify-end
   */
  s_416: {
    display: "flex",
    flexWrap: "wrap",
    gap: "0.25rem",
    justifyContent: "flex-end",
  },
  /**
   * inline-flex items-center rounded border border-border px-1.5 py-px text-[10px]
   * font-medium
   */
  s_417: {
    display: "inline-flex",
    alignItems: "center",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "hsl(var(--border))",
    paddingInline: "0.375rem",
    paddingBlock: "1px",
    fontSize: "10px",
    fontWeight: 500,
  },
  /**
   * ml-1 text-muted-foreground
   */
  s_418: {
    marginLeft: "0.25rem",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * ml-2
   */
  s_421: {
    marginLeft: "0.5rem",
  },
  /**
   * inline-flex items-center rounded-sm bg-green-500/10 px-1.5 py-px text-[10px] font-medium
   * text-green-600 dark:text-green-400
   */
  s_423: {
    display: "inline-flex",
    alignItems: "center",
    backgroundColor: "rgba(34, 197, 94, 0.1)",
    paddingInline: "0.375rem",
    paddingBlock: "1px",
    fontSize: "10px",
    fontWeight: 500,
    color: "#4ade80",
  },
  /**
   * inline-flex items-center rounded-sm bg-muted px-1.5 py-px text-[10px] font-medium
   * text-muted-foreground
   */
  s_424: {
    display: "inline-flex",
    alignItems: "center",
    backgroundColor: "hsl(var(--muted))",
    paddingInline: "0.375rem",
    paddingBlock: "1px",
    fontSize: "10px",
    fontWeight: 500,
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * mt-1.5 text-[10px] leading-snug text-muted-foreground/80
   */
  s_425: {
    marginTop: "0.375rem",
    fontSize: "10px",
    lineHeight: 1.375,
    color: "hsl(var(--muted-foreground) / 0.8)",
  },
  /**
   * space-y-4
   */
  s_426: {
    display: "flex",
    flexDirection: "column",
    gap: "1rem",
  },
  /**
   * flex rounded-lg border border-border bg-muted/30 p-0.5
   */
  s_429: {
    display: "flex",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "hsl(var(--border))",
    backgroundColor: "hsl(var(--muted) / 0.3)",
    padding: "0.125rem",
  },
  /**
   * text-[11px] leading-relaxed text-muted-foreground
   */
  s_430: {
    fontSize: "11px",
    lineHeight: 1.625,
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * space-y-2 rounded-md border border-border/70 p-2.5
   */
  s_431: {
    display: "flex",
    flexDirection: "column",
    gap: "0.5rem",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "hsl(var(--border) / 0.7)",
    padding: "0.625rem",
  },
  /**
   * flex w-full items-center justify-center gap-1.5 rounded-md border border-border px-2
   * py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted
   * hover:text-foreground disabled:opacity-50
   */
  s_432: {
    display: "flex",
    width: "100%",
    alignItems: "center",
    justifyContent: "center",
    gap: "0.375rem",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "hsl(var(--border))",
    paddingInline: "0.5rem",
    paddingBlock: "0.375rem",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    color: { default: "hsl(var(--muted-foreground))", ":hover": "hsl(var(--foreground))" },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
    backgroundColor: { default: null, ":hover": "hsl(var(--muted))" },
    opacity: { default: null, ":disabled": 0.5 },
  },
  /**
   * flex items-center gap-2 text-xs text-foreground
   */
  s_434: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    color: "hsl(var(--foreground))",
  },
  /**
   * size-3 text-muted-foreground
   */
  s_435: {
    width: "0.75rem",
    height: "0.75rem",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * flex-1
   */
  s_436: {
    flex: "1 1 0%",
  },
  /**
   * flex size-5 items-center justify-center rounded border border-border
   * text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-muted/50
   * hover:text-foreground disabled:pointer-events-none disabled:opacity-50
   */
  s_440: {
    display: "flex",
    width: "1.25rem",
    height: "1.25rem",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: { default: "hsl(var(--border))", ":hover": "hsl(var(--foreground) / 0.3)" },
    color: { default: "hsl(var(--muted-foreground))", ":hover": "hsl(var(--foreground))" },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
    backgroundColor: { default: null, ":hover": "hsl(var(--muted) / 0.5)" },
    pointerEvents: { default: null, ":disabled": "none" },
    opacity: { default: null, ":disabled": 0.5 },
  },
  /**
   * text-xs text-destructive
   */
  s_451: {
    fontSize: "0.75rem",
    lineHeight: "1rem",
    color: "hsl(var(--destructive))",
  },
  /**
   * text-[10px] leading-snug text-muted-foreground
   */
  s_455: {
    fontSize: "10px",
    lineHeight: 1.375,
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * mt-1 truncate text-[10px] text-muted-foreground/70
   */
  s_458: {
    marginTop: "0.25rem",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "10px",
    color: "hsl(var(--muted-foreground) / 0.7)",
  },
  /**
   * mt-1.5 flex flex-wrap items-center gap-1
   */
  s_459: {
    marginTop: "0.375rem",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "0.25rem",
  },
  /**
   * rounded-full bg-muted/60 px-2 py-px text-[10px] font-medium text-muted-foreground border
   * border-border
   */
  s_460: {
    backgroundColor: "hsl(var(--muted) / 0.6)",
    paddingInline: "0.5rem",
    paddingBlock: "1px",
    fontSize: "10px",
    fontWeight: 500,
    color: "hsl(var(--muted-foreground))",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "hsl(var(--border))",
  },
  /**
   * rounded border border-border bg-muted/40 px-1 py-px text-[10px] text-muted-foreground
   */
  s_461: {
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "hsl(var(--border))",
    backgroundColor: "hsl(var(--muted) / 0.4)",
    paddingInline: "0.25rem",
    paddingBlock: "1px",
    fontSize: "10px",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * px-1 text-[10px] text-muted-foreground/60
   */
  s_462: {
    paddingInline: "0.25rem",
    fontSize: "10px",
    color: "hsl(var(--muted-foreground) / 0.6)",
  },
  /**
   * mt-0.5 text-[10px] text-muted-foreground/50
   */
  s_463: {
    marginTop: "0.125rem",
    fontSize: "10px",
    color: "hsl(var(--muted-foreground) / 0.5)",
  },
  /**
   * flex w-full items-center gap-1.5 text-xs font-semibold uppercase tracking-wide
   * text-muted-foreground transition-colors hover:text-foreground
   */
  s_465: {
    display: "flex",
    width: "100%",
    alignItems: "center",
    gap: "0.375rem",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.025em",
    color: { default: "hsl(var(--muted-foreground))", ":hover": "hsl(var(--foreground))" },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
  },
  /**
   * flex items-center justify-between gap-2 rounded border border-border px-2 py-1.5
   */
  s_468: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "0.5rem",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "hsl(var(--border))",
    paddingInline: "0.5rem",
    paddingBlock: "0.375rem",
  },
  /**
   * block truncate text-xs text-muted-foreground
   */
  s_470: {
    display: "block",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * flex items-center gap-1.5 text-[10px] text-muted-foreground/70
   */
  s_472: {
    display: "flex",
    alignItems: "center",
    gap: "0.375rem",
    fontSize: "10px",
    color: "hsl(var(--muted-foreground) / 0.7)",
  },
  /**
   * flex shrink-0 items-center gap-2
   */
  s_473: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: "0.5rem",
  },
  /**
   * text-muted-foreground transition-colors hover:text-foreground
   */
  s_478: {
    color: { default: "hsl(var(--muted-foreground))", ":hover": "hsl(var(--foreground))" },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
  },
  /**
   * flex flex-col items-center justify-center gap-2 py-8 text-center text-muted-foreground
   */
  s_480: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "0.5rem",
    paddingBlock: "2rem",
    textAlign: "center",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * size-8 opacity-50
   */
  s_481: {
    width: "2rem",
    height: "2rem",
    opacity: 0.5,
  },
  /**
   * flex items-center justify-between
   */
  s_484: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  /**
   * text-xs font-semibold text-muted-foreground
   */
  s_485: {
    fontSize: "0.75rem",
    lineHeight: "1rem",
    fontWeight: 600,
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * flex size-5 items-center justify-center rounded text-muted-foreground transition-colors
   * hover:bg-muted/50 hover:text-foreground
   */
  s_486: {
    display: "flex",
    width: "1.25rem",
    height: "1.25rem",
    alignItems: "center",
    justifyContent: "center",
    color: { default: "hsl(var(--muted-foreground))", ":hover": "hsl(var(--foreground))" },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
    backgroundColor: { default: null, ":hover": "hsl(var(--muted) / 0.5)" },
  },
  /**
   * flex w-full items-center gap-1.5 px-2.5 py-2 text-xs font-medium text-foreground
   */
  s_489: {
    display: "flex",
    width: "100%",
    alignItems: "center",
    gap: "0.375rem",
    paddingInline: "0.625rem",
    paddingBlock: "0.5rem",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    fontWeight: 500,
    color: "hsl(var(--foreground))",
  },
  /**
   * min-w-0 truncate
   */
  s_490: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  /**
   * border-t border-border px-2.5 py-2
   */
  s_491: {
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderColor: "hsl(var(--border))",
    paddingInline: "0.625rem",
    paddingBlock: "0.5rem",
  },
  /**
   * mb-2 flex items-center justify-between gap-2
   */
  s_492: {
    marginBottom: "0.5rem",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "0.5rem",
  },
  /**
   * flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px]
   * text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground
   */
  s_495: {
    display: "flex",
    alignItems: "center",
    gap: "0.25rem",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "hsl(var(--border))",
    paddingInline: "0.375rem",
    paddingBlock: "0.125rem",
    fontSize: "11px",
    color: { default: "hsl(var(--muted-foreground))", ":hover": "hsl(var(--foreground))" },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
    backgroundColor: { default: null, ":hover": "hsl(var(--muted) / 0.5)" },
  },
  /**
   * size-3 text-green-500
   */
  s_496: {
    width: "0.75rem",
    height: "0.75rem",
    color: "#22c55e",
  },
  /**
   * mb-2 space-y-1
   */
  s_498: {
    display: "flex",
    flexDirection: "column",
    gap: "0.25rem",
    marginBottom: "0.5rem",
  },
  /**
   * text-[11px] font-semibold uppercase tracking-wide text-muted-foreground
   */
  s_499: {
    fontSize: "11px",
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.025em",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * ml-1 font-normal text-muted-foreground
   */
  s_509: {
    marginLeft: "0.25rem",
    fontWeight: 400,
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * space-y-1 mb-2
   */
  s_514: {
    display: "flex",
    flexDirection: "column",
    gap: "0.25rem",
    marginBottom: "0.5rem",
  },
  /**
   * font-medium text-foreground
   */
  s_517: {
    fontWeight: 500,
    color: "hsl(var(--foreground))",
  },
  /**
   * flex items-baseline gap-2 text-xs
   */
  s_518: {
    display: "flex",
    alignItems: "baseline",
    gap: "0.5rem",
    fontSize: "0.75rem",
    lineHeight: "1rem",
  },
  /**
   * font-mono text-foreground/80 text-[10px] break-all
   */
  s_520: {
    fontFamily: "var(--font-mono), ui-monospace, monospace",
    color: "hsl(var(--foreground) / 0.8)",
    fontSize: "10px",
    wordBreak: "break-all",
  },
  /**
   * border-b border-border/50 pt-1
   */
  s_521: {
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderColor: "hsl(var(--border) / 0.5)",
    paddingTop: "0.25rem",
  },
  /**
   * mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground
   */
  s_522: {
    marginBottom: "0.375rem",
    fontSize: "11px",
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.025em",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * flex flex-wrap gap-2
   */
  s_523: {
    display: "flex",
    flexWrap: "wrap",
    gap: "0.5rem",
  },
  /**
   * flex items-center gap-1.5 rounded border border-border px-2 py-1 text-xs
   * text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground
   */
  s_530: {
    display: "flex",
    alignItems: "center",
    gap: "0.375rem",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "hsl(var(--border))",
    paddingInline: "0.5rem",
    paddingBlock: "0.25rem",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    color: { default: "hsl(var(--muted-foreground))", ":hover": "hsl(var(--foreground))" },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
    backgroundColor: { default: null, ":hover": "hsl(var(--muted) / 0.5)" },
  },
  /**
   * gap-1.5 text-xs
   */
  s_536: {
    gap: "0.375rem",
    fontSize: "0.75rem",
    lineHeight: "1rem",
  },
  /**
   * text-[10px] text-muted-foreground
   */
  s_539: {
    fontSize: "10px",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * flex items-center gap-1 text-[10px] text-destructive
   */
  s_540: {
    display: "flex",
    alignItems: "center",
    gap: "0.25rem",
    fontSize: "10px",
    color: "hsl(var(--destructive))",
  },
  /**
   * pointer-events-none fixed -left-[9999px] -top-[9999px]
   */
  s_542: {
    pointerEvents: "none",
    position: "fixed",
    left: "-9999px",
    top: "-9999px",
  },
  /**
   * group block w-full overflow-hidden rounded-md border border-border bg-muted/30 text-left
   * transition-colors hover:border-foreground/20 focus-visible:outline-none
   * focus-visible:ring-2 focus-visible:ring-ring
   */
  s_545: {
    display: "block",
    width: "100%",
    overflow: "hidden",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: { default: "hsl(var(--border))", ":hover": "hsl(var(--foreground) / 0.2)" },
    backgroundColor: "hsl(var(--muted) / 0.3)",
    textAlign: "left",
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
    /*
     * `focus-visible:outline-none` is Tailwind's transparent 2px outline, not
     * `outline: none`: the focus ring above is a box-shadow, which
     * forced-colours mode discards, and this transparent outline is what
     * remains visible there.
     */
    outlineWidth: { default: null, ":focus-visible": "2px" },
    outlineStyle: { default: null, ":focus-visible": "solid" },
    outlineColor: { default: null, ":focus-visible": "transparent" },
    outlineOffset: { default: null, ":focus-visible": "2px" },
    boxShadow: { default: null, ":focus-visible": "0 0 0 2px hsl(var(--ring))" },
    [hovered.videoScrimColor]: "rgba(0, 0, 0, 0)",
    [hovered.videoLabelColor]: "hsl(var(--muted-foreground))",
    ":hover": {
      [hovered.videoScrimColor]: "rgba(0, 0, 0, 0.1)",
      [hovered.videoLabelColor]: "hsl(var(--foreground))",
    },
  },
  /**
   * relative aspect-video w-full bg-muted/30
   */
  s_546: {
    position: "relative",
    aspectRatio: "16 / 9",
    width: "100%",
    backgroundColor: "hsl(var(--muted) / 0.3)",
  },
  /**
   * h-full w-full object-cover
   */
  s_547: {
    height: "100%",
    width: "100%",
    objectFit: "cover",
  },
  /**
   * absolute inset-0 flex items-center justify-center bg-black/0 transition-colors
   * group-hover:bg-black/10
   */
  s_548: {
    position: "absolute",
    inset: "0",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: hovered.videoScrimColor,
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
  },
  /**
   * flex size-11 items-center justify-center rounded-full bg-foreground/80 text-background
   * transition-transform group-hover:scale-110
   */
  s_549: {
    display: "flex",
    width: "2.75rem",
    height: "2.75rem",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "hsl(var(--foreground) / 0.8)",
    color: "hsl(var(--background))",
    transitionProperty: "transform",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
  },
  /**
   * size-5 fill-current
   */
  s_550: {
    width: "1.25rem",
    height: "1.25rem",
    fill: "currentColor",
  },
  /**
   * block truncate px-2 py-1.5 text-xs text-muted-foreground group-hover:text-foreground
   */
  s_551: {
    display: "block",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    paddingInline: "0.5rem",
    paddingBlock: "0.375rem",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    color: hovered.videoLabelColor,
  },
  /**
   * group flex w-full items-center gap-2 overflow-hidden rounded-md border border-border
   * bg-muted/30 py-1.5 pl-1.5 pr-2 transition-colors hover:border-foreground/20
   * hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
   */
  s_552: {
    display: "flex",
    width: "100%",
    alignItems: "center",
    gap: "0.5rem",
    overflow: "hidden",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: { default: "hsl(var(--border))", ":hover": "hsl(var(--foreground) / 0.2)" },
    backgroundColor: { default: "hsl(var(--muted) / 0.3)", ":hover": "hsl(var(--muted) / 0.5)" },
    paddingBlock: "0.375rem",
    paddingLeft: "0.375rem",
    paddingRight: "0.5rem",
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
    /*
     * `focus-visible:outline-none` is Tailwind's transparent 2px outline, not
     * `outline: none`: the focus ring above is a box-shadow, which
     * forced-colours mode discards, and this transparent outline is what
     * remains visible there.
     */
    outlineWidth: { default: null, ":focus-visible": "2px" },
    outlineStyle: { default: null, ":focus-visible": "solid" },
    outlineColor: { default: null, ":focus-visible": "transparent" },
    outlineOffset: { default: null, ":focus-visible": "2px" },
    boxShadow: { default: null, ":focus-visible": "0 0 0 2px hsl(var(--ring))" },
    [hovered.videoLabelColor]: "hsl(var(--muted-foreground))",
    ":hover": {
      [hovered.videoLabelColor]: "hsl(var(--foreground))",
    },
  },
  /**
   * flex size-12 shrink-0 items-center justify-center rounded bg-muted/60
   */
  s_553: {
    display: "flex",
    width: "3rem",
    height: "3rem",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "hsl(var(--muted) / 0.6)",
  },
  /**
   * flex size-7 items-center justify-center rounded-full bg-foreground/80 text-background
   * transition-transform group-hover:scale-110
   */
  s_554: {
    display: "flex",
    width: "1.75rem",
    height: "1.75rem",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "hsl(var(--foreground) / 0.8)",
    color: "hsl(var(--background))",
    transitionProperty: "transform",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
  },
  /**
   * size-3.5 fill-current
   */
  s_555: {
    width: "0.875rem",
    height: "0.875rem",
    fill: "currentColor",
  },
  /**
   * min-w-0 flex-1 truncate text-left text-xs text-muted-foreground
   * group-hover:text-foreground
   */
  s_556: {
    minWidth: 0,
    flex: "1 1 0%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    textAlign: "left",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    color: hovered.videoLabelColor,
  },
  /**
   * rounded border border-border bg-muted/30 px-2.5 py-2
   */
  s_563: {
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "hsl(var(--border))",
    backgroundColor: "hsl(var(--muted) / 0.3)",
    paddingInline: "0.625rem",
    paddingBlock: "0.5rem",
  },
  /**
   * mt-0.5 text-[11px] leading-snug text-muted-foreground
   */
  s_565: {
    marginTop: "0.125rem",
    fontSize: "11px",
    lineHeight: 1.375,
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide
   * text-muted-foreground transition-colors hover:text-foreground
   */
  s_566: {
    display: "flex",
    alignItems: "center",
    gap: "0.375rem",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.025em",
    color: { default: "hsl(var(--muted-foreground))", ":hover": "hsl(var(--foreground))" },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
  },
  /**
   * flex shrink-0 overflow-hidden rounded border border-border
   */
  s_575: {
    display: "flex",
    flexShrink: 0,
    overflow: "hidden",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "hsl(var(--border))",
  },
  /**
   * rounded border border-dashed border-border px-2.5 py-2.5
   */
  s_592: {
    borderWidth: "1px",
    borderStyle: "dashed",
    borderColor: "hsl(var(--border))",
    paddingInline: "0.625rem",
    paddingBlock: "0.625rem",
  },
  /**
   * text-xs text-muted-foreground mb-2
   */
  s_593: {
    fontSize: "0.75rem",
    lineHeight: "1rem",
    color: "hsl(var(--muted-foreground))",
    marginBottom: "0.5rem",
  },
  /**
   * mr-1.5 size-3.5
   */
  s_596: {
    marginRight: "0.375rem",
    width: "0.875rem",
    height: "0.875rem",
  },
  /**
   * flex items-center gap-1.5 px-1 text-[10px] uppercase tracking-wider text-muted-foreground
   */
  s_601: {
    display: "flex",
    alignItems: "center",
    gap: "0.375rem",
    paddingInline: "0.25rem",
    fontSize: "10px",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * font-mono text-muted-foreground/70
   */
  s_602: {
    fontFamily: "var(--font-mono), ui-monospace, monospace",
    color: "hsl(var(--muted-foreground) / 0.7)",
  },
  /**
   * flex size-4 shrink-0 items-center justify-center rounded-full
   */
  s_603: {
    display: "flex",
    width: "1rem",
    height: "1rem",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  /**
   * size-3.5 shrink-0 animate-spin text-muted-foreground
   */
  s_615: {
    width: "0.875rem",
    height: "0.875rem",
    flexShrink: 0,
    animationName: spin,
    animationDuration: "1s",
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * flex items-center gap-2.5 rounded border border-border bg-muted/20 px-2.5 py-1.5
   */
  s_621: {
    display: "flex",
    alignItems: "center",
    gap: "0.625rem",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "hsl(var(--border))",
    backgroundColor: "hsl(var(--muted) / 0.2)",
    paddingInline: "0.625rem",
    paddingBlock: "0.375rem",
  },
  /**
   * shrink-0
   */
  s_622: {
    flexShrink: 0,
  },
  /**
   * min-w-0 flex-1 truncate text-xs font-medium text-foreground/90
   */
  s_623: {
    minWidth: 0,
    flex: "1 1 0%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    fontWeight: 500,
    color: "hsl(var(--foreground) / 0.9)",
  },
  /**
   * shrink-0 font-mono text-[11px] text-muted-foreground
   */
  s_624: {
    flexShrink: 0,
    fontFamily: "var(--font-mono), ui-monospace, monospace",
    fontSize: "11px",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * ml-4 space-y-1.5
   */
  s_625: {
    display: "flex",
    flexDirection: "column",
    gap: "0.375rem",
    marginLeft: "1rem",
  },
  /**
   * px-1 text-[10px] uppercase tracking-wider text-muted-foreground
   */
  s_626: {
    paddingInline: "0.25rem",
    fontSize: "10px",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * ml-1 font-mono text-muted-foreground/70
   */
  s_627: {
    marginLeft: "0.25rem",
    fontFamily: "var(--font-mono), ui-monospace, monospace",
    color: "hsl(var(--muted-foreground) / 0.7)",
  },
  /**
   * flex items-center gap-2.5 rounded border border-border bg-muted/20 px-2.5 py-1
   */
  s_628: {
    display: "flex",
    alignItems: "center",
    gap: "0.625rem",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "hsl(var(--border))",
    backgroundColor: "hsl(var(--muted) / 0.2)",
    paddingInline: "0.625rem",
    paddingBlock: "0.25rem",
  },
  /**
   * size-2 shrink-0 rounded-full
   */
  s_629: {
    width: "0.5rem",
    height: "0.5rem",
    flexShrink: 0,
  },
  /**
   * min-w-0 flex-1 truncate text-xs text-foreground/90
   */
  s_630: {
    minWidth: 0,
    flex: "1 1 0%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    color: "hsl(var(--foreground) / 0.9)",
  },
  /**
   * flex items-center gap-1.5 px-1
   */
  s_631: {
    display: "flex",
    alignItems: "center",
    gap: "0.375rem",
    paddingInline: "0.25rem",
  },
  /**
   * text-[10px] uppercase tracking-wider text-muted-foreground
   */
  s_632: {
    fontSize: "10px",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * px-1 text-[10px] text-muted-foreground
   */
  s_633: {
    paddingInline: "0.25rem",
    fontSize: "10px",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * flex w-full items-center gap-1.5 pb-1.5 group
   */
  s_634: {
    display: "flex",
    width: "100%",
    alignItems: "center",
    gap: "0.375rem",
    paddingBottom: "0.375rem",
  },
  /**
   * size-3 text-muted-foreground shrink-0
   */
  s_635: {
    width: "0.75rem",
    height: "0.75rem",
    color: "hsl(var(--muted-foreground))",
    flexShrink: 0,
  },
  /**
   * text-xs font-semibold
   */
  s_636: {
    fontSize: "0.75rem",
    lineHeight: "1rem",
    fontWeight: 600,
  },
  /**
   * space-y-0.5 ml-[18px]
   */
  s_637: {
    display: "flex",
    flexDirection: "column",
    gap: "0.125rem",
    marginLeft: "18px",
  },
  /**
   * space-y-3 pt-1
   */
  s_641: {
    display: "flex",
    flexDirection: "column",
    gap: "0.75rem",
    paddingTop: "0.25rem",
  },
  /**
   * flex items-center justify-end
   */
  s_642: {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
  },
  /**
   * flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground
   * transition-colors
   */
  s_643: {
    display: "flex",
    alignItems: "center",
    gap: "0.25rem",
    fontSize: "10px",
    color: { default: "hsl(var(--muted-foreground))", ":hover": "hsl(var(--foreground))" },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
  },
  /**
   * mt-2 mb-1
   */
  s_645: {
    marginTop: "0.5rem",
    marginBottom: "0.25rem",
  },
  /**
   * text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wide mb-1.5
   */
  s_646: {
    fontSize: "10px",
    fontWeight: 500,
    color: "hsl(var(--muted-foreground) / 0.7)",
    textTransform: "uppercase",
    letterSpacing: "0.025em",
    marginBottom: "0.375rem",
  },
  /**
   * flex items-baseline justify-between gap-2 py-0.5
   */
  s_648: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: "0.5rem",
    paddingBlock: "0.125rem",
  },
  /**
   * text-xs font-medium tabular-nums text-right
   */
  s_650: {
    fontSize: "0.75rem",
    lineHeight: "1rem",
    fontWeight: 500,
    fontVariantNumeric: "tabular-nums",
    textAlign: "right",
  },
  /**
   * space-y-2 py-1
   */
  s_651: {
    display: "flex",
    flexDirection: "column",
    gap: "0.5rem",
    paddingBlock: "0.25rem",
  },
  /**
   * py-1 space-y-1.5
   */
  s_652: {
    display: "flex",
    flexDirection: "column",
    gap: "0.375rem",
    paddingBlock: "0.25rem",
  },
  /**
   * flex items-center gap-1.5 mb-0.5
   */
  s_655: {
    display: "flex",
    alignItems: "center",
    gap: "0.375rem",
    marginBottom: "0.125rem",
  },
  /**
   * text-[11px] text-muted-foreground leading-relaxed ml-0.5
   */
  s_657: {
    fontSize: "11px",
    color: "hsl(var(--muted-foreground))",
    lineHeight: 1.625,
    marginLeft: "0.125rem",
  },
  /**
   * mt-2 space-y-3
   */
  s_663: {
    display: "flex",
    flexDirection: "column",
    gap: "0.75rem",
    marginTop: "0.5rem",
  },
  /**
   * text-xs text-muted-foreground leading-relaxed
   */
  s_664: {
    fontSize: "0.75rem",
    lineHeight: 1.625,
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * text-foreground/80
   */
  s_665: {
    color: "hsl(var(--foreground) / 0.8)",
  },
  /**
   * text-xs text-foreground/90
   */
  s_667: {
    fontSize: "0.75rem",
    lineHeight: "1rem",
    color: "hsl(var(--foreground) / 0.9)",
  },
  /**
   * text-muted-foreground/70 shrink-0
   */
  s_692: {
    color: "hsl(var(--muted-foreground) / 0.7)",
    flexShrink: 0,
  },
  /**
   * break-all font-mono text-[10px] leading-snug text-foreground/85
   */
  s_693: {
    wordBreak: "break-all",
    fontFamily: "var(--font-mono), ui-monospace, monospace",
    fontSize: "10px",
    lineHeight: 1.375,
    color: "hsl(var(--foreground) / 0.85)",
  },
  /**
   * break-all font-mono text-foreground/90
   */
  s_697: {
    wordBreak: "break-all",
    fontFamily: "var(--font-mono), ui-monospace, monospace",
    color: "hsl(var(--foreground) / 0.9)",
  },
  /**
   * text-[10px] text-muted-foreground/60
   */
  s_698: {
    fontSize: "10px",
    color: "hsl(var(--muted-foreground) / 0.6)",
  },
  /**
   * mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground
   */
  s_699: {
    marginBottom: "0.25rem",
    fontSize: "11px",
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.025em",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs text-muted-foreground
   */
  s_700: {
    display: "grid",
    gridTemplateColumns: "auto 1fr",
    columnGap: "0.5rem",
    rowGap: "0.125rem",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * text-muted-foreground/70
   */
  s_705: {
    color: "hsl(var(--muted-foreground) / 0.7)",
  },
  /**
   * font-mono text-foreground/90
   */
  s_706: {
    fontFamily: "var(--font-mono), ui-monospace, monospace",
    color: "hsl(var(--foreground) / 0.9)",
  },
  /**
   * pt-1
   */
  s_707: {
    paddingTop: "0.25rem",
  },
  /**
   * w-full
   */
  s_708: {
    width: "100%",
  },
  /**
   * mr-1.5 size-3.5 animate-spin
   */
  s_709: {
    marginRight: "0.375rem",
    width: "0.875rem",
    height: "0.875rem",
    animationName: spin,
    animationDuration: "1s",
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
  },
  /**
   * mt-1.5 text-xs text-destructive
   */
  s_710: {
    marginTop: "0.375rem",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    color: "hsl(var(--destructive))",
  },
  /**
   * shrink-0 text-muted-foreground/60 transition-colors hover:text-muted-foreground
   */
  s_713: {
    flexShrink: 0,
    color: { default: "hsl(var(--muted-foreground) / 0.6)", ":hover": "hsl(var(--muted-foreground))" },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
  },
  /**
   * size-3 text-green-400
   */
  s_714: {
    width: "0.75rem",
    height: "0.75rem",
    color: "#4ade80",
  },
  /**
   * mt-2
   */
  s_716: {
    marginTop: "0.5rem",
  },
  /**
   * mt-2 text-xs leading-relaxed text-muted-foreground
   */
  s_717: {
    marginTop: "0.5rem",
    fontSize: "0.75rem",
    lineHeight: 1.625,
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * flex min-w-0 items-center gap-2
   */
  s_718: {
    display: "flex",
    minWidth: 0,
    alignItems: "center",
    gap: "0.5rem",
  },
  /**
   * flex h-10 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground
   * transition-colors hover:bg-foreground/[0.08] hover:text-foreground
   * focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
   */
  s_719: {
    display: "flex",
    height: "2.5rem",
    flexShrink: 0,
    alignItems: "center",
    gap: "0.375rem",
    paddingInline: "0.5rem",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    color: { default: "hsl(var(--muted-foreground))", ":hover": "hsl(var(--foreground))" },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
    backgroundColor: { default: null, ":hover": "hsl(var(--foreground) / 0.08)" },
    /*
     * `focus-visible:outline-none` is Tailwind's transparent 2px outline, not
     * `outline: none`: the focus ring above is a box-shadow, which
     * forced-colours mode discards, and this transparent outline is what
     * remains visible there.
     */
    outlineWidth: { default: null, ":focus-visible": "2px" },
    outlineStyle: { default: null, ":focus-visible": "solid" },
    outlineColor: { default: null, ":focus-visible": "transparent" },
    outlineOffset: { default: null, ":focus-visible": "2px" },
    boxShadow: { default: null, ":focus-visible": "0 0 0 2px hsl(var(--ring))" },
  },
  /**
   * hidden lg:inline
   */
  s_721: {
    display: { default: "none", "@media (min-width: 1024px)": "inline" },
  },
  /**
   * lg:hidden
   */
  s_722: {
    display: { default: null, "@media (min-width: 1024px)": "none" },
  },
  /**
   * hidden h-5 w-px shrink-0 bg-border md:block
   */
  s_723: {
    display: { default: "none", "@media (min-width: 768px)": "block" },
    height: "1.25rem",
    width: "1px",
    flexShrink: 0,
    backgroundColor: "hsl(var(--border))",
  },
  /**
   * gap-1.5 rounded-md
   */
  s_724: {
    gap: "0.375rem",
  },
  /**
   * ml-2 size-10 shrink-0 rounded-md text-foreground/70 transition-colors
   * hover:bg-foreground/[0.08] hover:text-foreground
   */
  s_726: {
    marginLeft: "0.5rem",
    width: "2.5rem",
    height: "2.5rem",
    flexShrink: 0,
    color: { default: "hsl(var(--foreground) / 0.7)", ":hover": "hsl(var(--foreground))" },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
    backgroundColor: { default: null, ":hover": "hsl(var(--foreground) / 0.08)" },
  },
  /**
   * w-48
   */
  s_728: {
    width: "12rem",
  },
  /**
   * max-w-xs text-xs
   */
  s_731: {
    maxWidth: "20rem",
    fontSize: "0.75rem",
    lineHeight: "1rem",
  },
  /**
   * mr-2 size-3.5
   */
  s_732: {
    marginRight: "0.5rem",
    width: "0.875rem",
    height: "0.875rem",
  },
  /**
   * shrink-0 border-l border-border bg-background hover:bg-muted transition-colors flex
   * items-center px-1.5
   */
  s_733: {
    flexShrink: 0,
    borderLeftWidth: "1px",
    borderLeftStyle: "solid",
    borderColor: "hsl(var(--border))",
    backgroundColor: { default: "hsl(var(--background))", ":hover": "hsl(var(--muted))" },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
    display: "flex",
    alignItems: "center",
    paddingInline: "0.375rem",
  },
  /**
   * flex items-center gap-1.5 [writing-mode:vertical-lr] rotate-180 text-xs
   * text-muted-foreground hover:text-foreground py-3
   */
  s_734: {
    display: "flex",
    alignItems: "center",
    gap: "0.375rem",
    writingMode: "vertical-lr",
    transform: "rotate(180deg)",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    color: { default: "hsl(var(--muted-foreground))", ":hover": "hsl(var(--foreground))" },
    paddingBlock: "0.75rem",
  },
  /**
   * size-3.5 rotate-90
   */
  s_735: {
    width: "0.875rem",
    height: "0.875rem",
    transform: "rotate(90deg)",
  },
  /**
   * relative w-[24rem] shrink-0 min-h-0 overflow-hidden flex flex-col
   */
  s_736: {
    position: "relative",
    width: "24rem",
    flexShrink: 0,
    minHeight: 0,
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
  },
  /**
   * absolute inset-y-0 left-0 z-20 w-4 -translate-x-1/2 transition-all ease-linear
   * after:absolute after:inset-y-0 after:left-1/2 after:-translate-x-1/2 after:w-[2px]
   * after:rounded-full after:transition-all hover:after:w-1 hover:after:bg-primary/40
   * cursor-e-resize flex items-center justify-center group/rail
   *
   * The `group/rail` marker is gone: its one descendant now reads `hovered`.
   */
  s_737: {
    position: "absolute",
    top: "0",
    bottom: "0",
    left: "0",
    zIndex: 20,
    width: "1rem",
    transform: "translateX(-50%)",
    transitionProperty: "all",
    transitionTimingFunction: "linear",
    transitionDuration: "150ms",
    cursor: "e-resize",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    [hovered.railIconOpacity]: "0",
    ":hover": {
      [hovered.railIconOpacity]: "1",
    },
    "::after": {
      content: '""',
      position: "absolute",
      top: "0",
      bottom: "0",
      left: "50%",
      transform: "translateX(-50%)",
      transitionProperty: "all",
      transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
      transitionDuration: "150ms",
      width: { default: "2px", ":hover": "0.25rem" },
      backgroundColor: { default: null, ":hover": "hsl(var(--primary) / 0.4)" },
    },
  },
  /**
   * size-3 text-muted-foreground opacity-0 group-hover/rail:opacity-100 transition-opacity
   */
  s_738: {
    width: "0.75rem",
    height: "0.75rem",
    color: "hsl(var(--muted-foreground))",
    opacity: hovered.railIconOpacity,
    transitionProperty: "opacity",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
  },
  /**
   * w-full border-l border-border bg-background flex flex-col min-h-0
   */
  s_739: {
    width: "100%",
    borderLeftWidth: "1px",
    borderLeftStyle: "solid",
    borderColor: "hsl(var(--border))",
    backgroundColor: "hsl(var(--background))",
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
  },
  /**
   * flex-1 flex flex-col min-h-0
   */
  s_740: {
    flex: "1 1 0%",
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
  },
  /**
   * grid grid-cols-4 shrink-0 w-full rounded-none border-b border-border h-10 bg-transparent
   * p-0
   */
  s_741: {
    display: "grid",
    gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
    flexShrink: 0,
    width: "100%",
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderColor: "hsl(var(--border))",
    height: "2.5rem",
    backgroundColor: "transparent",
    padding: "0",
  },
  /**
   * gap-1 rounded-none border-b-2 border-transparent text-xs text-muted-foreground
   * data-[state=active]:border-primary data-[state=active]:bg-transparent
   * data-[state=active]:text-foreground data-[state=active]:shadow-none min-w-0 px-1
   *
   * Radix writes `data-state` after mount, but the attribute lives on this
   * element, so StyleX compiles the variant as an ordinary condition. The
   * callsite passes this rule through `TabsTrigger`'s `xstyle`, not its
   * `className`: `tabs.stylex.ts` gives its own trigger an active background,
   * colour and shadow under the same attribute, and only a StyleX merge —
   * which resolves per property, last rule wins — reliably overrides them.
   */
  s_742: {
    gap: "0.25rem",
    borderBottomWidth: "2px",
    borderBottomStyle: "solid",
    borderColor: { default: "transparent", "[data-state=active]": "hsl(var(--primary))" },
    fontSize: "0.75rem",
    lineHeight: "1rem",
    color: { default: "hsl(var(--muted-foreground))", "[data-state=active]": "hsl(var(--foreground))" },
    backgroundColor: { default: null, "[data-state=active]": "transparent" },
    boxShadow: { default: null, "[data-state=active]": "none" },
    minWidth: 0,
    paddingInline: "0.25rem",
  },
  /**
   * flex-1 overflow-y-auto p-3 mt-0 data-[state=inactive]:hidden
   */
  s_748: {
    flex: "1 1 0%",
    overflowY: "auto",
    padding: "0.75rem",
    marginTop: "0",
    display: { default: null, "[data-state=inactive]": "none" },
  },
  /**
   * flex h-10 w-44 items-center gap-1.5 rounded-md border border-border bg-muted/30 px-3
   * text-sm font-medium transition-colors hover:bg-muted/50 sm:w-[280px]
   */
  s_749: {
    display: "flex",
    height: "2.5rem",
    width: { default: "11rem", "@media (min-width: 640px)": "280px" },
    alignItems: "center",
    gap: "0.375rem",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "hsl(var(--border))",
    backgroundColor: { default: "hsl(var(--muted) / 0.3)", ":hover": "hsl(var(--muted) / 0.5)" },
    paddingInline: "0.75rem",
    fontSize: "0.875rem",
    lineHeight: "1.25rem",
    fontWeight: 500,
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
  },
  /**
   * flex-1 truncate text-left
   */
  s_750: {
    flex: "1 1 0%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    textAlign: "left",
  },
  /**
   * size-3.5 shrink-0 text-muted-foreground ml-auto
   */
  s_751: {
    width: "0.875rem",
    height: "0.875rem",
    flexShrink: 0,
    color: "hsl(var(--muted-foreground))",
    marginLeft: "auto",
  },
  /**
   * w-[280px] p-0
   */
  s_752: {
    width: "280px",
    padding: "0",
  },
  /**
   * border-b border-border p-2
   */
  s_753: {
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderColor: "hsl(var(--border))",
    padding: "0.5rem",
  },
  /**
   * pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2
   * text-muted-foreground
   */
  s_755: {
    pointerEvents: "none",
    position: "absolute",
    left: "0.625rem",
    top: "50%",
    width: "0.875rem",
    height: "0.875rem",
    transform: "translateY(-50%)",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * h-8 pl-8 text-xs
   */
  s_756: {
    height: "2rem",
    paddingLeft: "2rem",
    fontSize: "0.75rem",
    lineHeight: "1rem",
  },
  /**
   * max-h-64 overflow-y-auto py-1
   */
  s_757: {
    maxHeight: "16rem",
    overflowY: "auto",
    paddingBlock: "0.25rem",
  },
  /**
   * px-3 py-4 text-center text-xs text-muted-foreground
   */
  s_758: {
    paddingInline: "0.75rem",
    paddingBlock: "1rem",
    textAlign: "center",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * size-3.5 shrink-0 text-primary
   */
  s_759: {
    width: "0.875rem",
    height: "0.875rem",
    flexShrink: 0,
    color: "hsl(var(--primary))",
  },
  /**
   * size-3.5 shrink-0
   */
  s_760: {
    width: "0.875rem",
    height: "0.875rem",
    flexShrink: 0,
  },
  /**
   * min-w-0 flex-1
   */
  s_761: {
    minWidth: 0,
    flex: "1 1 0%",
  },
  /**
   * text-[10px] text-muted-foreground truncate
   */
  s_762: {
    fontSize: "10px",
    color: "hsl(var(--muted-foreground))",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  /**
   * size-8 animate-pulse text-muted-foreground
   */
  s_765: {
    width: "2rem",
    height: "2rem",
    animationName: pulse,
    animationDuration: "2s",
    animationTimingFunction: "cubic-bezier(0.4, 0, 0.6, 1)",
    animationIterationCount: "infinite",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * flex h-full w-full items-center justify-center bg-background/50
   */
  s_766: {
    display: "flex",
    height: "100%",
    width: "100%",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "hsl(var(--background) / 0.5)",
  },
  /**
   * size-6 animate-spin text-muted-foreground
   */
  s_767: {
    width: "1.5rem",
    height: "1.5rem",
    animationName: spin,
    animationDuration: "1s",
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * flex h-full w-full flex-col items-center justify-center gap-4 bg-background/50
   */
  s_768: {
    display: "flex",
    height: "100%",
    width: "100%",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "1rem",
    backgroundColor: "hsl(var(--background) / 0.5)",
  },
  /**
   * flex h-16 w-16 items-center justify-center rounded-2xl border border-border bg-muted/50
   */
  s_769: {
    display: "flex",
    height: "4rem",
    width: "4rem",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "hsl(var(--border))",
    backgroundColor: "hsl(var(--muted) / 0.5)",
  },
  /**
   * size-8 text-muted-foreground
   */
  s_770: {
    width: "2rem",
    height: "2rem",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * text-center
   */
  s_771: {
    textAlign: "center",
  },
  /**
   * mt-1 max-w-xs text-xs text-muted-foreground
   */
  s_773: {
    marginTop: "0.25rem",
    maxWidth: "20rem",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * flex h-full w-full flex-col items-center justify-center gap-3 bg-background/50
   */
  s_774: {
    display: "flex",
    height: "100%",
    width: "100%",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "0.75rem",
    backgroundColor: "hsl(var(--background) / 0.5)",
  },
  /**
   * size-7 text-destructive
   */
  s_775: {
    width: "1.75rem",
    height: "1.75rem",
    color: "hsl(var(--destructive))",
  },
  /**
   * max-w-md text-center text-xs text-muted-foreground
   */
  s_776: {
    maxWidth: "28rem",
    textAlign: "center",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * h-full w-full
   */
  s_778: {
    height: "100%",
    width: "100%",
  },
  /**
   * h-full overflow-hidden
   */
  s_779: {
    height: "100%",
    overflow: "hidden",
  },
  /**
   * relative flex h-full flex-col
   */
  s_780: {
    position: "relative",
    display: "flex",
    height: "100%",
    flexDirection: "column",
  },
  /**
   * flex h-12 shrink-0 items-center justify-between border-b border-border bg-background px-3
   */
  s_781: {
    display: "flex",
    height: "3rem",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderColor: "hsl(var(--border))",
    backgroundColor: "hsl(var(--background))",
    paddingInline: "0.75rem",
  },
  /**
   * grid size-8 place-items-center rounded-md text-muted-foreground transition-colors
   * hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2
   * focus-visible:ring-ring
   */
  s_783: {
    display: "grid",
    width: "2rem",
    height: "2rem",
    placeItems: "center",
    color: { default: "hsl(var(--muted-foreground))", ":hover": "hsl(var(--foreground))" },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
    backgroundColor: { default: null, ":hover": "hsl(var(--muted))" },
    /*
     * `focus-visible:outline-none` is Tailwind's transparent 2px outline, not
     * `outline: none`: the focus ring above is a box-shadow, which
     * forced-colours mode discards, and this transparent outline is what
     * remains visible there.
     */
    outlineWidth: { default: null, ":focus-visible": "2px" },
    outlineStyle: { default: null, ":focus-visible": "solid" },
    outlineColor: { default: null, ":focus-visible": "transparent" },
    outlineOffset: { default: null, ":focus-visible": "2px" },
    boxShadow: { default: null, ":focus-visible": "0 0 0 2px hsl(var(--ring))" },
  },
  /**
   * flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm
   * text-amber-700 dark:text-amber-300
   */
  s_785: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderColor: "rgba(245, 158, 11, 0.3)",
    backgroundColor: "rgba(245, 158, 11, 0.1)",
    paddingInline: "1rem",
    paddingBlock: "0.5rem",
    fontSize: "0.875rem",
    lineHeight: "1.25rem",
    color: "#fcd34d",
  },
  /**
   * h-4 w-4 shrink-0 animate-spin
   */
  s_786: {
    height: "1rem",
    width: "1rem",
    flexShrink: 0,
    animationName: spin,
    animationDuration: "1s",
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
  },
  /**
   * relative flex-1 flex min-h-0
   */
  s_787: {
    position: "relative",
    flex: "1 1 0%",
    display: "flex",
    minHeight: 0,
  },
  /**
   * relative w-[30rem] shrink-0 min-h-0
   */
  s_788: {
    position: "relative",
    width: "30rem",
    flexShrink: 0,
    minHeight: 0,
  },
  /**
   * absolute inset-0 overflow-hidden flex flex-col border-r border-border bg-background
   */
  s_789: {
    position: "absolute",
    inset: "0",
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
    borderRightWidth: "1px",
    borderRightStyle: "solid",
    borderColor: "hsl(var(--border))",
    backgroundColor: "hsl(var(--background))",
  },
  /**
   * absolute top-5 -right-4 z-20 flex size-8 items-center justify-center
   * text-muted-foreground transition-colors hover:text-foreground
   */
  s_790: {
    position: "absolute",
    top: "1.25rem",
    right: "-1rem",
    zIndex: 20,
    display: "flex",
    width: "2rem",
    height: "2rem",
    alignItems: "center",
    justifyContent: "center",
    color: { default: "hsl(var(--muted-foreground))", ":hover": "hsl(var(--foreground))" },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
  },
  /**
   * flex-1 relative
   */
  s_792: {
    flex: "1 1 0%",
    position: "relative",
  },
  /**
   * absolute top-3 right-3 z-20 flex items-center gap-1.5
   */
  s_793: {
    position: "absolute",
    top: "0.75rem",
    right: "0.75rem",
    zIndex: 20,
    display: "flex",
    alignItems: "center",
    gap: "0.375rem",
  },
  /**
   * inline-flex size-8 items-center justify-center rounded-md border border-border
   * bg-background/95 backdrop-blur shadow-sm text-muted-foreground hover:text-foreground
   * transition-colors
   */
  s_794: {
    display: "inline-flex",
    width: "2rem",
    height: "2rem",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "hsl(var(--border))",
    backgroundColor: "hsl(var(--background) / 0.95)",
    backdropFilter: "blur(8px)",
    boxShadow: "0 1px 2px 0 rgba(0, 0, 0, 0.05)",
    color: { default: "hsl(var(--muted-foreground))", ":hover": "hsl(var(--foreground))" },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
  },
  /**
   * flex rounded-md border border-border bg-background/95 p-0.5 shadow-sm
   */
  s_796: {
    display: "flex",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "hsl(var(--border))",
    backgroundColor: "hsl(var(--background) / 0.95)",
    padding: "0.125rem",
    boxShadow: "0 1px 2px 0 rgba(0, 0, 0, 0.05)",
  },
  /**
   * absolute top-3 left-3 z-20 w-[30rem]
   */
  s_797: {
    position: "absolute",
    top: "0.75rem",
    left: "0.75rem",
    zIndex: 20,
    width: "30rem",
  },
  /**
   * relative w-full h-10 pl-9 pr-3 rounded-md border border-primary/50 bg-background/95
   * backdrop-blur
   * shadow-[0_0_0_1px_hsl(var(--primary)/0.15),0_4px_12px_-2px_hsl(var(--primary)/0.25)] flex
   * items-center text-sm text-foreground/80 hover:border-primary hover:bg-background
   * hover:text-foreground
   * hover:shadow-[0_0_0_1px_hsl(var(--primary)/0.25),0_6px_16px_-2px_hsl(var(--primary)/0.35)]
   * transition
   */
  s_798: {
    position: "relative",
    width: "100%",
    height: "2.5rem",
    paddingLeft: "2.25rem",
    paddingRight: "0.75rem",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: { default: "hsl(var(--primary) / 0.5)", ":hover": "hsl(var(--primary))" },
    backgroundColor: { default: "hsl(var(--background) / 0.95)", ":hover": "hsl(var(--background))" },
    backdropFilter: "blur(8px)",
    boxShadow: { default: "0 0 0 1px hsl(var(--primary)/0.15),0 4px 12px -2px hsl(var(--primary)/0.25)", ":hover": "0 0 0 1px hsl(var(--primary)/0.25),0 6px 16px -2px hsl(var(--primary)/0.35)" },
    display: "flex",
    alignItems: "center",
    fontSize: "0.875rem",
    lineHeight: "1.25rem",
    color: { default: "hsl(var(--foreground) / 0.8)", ":hover": "hsl(var(--foreground))" },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, filter, backdrop-filter",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
  },
  /**
   * pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-primary
   */
  s_799: {
    pointerEvents: "none",
    position: "absolute",
    left: "0.75rem",
    top: "50%",
    width: "1rem",
    height: "1rem",
    transform: "translateY(-50%)",
    color: "hsl(var(--primary))",
  },
  /**
   * mt-1 pl-1 text-[11px] text-muted-foreground
   */
  s_800: {
    marginTop: "0.25rem",
    paddingLeft: "0.25rem",
    fontSize: "11px",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * absolute inset-0
   */
  s_801: {
    position: "absolute",
    inset: "0",
  },
  /**
   * flex flex-col gap-4
   */
  s_802: {
    display: "flex",
    flexDirection: "column",
    gap: "1rem",
  },
  /**
   * text-xs font-semibold uppercase tracking-wider text-muted-foreground
   */
  s_805: {
    fontSize: "0.75rem",
    lineHeight: "1rem",
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * rounded-sm bg-secondary/40 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide
   * text-muted-foreground
   */
  s_806: {
    backgroundColor: "hsl(var(--secondary) / 0.4)",
    paddingInline: "0.375rem",
    paddingBlock: "0.125rem",
    fontSize: "9px",
    fontWeight: 500,
    textTransform: "uppercase",
    letterSpacing: "0.025em",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * flex flex-wrap gap-1.5
   */
  s_807: {
    display: "flex",
    flexWrap: "wrap",
    gap: "0.375rem",
  },
  /**
   * size-3.5 text-green-400
   */
  s_808: {
    width: "0.875rem",
    height: "0.875rem",
    color: "#4ade80",
  },
  /**
   * space-y-3
   */
  s_810: {
    display: "flex",
    flexDirection: "column",
    gap: "0.75rem",
  },
  /**
   * rounded border border-border p-3
   */
  s_811: {
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "hsl(var(--border))",
    padding: "0.75rem",
  },
  /**
   * flex items-start justify-between gap-3
   */
  s_812: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: "0.75rem",
  },
  /**
   * text-xs font-medium text-foreground
   */
  s_814: {
    fontSize: "0.75rem",
    lineHeight: "1rem",
    fontWeight: 500,
    color: "hsl(var(--foreground))",
  },
  /**
   * mt-1 text-[11px] leading-4 text-muted-foreground
   */
  s_815: {
    marginTop: "0.25rem",
    fontSize: "11px",
    lineHeight: "1rem",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * mt-2 text-xs text-muted-foreground
   */
  s_818: {
    marginTop: "0.5rem",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * mt-2 space-y-1.5
   */
  s_819: {
    display: "flex",
    flexDirection: "column",
    gap: "0.375rem",
    marginTop: "0.5rem",
  },
  /**
   * flex items-center justify-between gap-3 rounded border border-border p-2
   */
  s_820: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "0.75rem",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "hsl(var(--border))",
    padding: "0.5rem",
  },
  /**
   * shrink-0 rounded border border-border px-2.5 py-1 text-[11px] font-medium text-foreground
   * transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60
   */
  s_824: {
    flexShrink: 0,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "hsl(var(--border))",
    paddingInline: "0.625rem",
    paddingBlock: "0.25rem",
    fontSize: "11px",
    fontWeight: 500,
    color: "hsl(var(--foreground))",
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
    backgroundColor: { default: null, ":hover": "hsl(var(--muted))" },
    cursor: { default: null, ":disabled": "not-allowed" },
    opacity: { default: null, ":disabled": 0.6 },
  },
  /**
   * p-3 rounded-lg bg-secondary/50 border border-border hover:bg-secondary/70
   * transition-colors
   */
  s_825: {
    padding: "0.75rem",
    backgroundColor: { default: "hsl(var(--secondary) / 0.5)", ":hover": "hsl(var(--secondary) / 0.7)" },
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "hsl(var(--border))",
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
  },
  /**
   * flex items-center gap-2 text-muted-foreground mb-2
   */
  s_826: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    color: "hsl(var(--muted-foreground))",
    marginBottom: "0.5rem",
  },
  /**
   * text-xs font-medium
   */
  s_827: {
    fontSize: "0.75rem",
    lineHeight: "1rem",
    fontWeight: 500,
  },
  /**
   * text-lg font-semibold text-foreground font-mono
   */
  s_828: {
    fontSize: "1.125rem",
    lineHeight: "1.75rem",
    fontWeight: 600,
    color: "hsl(var(--foreground))",
    fontFamily: "var(--font-mono), ui-monospace, monospace",
  },
  /**
   * text-xs leading-relaxed
   */
  s_829: {
    fontSize: "0.75rem",
    lineHeight: 1.625,
  },
  /**
   * flex items-start justify-between gap-2
   */
  s_831: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: "0.5rem",
  },
  /**
   * text-sm font-semibold leading-snug
   */
  s_833: {
    fontSize: "0.875rem",
    lineHeight: 1.375,
    fontWeight: 600,
  },
  /**
   * mt-0.5 text-[11px] text-muted-foreground
   */
  s_834: {
    marginTop: "0.125rem",
    fontSize: "11px",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * mt-1
   */
  s_835: {
    marginTop: "0.25rem",
  },
  /**
   * mt-0.5 text-[10px] text-muted-foreground/60 hover:text-muted-foreground transition-colors
   */
  s_836: {
    marginTop: "0.125rem",
    fontSize: "10px",
    color: { default: "hsl(var(--muted-foreground) / 0.6)", ":hover": "hsl(var(--muted-foreground))" },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
  },
  /**
   * grid grid-cols-3 gap-2.5
   */
  s_841: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: "0.625rem",
  },
  /**
   * size-4
   */
  s_847: {
    width: "1rem",
    height: "1rem",
  },
  /**
   * flex items-center justify-between mb-2
   */
  s_848: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: "0.5rem",
  },
  /**
   * text-[10px] font-medium uppercase tracking-wider text-muted-foreground
   */
  s_849: {
    fontSize: "10px",
    fontWeight: 500,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * flex items-center gap-0.5 text-[10px] text-primary hover:text-primary/80
   * transition-colors
   */
  s_850: {
    display: "flex",
    alignItems: "center",
    gap: "0.125rem",
    fontSize: "10px",
    color: { default: "hsl(var(--primary))", ":hover": "hsl(var(--primary) / 0.8)" },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
  },
  /**
   * flex flex-wrap gap-1.5 mb-3
   */
  s_852: {
    display: "flex",
    flexWrap: "wrap",
    gap: "0.375rem",
    marginBottom: "0.75rem",
  },
  /**
   * inline-flex items-center gap-1 rounded-full bg-muted/50 px-2 py-0.5 text-[10px]
   * text-muted-foreground
   */
  s_853: {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.25rem",
    backgroundColor: "hsl(var(--muted) / 0.5)",
    paddingInline: "0.5rem",
    paddingBlock: "0.125rem",
    fontSize: "10px",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * inline-flex items-center rounded-full bg-muted/50 px-2 py-0.5 text-[10px]
   * text-muted-foreground
   */
  s_855: {
    display: "inline-flex",
    alignItems: "center",
    backgroundColor: "hsl(var(--muted) / 0.5)",
    paddingInline: "0.5rem",
    paddingBlock: "0.125rem",
    fontSize: "10px",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * inline-flex items-center rounded-full bg-emerald-950/40 px-2 py-0.5 text-[10px]
   * text-emerald-400 border border-emerald-700/30
   */
  s_856: {
    display: "inline-flex",
    alignItems: "center",
    backgroundColor: "rgba(2, 44, 34, 0.4)",
    paddingInline: "0.5rem",
    paddingBlock: "0.125rem",
    fontSize: "10px",
    color: "#34d399",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "rgba(4, 120, 87, 0.3)",
  },
  /**
   * grid grid-cols-2 gap-2
   */
  s_857: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: "0.5rem",
  },
  /**
   * min-w-0 rounded-lg border border-border bg-muted/20 px-3 py-2.5 text-left
   * transition-colors hover:bg-muted/40
   */
  s_858: {
    minWidth: 0,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "hsl(var(--border))",
    backgroundColor: { default: "hsl(var(--muted) / 0.2)", ":hover": "hsl(var(--muted) / 0.4)" },
    paddingInline: "0.75rem",
    paddingBlock: "0.625rem",
    textAlign: "left",
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
  },
  /**
   * truncate text-xs font-medium text-foreground
   */
  s_861: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    fontWeight: 500,
    color: "hsl(var(--foreground))",
  },
  /**
   * mt-0.5 text-[10px] text-muted-foreground/70
   */
  s_862: {
    marginTop: "0.125rem",
    fontSize: "10px",
    color: "hsl(var(--muted-foreground) / 0.7)",
  },
  /**
   * max-w-xs space-y-1 text-xs leading-relaxed
   */
  s_863: {
    display: "flex",
    flexDirection: "column",
    gap: "0.25rem",
    maxWidth: "20rem",
    fontSize: "0.75rem",
    lineHeight: 1.625,
  },
  /**
   * font-semibold
   */
  s_865: {
    fontWeight: 600,
  },
  /**
   * mt-2 flex items-center gap-0.5 text-[10px] text-primary hover:text-primary/80
   * transition-colors
   */
  s_867: {
    marginTop: "0.5rem",
    display: "flex",
    alignItems: "center",
    gap: "0.125rem",
    fontSize: "10px",
    color: { default: "hsl(var(--primary))", ":hover": "hsl(var(--primary) / 0.8)" },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
  },
  /**
   * flex flex-wrap items-center gap-1 pl-2 pt-0.5 text-[10px] text-muted-foreground
   */
  s_868: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "0.25rem",
    paddingLeft: "0.5rem",
    paddingTop: "0.125rem",
    fontSize: "10px",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * font-medium uppercase tracking-wide text-muted-foreground/80
   */
  s_869: {
    fontWeight: 500,
    textTransform: "uppercase",
    letterSpacing: "0.025em",
    color: "hsl(var(--muted-foreground) / 0.8)",
  },
  /**
   * size-3 text-muted-foreground/60
   */
  s_871: {
    width: "0.75rem",
    height: "0.75rem",
    color: "hsl(var(--muted-foreground) / 0.6)",
  },
  /**
   * size-2.5 text-muted-foreground/60
   */
  s_872: {
    width: "0.625rem",
    height: "0.625rem",
    color: "hsl(var(--muted-foreground) / 0.6)",
  },
  /**
   * size-2.5 shrink-0
   */
  s_873: {
    width: "0.625rem",
    height: "0.625rem",
    flexShrink: 0,
  },
  /**
   * max-w-[200px] truncate font-mono text-muted-foreground/90
   */
  s_874: {
    maxWidth: "200px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontFamily: "var(--font-mono), ui-monospace, monospace",
    color: "hsl(var(--muted-foreground) / 0.9)",
  },
  /**
   * font-mono text-muted-foreground/80
   */
  s_875: {
    fontFamily: "var(--font-mono), ui-monospace, monospace",
    color: "hsl(var(--muted-foreground) / 0.8)",
  },
  /**
   * size-2.5 shrink-0 text-muted-foreground/60
   */
  s_876: {
    width: "0.625rem",
    height: "0.625rem",
    flexShrink: 0,
    color: "hsl(var(--muted-foreground) / 0.6)",
  },
  /**
   * flex h-full min-h-0 flex-col
   */
  s_877: {
    display: "flex",
    height: "100%",
    minHeight: 0,
    flexDirection: "column",
  },
  /**
   * shrink-0 space-y-4 px-4 pt-4 pb-3
   */
  s_878: {
    display: "flex",
    flexDirection: "column",
    gap: "1rem",
    flexShrink: 0,
    paddingInline: "1rem",
    paddingTop: "1rem",
    paddingBottom: "0.75rem",
  },
  /**
   * space-y-1
   */
  s_879: {
    display: "flex",
    flexDirection: "column",
    gap: "0.25rem",
  },
  /**
   * text-sm font-semibold text-foreground
   */
  s_880: {
    fontSize: "0.875rem",
    lineHeight: "1.25rem",
    fontWeight: 600,
    color: "hsl(var(--foreground))",
  },
  /**
   * text-xs leading-relaxed text-muted-foreground
   */
  s_881: {
    fontSize: "0.75rem",
    lineHeight: 1.625,
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * min-h-0 flex-1 overflow-y-auto px-4 pb-4
   */
  s_882: {
    minHeight: 0,
    flex: "1 1 0%",
    overflowY: "auto",
    paddingInline: "1rem",
    paddingBottom: "1rem",
  },
  /**
   * flex h-full flex-col space-y-3 p-4
   */
  s_883: {
    display: "flex",
    height: "100%",
    flexDirection: "column",
    gap: "0.75rem",
    padding: "1rem",
  },
  /**
   * space-y-2.5
   */
  s_884: {
    display: "flex",
    flexDirection: "column",
    gap: "0.625rem",
  },
  /**
   * space-y-2 rounded-md border border-dashed border-border/70 bg-secondary/20 p-2
   * text-[11px]
   */
  s_885: {
    display: "flex",
    flexDirection: "column",
    gap: "0.5rem",
    borderWidth: "1px",
    borderStyle: "dashed",
    borderColor: "hsl(var(--border) / 0.7)",
    backgroundColor: "hsl(var(--secondary) / 0.2)",
    padding: "0.5rem",
    fontSize: "11px",
  },
  /**
   * font-semibold text-foreground
   */
  s_887: {
    fontWeight: 600,
    color: "hsl(var(--foreground))",
  },
  /**
   * px-1.5 py-0 font-mono text-[10px]
   */
  s_893: {
    paddingInline: "0.375rem",
    paddingBlock: "0",
    fontFamily: "var(--font-mono), ui-monospace, monospace",
    fontSize: "10px",
  },
  /**
   * flex flex-wrap items-center gap-1 px-1
   */
  s_894: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "0.25rem",
    paddingInline: "0.25rem",
  },
  /**
   * inline-flex items-center overflow-hidden rounded-full border border-primary/40
   * bg-primary/10 text-[11px] font-normal
   */
  s_897: {
    display: "inline-flex",
    alignItems: "center",
    overflow: "hidden",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "hsl(var(--primary) / 0.4)",
    backgroundColor: "hsl(var(--primary) / 0.1)",
    fontSize: "11px",
    fontWeight: 400,
  },
  /**
   * px-1.5 py-0 text-primary
   */
  s_898: {
    paddingInline: "0.375rem",
    paddingBlock: "0",
    color: "hsl(var(--primary))",
  },
  /**
   * px-1.5 py-0 text-foreground bg-primary/10
   */
  s_899: {
    paddingInline: "0.375rem",
    paddingBlock: "0",
    color: "hsl(var(--foreground))",
    backgroundColor: "hsl(var(--primary) / 0.1)",
  },
  /**
   * border-transparent bg-secondary/50 px-1.5 py-0 text-[11px] font-normal text-foreground
   */
  s_900: {
    borderColor: "transparent",
    backgroundColor: "hsl(var(--secondary) / 0.5)",
    paddingInline: "0.375rem",
    paddingBlock: "0",
    fontSize: "11px",
    fontWeight: 400,
    color: "hsl(var(--foreground))",
  },
  /**
   * border-dashed bg-transparent px-1.5 py-0 text-[11px] font-normal text-muted-foreground
   */
  s_901: {
    borderStyle: "dashed",
    backgroundColor: "transparent",
    paddingInline: "0.375rem",
    paddingBlock: "0",
    fontSize: "11px",
    fontWeight: 400,
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * flex min-h-0 flex-1 flex-col overflow-hidden border-t border-border pt-2
   */
  s_902: {
    display: "flex",
    minHeight: 0,
    flex: "1 1 0%",
    flexDirection: "column",
    overflow: "hidden",
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderColor: "hsl(var(--border))",
    paddingTop: "0.5rem",
  },
  /**
   * mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider
   * text-muted-foreground
   */
  s_903: {
    marginBottom: "0.5rem",
    display: "flex",
    alignItems: "center",
    gap: "0.375rem",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    fontWeight: 500,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * mb-2 flex items-center justify-between text-xs font-medium uppercase tracking-wider
   * text-muted-foreground
   */
  s_905: {
    marginBottom: "0.5rem",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    fontWeight: 500,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * flex-1 overflow-y-auto
   */
  s_906: {
    flex: "1 1 0%",
    overflowY: "auto",
  },
  /**
   * space-y-2 pr-2
   */
  s_907: {
    display: "flex",
    flexDirection: "column",
    gap: "0.5rem",
    paddingRight: "0.5rem",
  },
  /**
   * flex items-center gap-2
   */
  s_908: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
  },
  /**
   * size-3.5 shrink-0 text-muted-foreground
   */
  s_909: {
    width: "0.875rem",
    height: "0.875rem",
    flexShrink: 0,
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * min-w-0 flex-1 truncate text-sm font-semibold text-foreground
   */
  s_910: {
    minWidth: 0,
    flex: "1 1 0%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "0.875rem",
    lineHeight: "1.25rem",
    fontWeight: 600,
    color: "hsl(var(--foreground))",
  },
  /**
   * size-4 shrink-0 text-primary
   */
  s_911: {
    width: "1rem",
    height: "1rem",
    flexShrink: 0,
    color: "hsl(var(--primary))",
  },
  /**
   * mt-1.5 grid grid-cols-3 gap-2 text-[11px]
   */
  s_912: {
    marginTop: "0.375rem",
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: "0.5rem",
    fontSize: "11px",
  },
  /**
   * truncate font-medium text-foreground
   */
  s_918: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontWeight: 500,
    color: "hsl(var(--foreground))",
  },
  /**
   * min-w-0
   */
  s_919: {
    minWidth: 0,
  },
  /**
   * truncate text-muted-foreground
   */
  s_920: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * truncate font-medium text-emerald-400
   */
  s_921: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontWeight: 500,
    color: "#34d399",
  },
  /**
   * mt-1.5 flex flex-wrap gap-1
   */
  s_922: {
    marginTop: "0.375rem",
    display: "flex",
    flexWrap: "wrap",
    gap: "0.25rem",
  },
  /**
   * border-transparent bg-secondary/50 px-2 py-0.5 text-[9px] text-foreground
   */
  s_923: {
    borderColor: "transparent",
    backgroundColor: "hsl(var(--secondary) / 0.5)",
    paddingInline: "0.5rem",
    paddingBlock: "0.125rem",
    fontSize: "9px",
    color: "hsl(var(--foreground))",
  },
  /**
   * mt-1.5 space-y-1
   */
  s_924: {
    display: "flex",
    flexDirection: "column",
    gap: "0.25rem",
    marginTop: "0.375rem",
  },
  /**
   * space-y-0.5
   */
  s_925: {
    display: "flex",
    flexDirection: "column",
    gap: "0.125rem",
  },
  /**
   * flex items-center gap-1 text-primary
   */
  s_926: {
    display: "flex",
    alignItems: "center",
    gap: "0.25rem",
    color: "hsl(var(--primary))",
  },
  /**
   * size-3
   */
  s_927: {
    width: "0.75rem",
    height: "0.75rem",
  },
  /**
   * font-medium
   */
  s_928: {
    fontWeight: 500,
  },
  /**
   * size-3 shrink-0 text-muted-foreground
   */
  s_929: {
    width: "0.75rem",
    height: "0.75rem",
    flexShrink: 0,
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * min-w-0 flex-1 truncate text-foreground
   */
  s_930: {
    minWidth: 0,
    flex: "1 1 0%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: "hsl(var(--foreground))",
  },
  /**
   * shrink-0 text-muted-foreground
   */
  s_931: {
    flexShrink: 0,
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * flex flex-wrap items-center gap-1 pl-2 text-[10px] text-muted-foreground/80
   */
  s_932: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "0.25rem",
    paddingLeft: "0.5rem",
    fontSize: "10px",
    color: "hsl(var(--muted-foreground) / 0.8)",
  },
  /**
   * mt-1.5 space-y-0.5 text-[10px] text-muted-foreground
   */
  s_936: {
    display: "flex",
    flexDirection: "column",
    gap: "0.125rem",
    marginTop: "0.375rem",
    fontSize: "10px",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * flex flex-wrap items-center gap-1
   */
  s_937: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "0.25rem",
  },
  /**
   * font-mono
   */
  s_940: {
    fontFamily: "var(--font-mono), ui-monospace, monospace",
  },
  /**
   * truncate
   */
  s_941: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  /**
   * mt-2 flex items-center justify-end gap-1
   */
  s_942: {
    marginTop: "0.5rem",
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: "0.25rem",
  },
  /**
   * size-7
   */
  s_946: {
    width: "1.75rem",
    height: "1.75rem",
  },
  /**
   * text-xs
   */
  s_948: {
    fontSize: "0.75rem",
    lineHeight: "1rem",
  },
  /**
   * rounded-lg border border-dashed border-border px-3 py-6 text-center
   */
  s_949: {
    borderWidth: "1px",
    borderStyle: "dashed",
    borderColor: "hsl(var(--border))",
    paddingInline: "0.75rem",
    paddingBlock: "1.5rem",
    textAlign: "center",
  },
  /**
   * flex items-center justify-center gap-1.5 text-xs text-muted-foreground
   */
  s_950: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "0.375rem",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * mt-1 text-xs text-muted-foreground
   */
  s_953: {
    marginTop: "0.25rem",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * mt-3 flex flex-col items-center gap-1.5
   */
  s_954: {
    marginTop: "0.75rem",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "0.375rem",
  },
  /**
   * text-[11px] text-muted-foreground
   */
  s_955: {
    fontSize: "11px",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * flex flex-wrap justify-center gap-1.5
   */
  s_956: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: "0.375rem",
  },
  /**
   * rounded-md border border-border bg-secondary/30 px-2.5 py-1 text-xs text-foreground
   * transition-colors hover:border-primary/40 hover:bg-primary/10
   */
  s_957: {
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: { default: "hsl(var(--border))", ":hover": "hsl(var(--primary) / 0.4)" },
    backgroundColor: { default: "hsl(var(--secondary) / 0.3)", ":hover": "hsl(var(--primary) / 0.1)" },
    paddingInline: "0.625rem",
    paddingBlock: "0.25rem",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    color: "hsl(var(--foreground))",
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
  },
  /**
   * mb-2.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground
   */
  s_959: {
    marginBottom: "0.625rem",
    fontSize: "10px",
    fontWeight: 500,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * space-y-2
   */
  s_960: {
    display: "flex",
    flexDirection: "column",
    gap: "0.5rem",
  },
  /**
   * flex items-center gap-1
   */
  s_961: {
    display: "flex",
    alignItems: "center",
    gap: "0.25rem",
  },
  /**
   * flex flex-1 items-center gap-1.5 text-xs font-semibold uppercase tracking-wide
   * text-muted-foreground transition-colors hover:text-foreground
   */
  s_962: {
    display: "flex",
    flex: "1 1 0%",
    alignItems: "center",
    gap: "0.375rem",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.025em",
    color: { default: "hsl(var(--muted-foreground))", ":hover": "hsl(var(--foreground))" },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
  },
  /**
   * rounded-full bg-orange-950/60 px-1.5 py-px text-[10px] font-semibold text-orange-300
   */
  s_965: {
    backgroundColor: "rgba(67, 20, 7, 0.6)",
    paddingInline: "0.375rem",
    paddingBlock: "1px",
    fontSize: "10px",
    fontWeight: 600,
    color: "#fdba74",
  },
  /**
   * flex items-center gap-0.5 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] text-primary
   * border border-primary/20 hover:bg-primary/20 transition-colors
   */
  s_966: {
    display: "flex",
    alignItems: "center",
    gap: "0.125rem",
    backgroundColor: { default: "hsl(var(--primary) / 0.1)", ":hover": "hsl(var(--primary) / 0.2)" },
    paddingInline: "0.5rem",
    paddingBlock: "0.125rem",
    fontSize: "10px",
    color: "hsl(var(--primary))",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "hsl(var(--primary) / 0.2)",
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
  },
  /**
   * size-2.5
   */
  s_967: {
    width: "0.625rem",
    height: "0.625rem",
  },
  /**
   * mt-2 space-y-2
   */
  s_968: {
    display: "flex",
    flexDirection: "column",
    gap: "0.5rem",
    marginTop: "0.5rem",
  },
  /**
   * flex flex-wrap gap-1
   */
  s_969: {
    display: "flex",
    flexWrap: "wrap",
    gap: "0.25rem",
  },
  /**
   * text-muted-foreground/60
   */
  s_970: {
    color: "hsl(var(--muted-foreground) / 0.6)",
  },
  /**
   * flex items-center gap-1.5 text-xs text-muted-foreground
   */
  s_971: {
    display: "flex",
    alignItems: "center",
    gap: "0.375rem",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * size-3 animate-spin
   */
  s_972: {
    width: "0.75rem",
    height: "0.75rem",
    animationName: spin,
    animationDuration: "1s",
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
  },
  /**
   * text-xs text-muted-foreground
   */
  s_973: {
    fontSize: "0.75rem",
    lineHeight: "1rem",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * rounded-lg border border-border bg-muted/10
   */
  s_975: {
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "hsl(var(--border))",
    backgroundColor: "hsl(var(--muted) / 0.1)",
  },
  /**
   * flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-muted/20
   */
  s_976: {
    display: "flex",
    width: "100%",
    alignItems: "center",
    gap: "0.5rem",
    paddingInline: "0.75rem",
    paddingBlock: "0.625rem",
    textAlign: "left",
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
    backgroundColor: { default: null, ":hover": "hsl(var(--muted) / 0.2)" },
  },
  /**
   * size-3.5 text-primary shrink-0
   */
  s_977: {
    width: "0.875rem",
    height: "0.875rem",
    color: "hsl(var(--primary))",
    flexShrink: 0,
  },
  /**
   * flex-1 text-xs font-medium text-foreground
   */
  s_978: {
    flex: "1 1 0%",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    fontWeight: 500,
    color: "hsl(var(--foreground))",
  },
  /**
   * inline-flex items-center gap-1 rounded-full bg-muted/50 px-1.5 py-px text-[10px]
   * text-muted-foreground
   */
  s_979: {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.25rem",
    backgroundColor: "hsl(var(--muted) / 0.5)",
    paddingInline: "0.375rem",
    paddingBlock: "1px",
    fontSize: "10px",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * size-2.5 animate-spin
   */
  s_980: {
    width: "0.625rem",
    height: "0.625rem",
    animationName: spin,
    animationDuration: "1s",
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
  },
  /**
   * rounded-full bg-muted/50 px-1.5 py-px text-[10px] text-muted-foreground
   */
  s_981: {
    backgroundColor: "hsl(var(--muted) / 0.5)",
    paddingInline: "0.375rem",
    paddingBlock: "1px",
    fontSize: "10px",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * border-t border-border px-3 py-2.5 space-y-2.5
   *
   * Block flow, not a flex column: the first child is a `TooltipTrigger`
   * button, an inline-level box, and blockifying it would both stretch it and
   * drop its line-box leading. The sibling margin sits on the children as
   * `stackY2_5` instead.
   */
  s_982: {
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderColor: "hsl(var(--border))",
    paddingInline: "0.75rem",
    paddingBlock: "0.625rem",
  },
  /**
   * text-left text-[11px] text-muted-foreground leading-relaxed cursor-help underline
   * decoration-dotted underline-offset-2
   */
  s_983: {
    textAlign: "left",
    fontSize: "11px",
    color: "hsl(var(--muted-foreground))",
    lineHeight: 1.625,
    cursor: "help",
    textDecorationLine: "underline",
    textDecorationStyle: "dotted",
    textUnderlineOffset: "2px",
  },
  /**
   * max-w-xs whitespace-pre-line text-xs leading-relaxed
   */
  s_984: {
    maxWidth: "20rem",
    whiteSpace: "pre-line",
    fontSize: "0.75rem",
    lineHeight: 1.625,
  },
  /**
   * text-[11px] text-muted-foreground leading-relaxed
   */
  s_985: {
    fontSize: "11px",
    color: "hsl(var(--muted-foreground))",
    lineHeight: 1.625,
  },
  /**
   * space-y-1.5
   */
  s_986: {
    display: "flex",
    flexDirection: "column",
    gap: "0.375rem",
  },
  /**
   * relative
   */
  s_987: {
    position: "relative",
  },
  /**
   * pointer-events-none absolute left-3 top-1/2 z-10 size-4 -translate-y-1/2
   * text-muted-foreground
   */
  s_988: {
    pointerEvents: "none",
    position: "absolute",
    left: "0.75rem",
    top: "50%",
    zIndex: 10,
    width: "1rem",
    height: "1rem",
    transform: "translateY(-50%)",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * h-10 rounded-md border-border bg-muted/30 pl-9 pr-9 text-sm
   */
  s_989: {
    height: "2.5rem",
    borderColor: "hsl(var(--border))",
    backgroundColor: "hsl(var(--muted) / 0.3)",
    paddingLeft: "2.25rem",
    paddingRight: "2.25rem",
    fontSize: "0.875rem",
    lineHeight: "1.25rem",
  },
  /**
   * absolute right-3 top-1/2 z-10 -translate-y-1/2 text-muted-foreground transition-colors
   * hover:text-foreground
   */
  s_990: {
    position: "absolute",
    right: "0.75rem",
    top: "50%",
    zIndex: 10,
    transform: "translateY(-50%)",
    color: { default: "hsl(var(--muted-foreground))", ":hover": "hsl(var(--foreground))" },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
  },
  /**
   * size-3.5
   */
  s_991: {
    width: "0.875rem",
    height: "0.875rem",
  },
  /**
   * absolute left-0 right-0 top-full z-20 mt-1 rounded-md border border-border bg-popover p-1
   * shadow-md
   */
  s_992: {
    position: "absolute",
    left: "0",
    right: "0",
    top: "100%",
    zIndex: 20,
    marginTop: "0.25rem",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "hsl(var(--border))",
    backgroundColor: "hsl(var(--popover))",
    padding: "0.25rem",
    boxShadow: "0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -2px rgba(0, 0, 0, 0.1)",
  },
  /**
   * space-y-5
   */
  s_993: {
    display: "flex",
    flexDirection: "column",
    gap: "1.25rem",
  },
  /**
   * rounded-lg border border-primary/20 bg-primary/5 p-3
   */
  s_994: {
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "hsl(var(--primary) / 0.2)",
    backgroundColor: "hsl(var(--primary) / 0.05)",
    padding: "0.75rem",
  },
  /**
   * flex items-center justify-center py-12
   */
  s_995: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    paddingBlock: "3rem",
  },
  /**
   * size-5 text-muted-foreground animate-spin
   */
  s_996: {
    width: "1.25rem",
    height: "1.25rem",
    color: "hsl(var(--muted-foreground))",
    animationName: spin,
    animationDuration: "1s",
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
  },
  /**
   * sr-only
   */
  s_997: {
    position: "absolute",
    width: "1px",
    height: "1px",
    padding: 0,
    margin: "-1px",
    overflow: "hidden",
    clip: "rect(0, 0, 0, 0)",
    whiteSpace: "nowrap",
    borderWidth: 0,
  },
  /**
   * flex flex-col items-center justify-center py-12 text-center
   */
  s_1003: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    paddingBlock: "3rem",
    textAlign: "center",
  },
  /**
   * flex h-12 w-12 items-center justify-center rounded-xl bg-muted/50 mb-3
   */
  s_1004: {
    display: "flex",
    height: "3rem",
    width: "3rem",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "hsl(var(--muted) / 0.5)",
    marginBottom: "0.75rem",
  },
  /**
   * text-muted-foreground
   */
  s_1005: {
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * text-sm font-medium text-foreground
   */
  s_1006: {
    fontSize: "0.875rem",
    lineHeight: "1.25rem",
    fontWeight: 500,
    color: "hsl(var(--foreground))",
  },
  /**
   * mt-1 text-xs text-muted-foreground max-w-[240px]
   */
  s_1007: {
    marginTop: "0.25rem",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    color: "hsl(var(--muted-foreground))",
    maxWidth: "240px",
  },

  // ---------------------------------------------------------------------------
  // Compositions that were still `cn(...)` at the callsite: a base rule plus the
  // branch rules its condition chooses between. `stylex.props` makes the same
  // choice at the callsite, and the later rule wins exactly as the later class
  // did — without a runtime class merge.
  // ---------------------------------------------------------------------------
  /**
   * The disclosure chevron every collapsible section header shares. `size-3 shrink-0
   * transition-transform duration-150`
   */
  chevron: {
    width: "0.75rem",
    height: "0.75rem",
    flexShrink: 0,
    transitionProperty: "transform",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
  },
  /**
   * The nested-layer chevron in MapLayersSection, which is not a flex item and so never
   * carried `shrink-0`. `size-3 text-muted-foreground transition-transform duration-150`
   */
  chevronMuted: {
    width: "0.75rem",
    height: "0.75rem",
    color: "hsl(var(--muted-foreground))",
    transitionProperty: "transform",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
  },
  /**
   * The muted chevron where it does sit in a flex row. `size-3 shrink-0 text-muted-foreground
   * transition-transform duration-150`
   */
  chevronMutedShrink: {
    width: "0.75rem",
    height: "0.75rem",
    flexShrink: 0,
    color: "hsl(var(--muted-foreground))",
    transitionProperty: "transform",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
  },
  /**
   * The larger disclosure chevron used by the inspector and the add/edit forms. `size-3.5
   * shrink-0 transition-transform duration-150`
   */
  chevronLg: {
    width: "0.875rem",
    height: "0.875rem",
    flexShrink: 0,
    transitionProperty: "transform",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
  },
  /**
   * OverviewTab's family-list chevron. `size-3 transition-transform`
   */
  chevronBare: {
    width: "0.75rem",
    height: "0.75rem",
    transitionProperty: "transform",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
  },
  /**
   * Open state for a disclosure chevron. `rotate-90`
   */
  rotate90: {
    transform: "rotate(90deg)",
  },
  /**
   * Closed state for the chevrons that point down when open. `-rotate-90`
   */
  rotateMinus90: {
    transform: "rotate(-90deg)",
  },
  /**
   * Leading icon in a MapDetailHeader menu action. `mr-2 size-3.5`
   */
  headerActionIcon: {
    marginRight: "0.5rem",
    width: "0.875rem",
    height: "0.875rem",
  },
  /**
   * A header action's icon while its job runs. `animate-spin`
   */
  spinning: {
    animationName: spin,
    animationDuration: "1s",
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
  },
  /**
   * The thumbnail action's icon while it regenerates. `animate-pulse`
   */
  pulsing: {
    animationName: pulse,
    animationDuration: "2s",
    animationTimingFunction: "cubic-bezier(0.4, 0, 0.6, 1)",
    animationIterationCount: "infinite",
  },
  /**
   * A map row in the switcher dropdown. `flex w-full items-center gap-2 px-3 py-2 text-left
   * transition-colors`
   */
  switcherItem: {
    display: "flex",
    width: "100%",
    alignItems: "center",
    gap: "0.5rem",
    paddingInline: "0.75rem",
    paddingBlock: "0.5rem",
    textAlign: "left",
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
  },
  /**
   * The row for the map already open. `bg-primary/5 text-primary`
   */
  switcherItemCurrent: {
    backgroundColor: "hsl(var(--primary) / 0.05)",
    color: "hsl(var(--primary))",
  },
  /**
   * A row that would navigate away. `text-foreground hover:bg-muted/50`
   */
  switcherItemOther: {
    color: "hsl(var(--foreground))",
    backgroundColor: { default: null, ":hover": "hsl(var(--muted) / 0.5)" },
  },
  /**
   * The map name in a switcher row. `text-xs truncate`
   */
  switcherLabel: {
    fontSize: "0.75rem",
    lineHeight: "1rem",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  /**
   * The current map's name, weighted. `font-medium`
   */
  switcherLabelCurrent: {
    fontWeight: 500,
  },
  /**
   * The copy-to-clipboard affordance beside a JSON readout. `inline-flex shrink-0
   * items-center justify-center rounded p-1 text-muted-foreground transition-colors
   * hover:text-foreground hover:bg-muted/40 disabled:opacity-40 disabled:pointer-events-none`
   */
  copyJsonButton: {
    display: "inline-flex",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    padding: "0.25rem",
    color: { default: "hsl(var(--muted-foreground))", ":hover": "hsl(var(--foreground))" },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
    backgroundColor: { default: null, ":hover": "hsl(var(--muted) / 0.4)" },
    opacity: { default: null, ":disabled": 0.4 },
    pointerEvents: { default: null, ":disabled": "none" },
  },
  /**
   * A layer filter chip in the insights explorer. `rounded-full px-2 py-0.5 text-[10px]
   * border transition-colors`
   */
  insightChip: {
    paddingInline: "0.5rem",
    paddingBlock: "0.125rem",
    fontSize: "10px",
    borderWidth: "1px",
    borderStyle: "solid",
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
  },
  /**
   * The selected filter chip. `bg-primary/15 text-primary border-primary/30`
   */
  insightChipActive: {
    backgroundColor: "hsl(var(--primary) / 0.15)",
    color: "hsl(var(--primary))",
    borderColor: "hsl(var(--primary) / 0.3)",
  },
  /**
   * An unselected filter chip. `bg-muted/30 text-muted-foreground border-border
   * hover:bg-muted/50`
   */
  insightChipIdle: {
    backgroundColor: { default: "hsl(var(--muted) / 0.3)", ":hover": "hsl(var(--muted) / 0.5)" },
    color: "hsl(var(--muted-foreground))",
    borderColor: "hsl(var(--border))",
  },
  /**
   * The map description paragraph. `text-xs leading-relaxed text-muted-foreground`
   */
  overviewDescription: {
    fontSize: "0.75rem",
    lineHeight: 1.625,
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * The collapsed description, held to two lines. `line-clamp-2`
   */
  clamp2: {
    overflow: "hidden",
    display: "-webkit-box",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: 2,
  },
  /**
   * An example query pill. `rounded-full border px-2.5 py-1 text-xs transition-colors`
   */
  examplePill: {
    borderWidth: "1px",
    borderStyle: "solid",
    paddingInline: "0.625rem",
    paddingBlock: "0.25rem",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
  },
  /**
   * An example the current index can answer. `border-border bg-secondary/30 text-foreground
   * hover:border-primary/40 hover:bg-primary/10`
   */
  examplePillAvailable: {
    borderColor: { default: "hsl(var(--border))", ":hover": "hsl(var(--primary) / 0.4)" },
    backgroundColor: { default: "hsl(var(--secondary) / 0.3)", ":hover": "hsl(var(--primary) / 0.1)" },
    color: "hsl(var(--foreground))",
  },
  /**
   * An example the current index cannot answer. `cursor-not-allowed border-dashed
   * border-border/60 bg-transparent text-muted-foreground/70`
   */
  examplePillUnavailable: {
    cursor: "not-allowed",
    borderStyle: "dashed",
    borderColor: "hsl(var(--border) / 0.6)",
    backgroundColor: "transparent",
    color: "hsl(var(--muted-foreground) / 0.7)",
  },
  /**
   * A typeahead suggestion row. `flex w-full items-center rounded-sm px-2 py-1.5 text-left
   * text-sm text-foreground transition-colors hover:bg-secondary/40`
   */
  suggestion: {
    display: "flex",
    width: "100%",
    alignItems: "center",
    paddingInline: "0.5rem",
    paddingBlock: "0.375rem",
    textAlign: "left",
    fontSize: "0.875rem",
    lineHeight: "1.25rem",
    color: "hsl(var(--foreground))",
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
    backgroundColor: { default: null, ":hover": "hsl(var(--secondary) / 0.4)" },
  },
  /**
   * The keyboard-highlighted suggestion. `bg-secondary/40`
   */
  suggestionHighlighted: {
    backgroundColor: "hsl(var(--secondary) / 0.4)",
  },
  /**
   * A pipeline-step chip on a search result. `flex items-center gap-1 rounded border px-1.5
   * py-0.5 transition-colors`
   */
  stepChip: {
    display: "flex",
    alignItems: "center",
    gap: "0.25rem",
    borderWidth: "1px",
    borderStyle: "solid",
    paddingInline: "0.375rem",
    paddingBlock: "0.125rem",
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
  },
  /**
   * A step chip for the highlighted step. `border-primary/60 bg-primary/15`
   */
  stepChipOn: {
    borderColor: "hsl(var(--primary) / 0.6)",
    backgroundColor: "hsl(var(--primary) / 0.15)",
  },
  /**
   * A step chip for any other step. `border-border/40 bg-muted/40`
   */
  stepChipOff: {
    borderColor: "hsl(var(--border) / 0.4)",
    backgroundColor: "hsl(var(--muted) / 0.4)",
  },
  /**
   * The crosshair button that highlights a result on the map. `flex shrink-0 items-center
   * justify-center rounded transition-colors`
   */
  highlightToggle: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
  },
  /**
   * The compact crosshair button. `size-4`
   */
  highlightToggleXs: {
    width: "1rem",
    height: "1rem",
  },
  /**
   * The default crosshair button. `size-5`
   */
  highlightToggleDefault: {
    width: "1.25rem",
    height: "1.25rem",
  },
  /**
   * A crosshair button already highlighting. `bg-primary/30 text-primary hover:bg-primary/40`
   */
  highlightToggleOn: {
    backgroundColor: { default: "hsl(var(--primary) / 0.3)", ":hover": "hsl(var(--primary) / 0.4)" },
    color: "hsl(var(--primary))",
  },
  /**
   * An idle crosshair button. `text-muted-foreground hover:bg-muted hover:text-foreground`
   */
  highlightToggleOff: {
    color: { default: "hsl(var(--muted-foreground))", ":hover": "hsl(var(--foreground))" },
    backgroundColor: { default: null, ":hover": "hsl(var(--muted))" },
  },
  /**
   * The compact crosshair glyph. `size-2.5 shrink-0`
   */
  highlightIconXs: {
    width: "0.625rem",
    height: "0.625rem",
    flexShrink: 0,
  },
  /**
   * The default crosshair glyph. `size-3 shrink-0`
   */
  highlightIconDefault: {
    width: "0.75rem",
    height: "0.75rem",
    flexShrink: 0,
  },
  /**
   * The per-result debug disclosure. `inline-flex size-5 shrink-0 items-center justify-center
   * rounded-md text-muted-foreground transition-colors hover:bg-secondary/40
   * hover:text-foreground`
   */
  debugToggle: {
    display: "inline-flex",
    width: "1.25rem",
    height: "1.25rem",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    color: { default: "hsl(var(--muted-foreground))", ":hover": "hsl(var(--foreground))" },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
    backgroundColor: { default: null, ":hover": "hsl(var(--secondary) / 0.4)" },
  },
  /**
   * The debug disclosure while its panel is open. `bg-secondary/60 text-foreground`
   */
  debugToggleOn: {
    backgroundColor: "hsl(var(--secondary) / 0.6)",
    color: "hsl(var(--foreground))",
  },
  /**
   * A search result card. `w-full cursor-pointer rounded-lg border px-3 py-2.5 text-left
   * transition-all`
   */
  resultCard: {
    width: "100%",
    cursor: "pointer",
    borderWidth: "1px",
    borderStyle: "solid",
    paddingInline: "0.75rem",
    paddingBlock: "0.625rem",
    textAlign: "left",
    transitionProperty: "all",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
  },
  /**
   * The selected result card. `border-primary/50 bg-primary/10`
   */
  resultCardSelected: {
    borderColor: "hsl(var(--primary) / 0.5)",
    backgroundColor: "hsl(var(--primary) / 0.1)",
  },
  /**
   * An unselected result card. `border-border bg-secondary/20 hover:bg-secondary/40`
   */
  resultCardIdle: {
    borderColor: "hsl(var(--border))",
    backgroundColor: { default: "hsl(var(--secondary) / 0.2)", ":hover": "hsl(var(--secondary) / 0.4)" },
  },
  /**
   * A cross-reference chip inside a result. `flex items-center gap-1.5 rounded-md border px-2
   * py-1 text-[11px] transition-colors`
   */
  refChip: {
    display: "flex",
    alignItems: "center",
    gap: "0.375rem",
    borderWidth: "1px",
    borderStyle: "solid",
    paddingInline: "0.5rem",
    paddingBlock: "0.25rem",
    fontSize: "11px",
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
  },
  /**
   * A cross-reference chip that is highlighted. `border-primary/60 bg-primary/15`
   */
  refChipOn: {
    borderColor: "hsl(var(--primary) / 0.6)",
    backgroundColor: "hsl(var(--primary) / 0.15)",
  },
  /**
   * A cross-reference chip at rest. `border-primary/20 bg-primary/5`
   */
  refChipOff: {
    borderColor: "hsl(var(--primary) / 0.2)",
    backgroundColor: "hsl(var(--primary) / 0.05)",
  },
  /**
   * A map row in the catalog's list rail. `block border-b border-border px-4 py-3
   * transition-colors hover:bg-muted/50`
   */
  catalogRow: {
    display: "block",
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderColor: "hsl(var(--border))",
    paddingInline: "1rem",
    paddingBlock: "0.75rem",
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
    backgroundColor: { default: null, ":hover": "hsl(var(--muted) / 0.5)" },
  },
  /**
   * The row whose marker the pointer is over on the map. `bg-muted/30`
   */
  catalogRowHovered: {
    backgroundColor: "hsl(var(--muted) / 0.3)",
  },
  /**
   * A grid/map view toggle button. `flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs
   * font-medium transition-colors`
   */
  viewToggle: {
    display: "flex",
    alignItems: "center",
    gap: "0.375rem",
    paddingInline: "0.625rem",
    paddingBlock: "0.375rem",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    fontWeight: 500,
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
  },
  /**
   * The view currently shown. `bg-background text-foreground shadow-sm`
   */
  viewToggleActive: {
    backgroundColor: "hsl(var(--background))",
    color: "hsl(var(--foreground))",
    boxShadow: "0 1px 2px 0 rgba(0, 0, 0, 0.05)",
  },
  /**
   * The view not currently shown. `text-muted-foreground hover:text-foreground`
   */
  viewToggleIdle: {
    color: { default: "hsl(var(--muted-foreground))", ":hover": "hsl(var(--foreground))" },
  },
  /**
   * The SUMO traffic toggle over the gallery hero. `inline-flex h-10 items-center gap-2
   * border px-3.5 text-xs font-semibold backdrop-blur-md transition-colors
   * focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044]`
   */
  sumoToggle: {
    display: "inline-flex",
    height: "2.5rem",
    alignItems: "center",
    gap: "0.5rem",
    borderWidth: "1px",
    borderStyle: "solid",
    paddingInline: "0.875rem",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    fontWeight: 600,
    backdropFilter: "blur(12px)",
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
    /*
     * `focus-visible:outline-none` is Tailwind's transparent 2px outline, not
     * `outline: none`: the focus ring above is a box-shadow, which
     * forced-colours mode discards, and this transparent outline is what
     * remains visible there.
     */
    outlineWidth: { default: null, ":focus-visible": "2px" },
    outlineStyle: { default: null, ":focus-visible": "solid" },
    outlineColor: { default: null, ":focus-visible": "transparent" },
    outlineOffset: { default: null, ":focus-visible": "2px" },
    boxShadow: { default: null, ":focus-visible": "0 0 0 2px #E8E044" },
  },
  /**
   * The SUMO toggle with traffic running. `border-[#E8E044]/65 bg-[#E8E044]/14 text-[#E8E044]
   * hover:bg-[#E8E044]/22`
   */
  sumoToggleOn: {
    borderColor: "rgba(232, 224, 68, 0.65)",
    backgroundColor: { default: "rgba(232, 224, 68, 0.14)", ":hover": "rgba(232, 224, 68, 0.22)" },
    color: "#E8E044",
  },
  /**
   * The SUMO toggle at rest. `border-white/20 bg-black/45 text-white/70 hover:border-white/40
   * hover:text-white`
   */
  sumoToggleOff: {
    borderColor: { default: "rgba(255, 255, 255, 0.2)", ":hover": "rgba(255, 255, 255, 0.4)" },
    backgroundColor: "rgba(0, 0, 0, 0.45)",
    color: { default: "rgba(255, 255, 255, 0.7)", ":hover": "#fff" },
  },
  /**
   * The SUMO toggle when the map has no traffic. `cursor-not-allowed opacity-45`
   */
  sumoToggleUnavailable: {
    cursor: "not-allowed",
    opacity: 0.45,
  },
  /**
   * The wrapping quick-stats row on a map card. `flex flex-wrap items-center gap-x-3 gap-y-1
   * text-muted-foreground`
   */
  cardStatsRow: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: "0.75rem",
    rowGap: "0.25rem",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * A quick-stat glyph in the narrow map-view rail. `size-2.5`
   */
  statIconSm: {
    width: "0.625rem",
    height: "0.625rem",
  },
  /**
   * A quick-stat glyph on a full-width card. `size-3`
   */
  statIconMd: {
    width: "0.75rem",
    height: "0.75rem",
  },
  /**
   * Quick-stat type in the narrow rail. `text-[10px]`
   */
  statTextSm: {
    fontSize: "10px",
  },
  /**
   * Quick-stat type on a full-width card. `text-xs`
   */
  statTextMd: {
    fontSize: "0.75rem",
    lineHeight: "1rem",
  },
  /**
   * A capability hint chip. `inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5
   * font-medium transition-colors`
   */
  hintChip: {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.25rem",
    borderWidth: "1px",
    borderStyle: "solid",
    paddingInline: "0.375rem",
    paddingBlock: "0.125rem",
    fontWeight: 500,
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
  },
  /**
   * A capability the map has. `border-primary/30 bg-primary/10 text-primary`
   */
  hintChipActive: {
    borderColor: "hsl(var(--primary) / 0.3)",
    backgroundColor: "hsl(var(--primary) / 0.1)",
    color: "hsl(var(--primary))",
  },
  /**
   * A capability the map lacks. `border-border/50 text-muted-foreground/40`
   */
  hintChipInactive: {
    borderColor: "hsl(var(--border) / 0.5)",
    color: "hsl(var(--muted-foreground) / 0.4)",
  },
  /**
   * A hint chip glyph in the narrow rail. `size-3`
   */
  hintIconSm: {
    width: "0.75rem",
    height: "0.75rem",
  },
  /**
   * A hint chip glyph on a full-width card. `size-3.5`
   */
  hintIconMd: {
    width: "0.875rem",
    height: "0.875rem",
  },
  /**
   * Hint chip type in the narrow rail. `text-[10px]`
   */
  hintTextSm: {
    fontSize: "10px",
  },
  /**
   * Hint chip type on a full-width card. `text-[11px]`
   */
  hintTextMd: {
    fontSize: "11px",
  },
  /**
   * The twin-coverage strength badge. `inline-flex items-center rounded-sm px-1.5 py-px
   * text-[10px] font-medium border`
   */
  strengthBadge: {
    display: "inline-flex",
    alignItems: "center",
    paddingInline: "0.375rem",
    paddingBlock: "1px",
    fontSize: "10px",
    fontWeight: 500,
    borderWidth: "1px",
    borderStyle: "solid",
  },
  /**
   * Strong coverage. The studio fixes `dark` on <html>, so the dark ink is the ink.
   * `bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20`
   */
  strengthStrong: {
    backgroundColor: "rgba(34, 197, 94, 0.1)",
    color: "#4ade80",
    borderColor: "rgba(34, 197, 94, 0.2)",
  },
  /**
   * Moderate coverage. `bg-amber-500/10 text-amber-600 dark:text-amber-400
   * border-amber-500/20`
   */
  strengthModerate: {
    backgroundColor: "rgba(245, 158, 11, 0.1)",
    color: "#fbbf24",
    borderColor: "rgba(245, 158, 11, 0.2)",
  },
  /**
   * Limited coverage. `bg-muted text-muted-foreground border-border`
   */
  strengthLimited: {
    backgroundColor: "hsl(var(--muted))",
    color: "hsl(var(--muted-foreground))",
    borderColor: "hsl(var(--border))",
  },
  /**
   * An inspected map element. `rounded-md border text-left transition-colors`
   */
  elementCard: {
    borderWidth: "1px",
    borderStyle: "solid",
    textAlign: "left",
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
  },
  /**
   * The selected element. `border-primary bg-primary/10`
   */
  elementCardSelected: {
    borderColor: "hsl(var(--primary))",
    backgroundColor: "hsl(var(--primary) / 0.1)",
  },
  /**
   * An unselected element. `border-border bg-muted/20 hover:bg-muted/40`
   */
  elementCardIdle: {
    borderColor: "hsl(var(--border))",
    backgroundColor: { default: "hsl(var(--muted) / 0.2)", ":hover": "hsl(var(--muted) / 0.4)" },
  },
  /**
   * A layer group's checkbox when only some children are on. `opacity-60`
   */
  partiallyEnabled: {
    opacity: 0.6,
  },
  /**
   * A single toggleable layer row. `flex items-center gap-2.5 rounded border border-border
   * bg-muted/20 px-2.5 py-1`
   */
  layerRow: {
    display: "flex",
    alignItems: "center",
    gap: "0.625rem",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "hsl(var(--border))",
    backgroundColor: "hsl(var(--muted) / 0.2)",
    paddingInline: "0.625rem",
    paddingBlock: "0.25rem",
  },
  /**
   * A layer row with nothing to draw. `opacity-40`
   */
  layerRowEmpty: {
    opacity: 0.4,
  },
  /**
   * A lane render-mode button. `px-2 py-0.5 text-[11px] font-medium transition-colors`
   */
  laneModeButton: {
    paddingInline: "0.5rem",
    paddingBlock: "0.125rem",
    fontSize: "11px",
    fontWeight: 500,
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
  },
  /**
   * The active lane render mode. `bg-primary text-primary-foreground`
   */
  laneModeButtonActive: {
    backgroundColor: "hsl(var(--primary))",
    color: "hsl(var(--primary-foreground))",
  },
  /**
   * An inactive lane render mode. `bg-muted/30 text-muted-foreground hover:text-foreground`
   */
  laneModeButtonIdle: {
    backgroundColor: "hsl(var(--muted) / 0.3)",
    color: { default: "hsl(var(--muted-foreground))", ":hover": "hsl(var(--foreground))" },
  },
  /**
   * A twin-fidelity resolution button. `rounded border px-1.5 py-0.5 text-[10px] font-mono`
   */
  resolutionButton: {
    borderWidth: "1px",
    borderStyle: "solid",
    paddingInline: "0.375rem",
    paddingBlock: "0.125rem",
    fontSize: "10px",
    fontFamily: "var(--font-mono), ui-monospace, monospace",
  },
  /**
   * The chosen resolution. `border-primary/60 bg-primary/15 text-foreground`
   */
  resolutionButtonActive: {
    borderColor: "hsl(var(--primary) / 0.6)",
    backgroundColor: "hsl(var(--primary) / 0.15)",
    color: "hsl(var(--foreground))",
  },
  /**
   * An unchosen resolution. `border-border bg-muted/20 text-muted-foreground
   * hover:text-foreground`
   */
  resolutionButtonIdle: {
    borderColor: "hsl(var(--border))",
    backgroundColor: "hsl(var(--muted) / 0.2)",
    color: { default: "hsl(var(--muted-foreground))", ":hover": "hsl(var(--foreground))" },
  },
  /**
   * The scenario tag counter. `rounded-full px-2.5 py-0.5 text-xs font-semibold tabular-nums`
   */
  tagCount: {
    paddingInline: "0.625rem",
    paddingBlock: "0.125rem",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    fontWeight: 600,
    fontVariantNumeric: "tabular-nums",
  },
  /**
   * The counter with at least one tag. `bg-yellow-950/60 text-yellow-300`
   */
  tagCountFilled: {
    backgroundColor: "rgba(66, 32, 6, 0.6)",
    color: "#fde047",
  },
  /**
   * The counter with no tags. `bg-muted/60 text-muted-foreground`
   */
  tagCountEmpty: {
    backgroundColor: "hsl(var(--muted) / 0.6)",
    color: "hsl(var(--muted-foreground))",
  },
  /**
   * A scenario tag chip. `inline-flex items-center gap-1 rounded border px-1.5 py-0.5
   * font-mono text-xs`
   */
  tagChip: {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.25rem",
    borderWidth: "1px",
    borderStyle: "solid",
    paddingInline: "0.375rem",
    paddingBlock: "0.125rem",
    fontFamily: "var(--font-mono), ui-monospace, monospace",
    fontSize: "0.75rem",
    lineHeight: "1rem",
  },
  /**
   * A tag derived from the map. `border-blue-700/60 bg-blue-950/40 text-blue-300`
   */
  tagChipAuto: {
    borderColor: "rgba(29, 78, 216, 0.6)",
    backgroundColor: "rgba(23, 37, 84, 0.4)",
    color: "#93c5fd",
  },
  /**
   * A tag typed by the author. `border-yellow-700/60 bg-yellow-950/40 text-yellow-300`
   */
  tagChipManual: {
    borderColor: "rgba(161, 98, 7, 0.6)",
    backgroundColor: "rgba(66, 32, 6, 0.4)",
    color: "#fde047",
  },
  /**
   * The remove affordance on a tag chip. `ml-0.5 transition-colors`
   */
  tagRemove: {
    marginLeft: "0.125rem",
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
  },
  /**
   * Remove, on a derived tag. `text-blue-400/70 hover:text-blue-200`
   */
  tagRemoveAuto: {
    color: { default: "rgba(96, 165, 250, 0.7)", ":hover": "#bfdbfe" },
  },
  /**
   * Remove, on an authored tag. `text-yellow-400/70 hover:text-yellow-200`
   */
  tagRemoveManual: {
    color: { default: "rgba(250, 204, 21, 0.7)", ":hover": "#fef08a" },
  },
  /**
   * A candidate location. `w-full rounded border px-2.5 py-2 text-left transition-colors`
   */
  candidateCard: {
    width: "100%",
    borderWidth: "1px",
    borderStyle: "solid",
    paddingInline: "0.625rem",
    paddingBlock: "0.5rem",
    textAlign: "left",
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
  },
  /**
   * The selected candidate. `border-orange-400/70 bg-orange-500/10`
   */
  candidateCardSelected: {
    borderColor: "rgba(251, 146, 60, 0.7)",
    backgroundColor: "rgba(249, 115, 22, 0.1)",
  },
  /**
   * An unselected candidate. `border-border bg-muted/20 hover:bg-muted/40`
   */
  candidateCardIdle: {
    borderColor: "hsl(var(--border))",
    backgroundColor: { default: "hsl(var(--muted) / 0.2)", ":hover": "hsl(var(--muted) / 0.4)" },
  },
  /**
   * A candidate's confidence badge. `shrink-0 rounded px-1 py-0.5 text-[10px] font-medium`
   */
  confidenceBadge: {
    flexShrink: 0,
    paddingInline: "0.25rem",
    paddingBlock: "0.125rem",
    fontSize: "10px",
    fontWeight: 500,
  },
  /**
   * Confidence at or above 0.9. `bg-emerald-950/40 text-emerald-400 border
   * border-emerald-700/40`
   */
  confidenceHigh: {
    backgroundColor: "rgba(2, 44, 34, 0.4)",
    color: "#34d399",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "rgba(4, 120, 87, 0.4)",
  },
  /**
   * Confidence at or above 0.75. `bg-blue-950/40 text-blue-400 border border-blue-700/40`
   */
  confidenceMedium: {
    backgroundColor: "rgba(23, 37, 84, 0.4)",
    color: "#60a5fa",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "rgba(29, 78, 216, 0.4)",
  },
  /**
   * Confidence below 0.75. `bg-muted text-muted-foreground border border-border`
   */
  confidenceLow: {
    backgroundColor: "hsl(var(--muted))",
    color: "hsl(var(--muted-foreground))",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "hsl(var(--border))",
  },
  /**
   * A layer colour swatch. `size-4 rounded-full ring-1 ring-inset ring-black/20
   * transition-transform hover:scale-110`
   */
  colorSwatch: {
    width: "1rem",
    height: "1rem",
    transitionProperty: "transform",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
    transform: { default: null, ":hover": "scale(1.1)" },
    boxShadow: "inset 0 0 0 1px rgba(0, 0, 0, 0.2)",
  },
  /**
   * The swatch for the layer's current colour. `ring-2 ring-foreground` — the
   * base swatch's `ring-inset` survives `twMerge` (a separate utility group
   * from ring width and colour), so the selection ring draws inside the box
   * and the swatch keeps its 1rem footprint.
   */
  colorSwatchSelected: {
    boxShadow: "inset 0 0 0 2px hsl(var(--foreground))",
  },

  /**
   * The preview map's canvas, which fills its positioned wrapper. Not a
   * translated utility string: the element is sized by CSS while its backing
   * store is sized in device pixels by the renderer.
   */
  staticCanvas: { position: "absolute", inset: 0, width: "100%", height: "100%" },

  /**
   * The thumbnail generator's offscreen capture canvas, fixed at the 512px
   * square the generated thumbnail is written at.
   */
  thumbnailCanvas: { width: "512px", height: "512px" },

  /**
   * The gallery hero's diagonal veil. The mask was written inline because
   * Tailwind has no mask utility; it is a fixed value, so it belongs here.
   * Both spellings ship — WebKit still wants the prefixed property.
   */
  diagonalVeilMask: {
    maskImage:
      "radial-gradient(ellipse 92% 105% at 0% 100%, black 0%, black 38%, rgba(0,0,0,0.76) 52%, transparent 78%)",
    WebkitMaskImage:
      "radial-gradient(ellipse 92% 105% at 0% 100%, black 0%, black 38%, rgba(0,0,0,0.76) 52%, transparent 78%)",
  },

  /** The gallery hero title's drop shadow, which holds it over any frame. */
  heroTitleShadow: { textShadow: "0 4px 28px rgba(0,0,0,0.5)" },

  /**
   * Legend dots whose colour is fixed by the layer they mark, rather than
   * carried on the datum like the other swatches in this list.
   */
  dotInHouseSpeedLimits: { backgroundColor: "#111111" },
  dotOvertureSpeedLimits: { backgroundColor: "#2563eb" },
  dotScenarioCandidate: { backgroundColor: "#f97316" },


  /**
   * `mt-2 space-y-1.5` for the one CSV stack whose children are inline-level
   * (a full-width `<textarea>` and a shrink-to-fit `Button`). The other six
   * `mt-2 space-y-1.5` stacks hold block children and are `s_819`, a flex
   * column; this one keeps block flow so the inline line boxes survive, and
   * pairs with `stackY1_5` on each child.
   */
  inlineStackMt2: { marginTop: "0.5rem" },

  /**
   * The child half of an inline-level `space-y-*` stack: the sibling margin
   * moved onto the children, with `:first-child` cancelling the first exactly
   * as `> :not([hidden]) ~ :not([hidden])` did. Used where the stack cannot
   * become a flex column because one of its children is inline-level.
   */
  stackY1_5: { marginTop: { default: "0.375rem", ":first-child": "0" } },
  stackY2: { marginTop: { default: "0.5rem", ":first-child": "0" } },
  stackY2_5: { marginTop: { default: "0.625rem", ":first-child": "0" } },

  /**
   * size-3.5 shrink-0 text-destructive/70 transition-transform duration-150
   * — the danger-zone disclosure caret, which flips when the section opens.
   */
  dangerChevron: {
    width: "0.875rem",
    height: "0.875rem",
    flexShrink: 0,
    color: "hsl(var(--destructive) / 0.7)",
    transitionProperty: "transform",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
  },
  /** rotate-180 */
  dangerChevronOpen: { transform: "rotate(180deg)" },

  /**
   * rounded px-2 py-1 text-[11px] font-medium uppercase transition-colors —
   * the map detail page's 2D / 3D segments. The radius is dropped for the
   * same reason every other `rounded-*` in this file is: the global sharp
   * -corner reset makes it inert.
   */
  viewModeSegment: {
    paddingLeft: "0.5rem",
    paddingRight: "0.5rem",
    paddingTop: "0.25rem",
    paddingBottom: "0.25rem",
    fontSize: "11px",
    fontWeight: 500,
    textTransform: "uppercase",
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
  },
  /** bg-foreground text-background */
  viewModeSegmentActive: {
    backgroundColor: "hsl(var(--foreground))",
    color: "hsl(var(--background))",
  },
  /** text-muted-foreground hover:text-foreground */
  viewModeSegmentInactive: {
    color: { default: "hsl(var(--muted-foreground))", ":hover": "hsl(var(--foreground))" },
  },

  /**
   * flex-1 rounded-md px-2 py-1 text-xs transition-colors — the digital-twin
   * render-quality segments.
   */
  qualitySegment: {
    flex: "1 1 0%",
    paddingLeft: "0.5rem",
    paddingRight: "0.5rem",
    paddingTop: "0.25rem",
    paddingBottom: "0.25rem",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
  },
  /** bg-background font-medium text-foreground shadow-sm */
  qualitySegmentActive: {
    backgroundColor: "hsl(var(--background))",
    fontWeight: 500,
    color: "hsl(var(--foreground))",
    boxShadow: "0 1px 2px 0 rgba(0, 0, 0, 0.05)",
  },
  /** text-muted-foreground hover:text-foreground */
  qualitySegmentInactive: {
    color: { default: "hsl(var(--muted-foreground))", ":hover": "hsl(var(--foreground))" },
  },
});

/**
 * The Tailwind classes that survive alongside the compiled rules, keyed by the
 * rule they came from. The callsite appends these to the compiled class name.
 *
 * StyleX compiles a rule into an atomic class on the one element it is applied
 * to, so the selector it emits can only ever be that element plus its own
 * pseudo-classes, pseudo-elements and attributes. Every entry below needs a
 * selector that reaches outside that, which is the whole of what remains here:
 *
 *   - `group` / `group-hover:*` — the condition is an *ancestor's* `:hover`,
 *     so the rule has to be written as a descendant selector rooted on the
 *     marked parent. The `group` entries are that marker; they carry no
 *     declarations of their own. Only the variants whose property the
 *     descendant's own StyleX rule leaves undeclared can live here: StyleX
 *     guards each atomic rule with repeated `:not(#\#)`, which outranks a
 *     descendant selector, so a variant fighting a compiled declaration would
 *     silently never apply. Those cases publish `hovered` from the ancestor
 *     instead — see the variable group at the top of this module.
 *   - the `animate-in` / `animate-out` sets keyed off `data-state` —
 *     `tailwindcss-animate` drives `enter`/`exit` through custom properties
 *     that only its own attribute variants set, so the animation cannot leave
 *     without them. The `data-[state=*]` variants that merely declared a value
 *     are compiled: StyleX takes an attribute condition (`s_742`, `s_748`)
 *     even though Radix writes the attribute after mount. The two entrance
 *     animations that did *not* depend on a foreign attribute are gone: they
 *     are `slideInFromRight2` and `slideInFromBottom2` at the top of this
 *     module.
 */
export const bridge = {
  s_182: "group-hover:scale-105",
  s_183: "group-hover:scale-105",
  s_184: "group",
  s_188: "group-hover:text-primary",
  s_197: "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0",
  s_198: "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
  s_545: "group",
  s_549: "group-hover:scale-110",
  s_552: "group",
  s_554: "group-hover:scale-110",
} as const;
