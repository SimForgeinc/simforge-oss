import * as stylex from "@stylexjs/stylex";
import { colors, text, space, layers } from "../../../stylex/tokens.stylex";

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
    borderColor: "rgb(255 255 255 / 10%)",
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
  // render-chip h-1
  renderChipH1: {
    height: "0.25rem",
    backgroundColor: colors.chip,
  },
  // h-full bg-primary
  tall: {
    height: "100%",
    backgroundColor: colors.primary,
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
  // absolute inset-0 grid place-items-center render-glass
  absGridCentered: {
    position: "absolute",
    inset: space.none,
    display: "grid",
    placeItems: "center",
    backgroundColor: colors.glass,
    borderColor: "rgb(255 255 255 / 10%)",
  },
  // absolute inset-x-0 bottom-0 z-20 flex flex-col gap-1.5 render-scrim px-2.5 pb-2 pt-6
  absFlexCol2: {
    position: "absolute",
    left: space.none,
    right: space.none,
    bottom: space.none,
    zIndex: "20",
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
    paddingLeft: "0.625rem",
    paddingRight: "0.625rem",
    paddingBottom: space.md,
    paddingTop: space.xxl,
    backgroundImage: "linear-gradient(to top, rgb(0 0 0 / 75%) 0%, rgb(0 0 0 / 35%) 50%, transparent 100%)",
  },
  // flex items-center gap-1.5
  flexCenterGap15: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
  },
  // motionStyles.editorMotion + inline-flex items-center gap-1 render-glass render-glass-hover border px-2 py-1 text-micro uppercase tracking-meta text-foreground backdrop-blur focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
  inlineFlexCenterCaps: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.xs,
    borderWidth: "1px",
    paddingLeft: space.md,
    paddingRight: space.md,
    paddingTop: space.xs,
    paddingBottom: space.xs,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: colors.text,
    backdropFilter: "blur(8px)",
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
  // size-3
  size3: {
    width: "0.75rem",
    height: "0.75rem",
  },
  // px-1.5 py-0.5 text-micro uppercase tracking-meta
  capsMicro2: {
    paddingLeft: space.sm,
    paddingRight: space.sm,
    paddingTop: space.xxs,
    paddingBottom: space.xxs,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
  },

  // Tile state chips, tone for tone with the managed tile's chips in
  // `RenderStatePieces.stylex.ts` — one gallery, one vocabulary of state.
  // bg-primary/20 text-primary
  chipRunning: {
    backgroundColor: "hsl(var(--primary) / 0.2)",
    color: colors.primary,
  },
  // bg-primary/15 text-primary
  chipSucceeded: {
    backgroundColor: "hsl(var(--primary) / 0.15)",
    color: colors.primary,
  },
  // bg-destructive/20 text-destructive
  chipFailed: {
    backgroundColor: "hsl(var(--destructive) / 0.2)",
    color: colors.danger,
  },
  // text-muted-foreground — the plate beside it is the `render-chip` global.
  chipCancelled: {
    color: colors.mutedForeground,
  },
  // bg-secondary text-secondary-foreground
  chipQueued: {
    backgroundColor: colors.secondary,
    color: colors.secondaryForeground,
  },
  // render-glass render-surface-motion group relative flex aspect-video w-full flex-col overflow-hidden border
  relFlexCol2: {
    position: "relative",
    display: "flex",
    aspectRatio: "16 / 9",
    width: "100%",
    flexDirection: "column",
    overflow: "hidden",
    borderWidth: "1px",
    borderColor: "rgb(255 255 255 / 10%)",
    backgroundColor: colors.glass,
  },
  // motionStyles.editorMotion + group relative flex aspect-video w-full flex-col render-glass render-surface-motion overflow-hidden border text-left focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-1 focus-within:ring-offset-background
  relFlexCol4: {
    position: "relative",
    display: "flex",
    aspectRatio: "16 / 9",
    width: "100%",
    flexDirection: "column",
    overflow: "hidden",
    borderWidth: "1px",
    textAlign: "left",
    backgroundColor: colors.glass,
    borderColor: "rgb(255 255 255 / 10%)",
    boxShadow: {
      default: null,
      ":focus-within": "0 0 0 1px hsl(var(--background)), 0 0 0 3px hsl(var(--ring))",
    },
  },
  // border-destructive/60
  borderDestructive60: {
    borderColor: "hsl(var(--destructive) / 0.6)",
  },
  // hover:border-primary/60 — nested pseudo-class form, not `{ default: null,
  // ":hover": … }`: a `null` default would unset the base tile's resting
  // border colour when the two rules are composed.
  hoverBorderPrimary60: {
    ":hover": {
      borderColor: "hsl(var(--primary) / 0.6)",
    },
  },
});
