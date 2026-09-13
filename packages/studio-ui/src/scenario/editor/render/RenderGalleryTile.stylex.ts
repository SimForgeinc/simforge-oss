import * as stylex from "@stylexjs/stylex";
import { colors, text, space, layers } from "../../../stylex/tokens.stylex";

/**
 * Opacity the hovered tile publishes for its overlay controls.
 *
 * The controls are siblings of the picture, not children of a rule that could
 * see the tile's `:hover`, and their own StyleX `opacity` outranks any
 * `group-hover:opacity-100` written beside it. The tile publishes the value
 * and the controls read it, so they still fade in with the pointer.
 */
export const overlayControlVars = stylex.defineVars({ opacity: "0" });

export const styles = stylex.create({
  // absolute inset-0 z-10 focus-visible:outline-none
  absInset0Raised: {
    position: "absolute",
    inset: space.none,
    zIndex: layers.raised,
    outline: {
      default: null,
      ":focus-visible": "2px solid transparent",
    },
    outlineOffset: {
      default: null,
      ":focus-visible": "2px",
    },
  },
  // absolute inset-0 render-glass
  absInset0: {
    position: "absolute",
    inset: space.none,
    backgroundColor: colors.glass,
    // `hover:border-primary/60` is folded in here (and into the failed variant
    // below) rather than composed as its own rule: a separate rule would need a
    // `default: null`, which unsets whichever resting colour came before it.
    borderColor: {
      default: "rgb(255 255 255 / 10%)",
      ":hover": "hsl(var(--primary) / 0.6)",
    },
  },
  // size-full object-cover
  fullCover: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
  },
  // grid size-full place-items-center
  gridCenteredFull: {
    display: "grid",
    width: "100%",
    height: "100%",
    placeItems: "center",
  },
  // size-6 text-muted-foreground/50
  size6TextMutedForeground50: {
    width: "1.5rem",
    height: "1.5rem",
    color: "hsl(var(--muted-foreground) / 0.5)",
  },
  // pointer-events-none absolute left-2 top-2 z-20 flex flex-wrap items-center gap-1
  absFlexCenter: {
    pointerEvents: "none",
    position: "absolute",
    left: space.md,
    top: space.md,
    zIndex: "20",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space.xs,
  },
  // render-chip-strong px-1.5 py-0.5 text-micro uppercase tracking-meta text-secondary-foreground
  capsMicro: {
    paddingLeft: space.sm,
    paddingRight: space.sm,
    paddingTop: space.xxs,
    paddingBottom: space.xxs,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: colors.secondaryForeground,
    backgroundColor: colors.chipStrong,
  },
  // render-chip px-1.5 py-0.5 text-micro uppercase tracking-meta text-muted-foreground
  capsMicroMuted: {
    paddingLeft: space.sm,
    paddingRight: space.sm,
    paddingTop: space.xxs,
    paddingBottom: space.xxs,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: colors.mutedForeground,
    backgroundColor: colors.chip,
  },
  // bg-primary/15 px-1.5 py-0.5 text-micro uppercase tracking-meta text-primary
  capsMicroAccent: {
    backgroundColor: "hsl(var(--primary) / 0.15)",
    paddingLeft: space.sm,
    paddingRight: space.sm,
    paddingTop: space.xxs,
    paddingBottom: space.xxs,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: colors.primary,
  },
  // bg-amber-500/20 px-1.5 py-0.5 text-micro uppercase tracking-meta text-amber-300
  capsMicro2: {
    backgroundColor: "rgb(245 158 11 / 0.2)",
    paddingLeft: space.sm,
    paddingRight: space.sm,
    paddingTop: space.xxs,
    paddingBottom: space.xxs,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: "rgb(252 211 77 / 1)",
  },
  // motionStyles.editorMotion + absolute right-2 top-2 z-20 inline-flex size-7 items-center justify-center render-overlay-control opacity-0 backdrop-blur hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100 disabled:opacity-40
  absInlineFlexCenter: {
    position: "absolute",
    right: space.md,
    top: space.md,
    zIndex: "20",
    display: "inline-flex",
    width: "1.75rem",
    height: "1.75rem",
    alignItems: "center",
    justifyContent: "center",
    // `group-hover:opacity-100` is the tile's published variable; resting 0.
    opacity: {
      default: overlayControlVars.opacity,
      ":disabled": "0.4",
      ":focus-visible": "1",
    },
    backdropFilter: "blur(8px)",
    backgroundColor: colors.overlayScrim,
    color: {
      default: "rgb(255 255 255 / 80%)",
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
  // size-3.5
  size35: {
    width: "0.875rem",
    height: "0.875rem",
  },
  // motionStyles.editorMotion + absolute right-11 top-2 z-20 inline-flex size-7 items-center justify-center render-overlay-control opacity-0 backdrop-blur hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100 disabled:opacity-40
  absInlineFlexCenter2: {
    position: "absolute",
    right: "2.75rem",
    top: space.md,
    zIndex: "20",
    display: "inline-flex",
    width: "1.75rem",
    height: "1.75rem",
    alignItems: "center",
    justifyContent: "center",
    // `group-hover:opacity-100` is the tile's published variable; resting 0.
    opacity: {
      default: overlayControlVars.opacity,
      ":disabled": "0.4",
      ":focus-visible": "1",
    },
    backdropFilter: "blur(8px)",
    backgroundColor: colors.overlayScrim,
    color: {
      default: "rgb(255 255 255 / 80%)",
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
  // pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col gap-1 render-scrim px-2.5 pb-2 pt-6
  absFlexCol: {
    pointerEvents: "none",
    position: "absolute",
    left: space.none,
    right: space.none,
    bottom: space.none,
    zIndex: "20",
    display: "flex",
    flexDirection: "column",
    gap: space.xs,
    paddingLeft: "0.625rem",
    paddingRight: "0.625rem",
    paddingBottom: space.md,
    paddingTop: space.xxl,
    backgroundImage: "linear-gradient(to top, rgb(0 0 0 / 75%) 0%, rgb(0 0 0 / 35%) 50%, transparent 100%)",
  },
  // flex items-baseline justify-between gap-2
  flexBetweenBaseline: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: space.md,
  },
  // truncate text-meta text-foreground
  metaInkTruncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: text.sizeMeta,
    lineHeight: "1rem",
    color: colors.text,
  },
  // shrink-0 text-micro uppercase tracking-meta text-muted-foreground
  tightCapsMicro: {
    flexShrink: "0",
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: colors.mutedForeground,
  },
  // text-micro font-semibold text-foreground
  microInkSemibold: {
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    fontWeight: text.weightSemibold,
    color: colors.text,
  },
  // line-clamp-2 text-micro text-destructive
  microDanger: {
    overflow: "hidden",
    display: "-webkit-box",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: "2",
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    color: colors.danger,
  },
  // render-glass render-surface-motion relative flex aspect-video w-full flex-col overflow-hidden border text-left focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-1 focus-within:ring-offset-background
  // The `group` marker is gone: the overlay controls read `overlayControlVars`.
  relFlexCol: {
    position: "relative",
    display: "flex",
    aspectRatio: "16 / 9",
    width: "100%",
    flexDirection: "column",
    overflow: "hidden",
    borderWidth: "1px",
    textAlign: "left",
    backgroundColor: colors.glass,
    // `hover:border-primary/60` is folded in here (and into the failed variant
    // below) rather than composed as its own rule: a separate rule would need a
    // `default: null`, which unsets whichever resting colour came before it.
    borderColor: {
      default: "rgb(255 255 255 / 10%)",
      ":hover": "hsl(var(--primary) / 0.6)",
    },
    boxShadow: {
      default: null,
      ":focus-within": "0 0 0 1px hsl(var(--background)), 0 0 0 3px hsl(var(--ring))",
    },
    [overlayControlVars.opacity]: "0",
    ":hover": {
      [overlayControlVars.opacity]: "1",
    },
  },
  // border-destructive/60 hover:border-primary/60
  borderDestructive60: {
    borderColor: {
      default: "hsl(var(--destructive) / 0.6)",
      ":hover": "hsl(var(--primary) / 0.6)",
    },
  },
});
