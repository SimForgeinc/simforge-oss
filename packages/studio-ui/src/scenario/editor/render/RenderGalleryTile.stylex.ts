import * as stylex from "@stylexjs/stylex";
import { colors, layers, motion, shadows, space, stroke, text } from "../../../stylex/tokens.stylex";

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
    inset: 0,
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
    inset: 0,
    backgroundColor: colors.fillSubtle,
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
    left: space.s2,
    top: space.s2,
    zIndex: "20",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space.s1,
  },
  // render-chip-strong px-1.5 py-0.5 text-micro uppercase tracking-meta text-secondary-foreground
  capsMicro: {
    paddingLeft: space.s1_5,
    paddingRight: space.s1_5,
    paddingTop: space.s0_5,
    paddingBottom: space.s0_5,
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: colors.secondaryForeground,
    backgroundColor: colors.fillStronger,
  },
  // render-chip px-1.5 py-0.5 text-micro uppercase tracking-meta text-muted-foreground
  capsMicroMuted: {
    paddingLeft: space.s1_5,
    paddingRight: space.s1_5,
    paddingTop: space.s0_5,
    paddingBottom: space.s0_5,
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: colors.mutedForeground,
    backgroundColor: colors.fillStrong,
  },
  // bg-primary/15 px-1.5 py-0.5 text-micro uppercase tracking-meta text-primary
  capsMicroAccent: {
    backgroundColor: "hsl(var(--primary) / 0.15)",
    paddingLeft: space.s1_5,
    paddingRight: space.s1_5,
    paddingTop: space.s0_5,
    paddingBottom: space.s0_5,
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: colors.primary,
  },
  // bg-amber-500/20 px-1.5 py-0.5 text-micro uppercase tracking-meta text-amber-300
  capsMicro2: {
    backgroundColor: "rgb(245 158 11 / 0.2)",
    paddingLeft: space.s1_5,
    paddingRight: space.s1_5,
    paddingTop: space.s0_5,
    paddingBottom: space.s0_5,
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: colors.warning,
  },
  // motionStyles.editorMotion + absolute right-2 top-2 z-20 inline-flex size-7 items-center justify-center render-overlay-control opacity-0 backdrop-blur hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100 disabled:opacity-40
  absInlineFlexCenter: {
    position: "absolute",
    right: space.s2,
    top: space.s2,
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
    backdropFilter: motion.blurMd,
    backgroundColor: colors.scrim,
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
      ":focus-visible": shadows.ring,
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
    top: space.s2,
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
    backdropFilter: motion.blurMd,
    backgroundColor: colors.scrim,
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
      ":focus-visible": shadows.ring,
    },
  },
  // pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col gap-1 render-scrim px-2.5 pb-2 pt-6
  absFlexCol: {
    pointerEvents: "none",
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: "20",
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
    paddingLeft: space.s2_5,
    paddingRight: space.s2_5,
    paddingBottom: space.s2,
    paddingTop: space.s6,
    backgroundImage: "linear-gradient(to top, rgb(0 0 0 / 75%) 0%, rgb(0 0 0 / 35%) 50%, transparent 100%)",
  },
  // flex items-baseline justify-between gap-2
  flexBetweenBaseline: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: space.s2,
  },
  // truncate text-meta text-foreground
  metaInkTruncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: text.sizeMeta,
    lineHeight: text.lineXs,
    color: colors.text,
  },
  // shrink-0 text-micro uppercase tracking-meta text-muted-foreground
  tightCapsMicro: {
    flexShrink: "0",
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: colors.mutedForeground,
  },
  // text-micro font-semibold text-foreground
  microInkSemibold: {
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
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
    lineHeight: text.lineMicro,
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
    borderWidth: stroke.hairline,
    textAlign: "left",
    backgroundColor: colors.fillSubtle,
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
