/**
 * StyleX styles for the asset gallery's tiles and the grid that lays them out:
 * `AssetCard` and `AssetGalleryGrid` (plus its loading skeleton).
 *
 * Translated one-for-one from the Tailwind these components shipped with, in
 * the same spirit as `asset-gallery.stylex.ts`: literal rems where the utility
 * compiled to a literal rem, Tailwind's own transition curve and durations,
 * and no rounding onto a nearer token step. Nothing here changes a pixel.
 *
 * Radii are absent throughout. The Tailwind config resolves the whole radius
 * scale to `0` and `styles.css` re-asserts it with
 * `*, *::before, *::after { border-radius: 0 !important }`, so `rounded-lg`
 * and `rounded-full` contributed nothing to render on these surfaces.
 */

import * as stylex from "@stylexjs/stylex";
import { colors, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

/** Tailwind's default breakpoints, the only ones the grid responds to. */
const SM = "@media (min-width: 640px)";
const LG = "@media (min-width: 1024px)";
const XL = "@media (min-width: 1280px)";
const XXL = "@media (min-width: 1536px)";

/** Tailwind's default transition curve and the two durations used here. */
const EASE = "cubic-bezier(0.4, 0, 0.2, 1)";

/**
 * The tile's hover state, published to its own descendants.
 *
 * StyleX styles an element by itself: there is no `group-hover`, because there
 * is no selector that reaches from a parent's `:hover` down to a child. What
 * there is instead is inheritance — the card sets these custom properties on
 * itself, its descendants read them, and the values change when the card is
 * hovered or focused. The dependent property's computed value changes with the
 * substitution, so the child's own `transition` still animates it exactly as
 * the `group-hover:` utilities did.
 *
 * Each carries the finished value rather than a scalar to interpolate: the
 * zoom publishes `none`/`scale(1.03)`, so an un-hovered thumbnail computes to
 * `transform: none` and stays out of its own stacking context, exactly as it
 * did under `group-hover:scale-[1.03]`.
 */
const CARD_REVEAL = "--asset-card-reveal";
const CARD_ZOOM = "--asset-card-zoom";
const CARD_TITLE_INK = "--asset-card-title-ink";

/**
 * `hover:shadow-lg hover:shadow-black/30` — Tailwind's `lg` shadow geometry
 * with the card's own shadow colour substituted for the default.
 */
const SHADOW_HOVER =
  "0 10px 15px -3px rgba(0, 0, 0, 0.3), 0 4px 6px -4px rgba(0, 0, 0, 0.3)";

/**
 * `focus-visible:ring-2 ring-ring ring-offset-2 ring-offset-background` —
 * Tailwind draws its focus ring as two stacked shadows: the offset ring in the
 * page's background colour first, then the ring itself outside it.
 */
const SHADOW_RING = `0 0 0 2px ${colors.bg}, 0 0 0 4px ${colors.ring}`;

export const card = stylex.create({
  /**
   * group flex w-full flex-col overflow-hidden rounded-lg border border-border
   * bg-card text-left transition-[transform,border-color,box-shadow]
   * duration-200 hover:-translate-y-0.5 hover:border-border/80 hover:shadow-lg
   * hover:shadow-black/30 focus-visible:outline-none focus-visible:ring-2
   * focus-visible:ring-ring focus-visible:ring-offset-2
   * focus-visible:ring-offset-background
   *
   * The three published values replace the `group` marker: the thumbnail's
   * zoom, the "View details" strip's fade, and the title's colour shift all
   * lived on `group-hover:`/`group-focus-visible:` utilities.
   */
  root: {
    [CARD_REVEAL]: { default: 0, ":hover": 1, ":focus-visible": 1 },
    [CARD_ZOOM]: { default: "none", ":hover": "scale(1.03)" },
    [CARD_TITLE_INK]: { default: "inherit", ":hover": colors.primary },
    display: "flex",
    width: "100%",
    flexDirection: "column",
    overflow: "hidden",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: colors.border, ":hover": "hsl(var(--border) / 0.8)" },
    backgroundColor: colors.card,
    textAlign: "left",
    transform: { default: "none", ":hover": "translateY(-0.125rem)" },
    transitionProperty: "transform, border-color, box-shadow",
    transitionDuration: "200ms",
    transitionTimingFunction: EASE,
    /**
     * Hover and focus can be true at once, and Tailwind would render both
     * shadows then — `--tw-shadow` and `--tw-ring-shadow` are separate slots in
     * one `box-shadow`. The combined key restores that; without it the last
     * matching condition would silently drop the lift shadow off a focused
     * tile the pointer is also over.
     */
    boxShadow: {
      default: "none",
      ":hover": SHADOW_HOVER,
      ":focus-visible": SHADOW_RING,
      ":hover:focus-visible": `${SHADOW_RING}, ${SHADOW_HOVER}`,
    },
    /**
     * `outline-none` is Tailwind's transparent outline, not `outline: none`:
     * the ring above is a box-shadow, which forced-colors mode discards, and
     * the transparent outline is what remains visible there.
     */
    outlineWidth: { default: null, ":focus-visible": "2px" },
    outlineStyle: { default: null, ":focus-visible": "solid" },
    outlineColor: { default: null, ":focus-visible": "transparent" },
    outlineOffset: { default: null, ":focus-visible": "2px" },
  },

  /**
   * relative aspect-square overflow-hidden
   * bg-[radial-gradient(circle_at_50%_42%,hsl(var(--muted))_0%,hsl(var(--card))_70%)]
   *
   * The well behind a cut-out model: lit slightly above centre so the object
   * sits in the light rather than on a flat plate.
   */
  well: {
    position: "relative",
    aspectRatio: "1 / 1",
    overflow: "hidden",
    backgroundImage: `radial-gradient(circle at 50% 42%, ${colors.muted} 0%, ${colors.card} 70%)`,
  },
  // h-full w-full object-contain transition-transform duration-300
  // group-hover:scale-[1.03]
  thumbnail: {
    height: "100%",
    width: "100%",
    objectFit: "contain",
    transform: `var(${CARD_ZOOM})`,
    transitionProperty: "transform",
    transitionDuration: "300ms",
    transitionTimingFunction: EASE,
  },
  // absolute left-2 top-2
  pillSlot: {
    position: "absolute",
    left: "0.5rem",
    top: "0.5rem",
  },
  animatedBadge: {
    position: "absolute",
    right: "0.5rem",
    top: "0.5rem",
    display: "inline-flex",
    height: "1.25rem",
    alignItems: "center",
    gap: "0.25rem",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "hsl(var(--primary) / 0.25)",
    backgroundColor: "hsl(var(--background) / 0.8)",
    paddingInline: "0.375rem",
    paddingBlock: 0,
    fontSize: text.sizeMicro,
    color: colors.primary,
  },
  // size-3 animate-pulse
  animatedIcon: {
    width: "0.75rem",
    height: "0.75rem",
    animationName: stylex.keyframes({ "50%": { opacity: 0.5 } }),
    animationDuration: "2s",
    animationTimingFunction: "cubic-bezier(0.4, 0, 0.6, 1)",
    animationIterationCount: "infinite",
  },

  /**
   * pointer-events-none absolute inset-x-0 bottom-0 flex items-center
   * justify-end gap-1 bg-gradient-to-t from-black/70 to-transparent px-3 pb-2
   * pt-8 text-xs font-medium text-primary opacity-0 transition-opacity
   * duration-200 group-hover:opacity-100 group-focus-visible:opacity-100
   */
  reveal: {
    pointerEvents: "none",
    position: "absolute",
    insetInline: 0,
    bottom: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: "0.25rem",
    backgroundImage: "linear-gradient(to top, rgba(0, 0, 0, 0.7), transparent)",
    paddingInline: "0.75rem",
    paddingBottom: "0.5rem",
    paddingTop: "2rem",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    fontWeight: 500,
    color: colors.primary,
    opacity: `var(${CARD_REVEAL})`,
    transitionProperty: "opacity",
    transitionDuration: "200ms",
    transitionTimingFunction: EASE,
  },
  // size-3.5
  revealIcon: {
    width: "0.875rem",
    height: "0.875rem",
  },

  // flex flex-1 flex-col gap-2 p-3.5
  body: {
    display: "flex",
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "0%",
    flexDirection: "column",
    gap: "0.5rem",
    padding: "0.875rem",
  },
  // flex items-start justify-between gap-2
  titleRow: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: "0.5rem",
  },
  /**
   * min-w-0 truncate text-sm font-semibold leading-snug transition-colors
   * group-hover:text-primary
   *
   * `leading-snug` wins over `text-sm`'s paired line height, as it does in the
   * Tailwind output; `transition-colors` is expanded to the utility's own
   * property list so the shift to the accent still fades.
   */
  title: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: text.sizeSm,
    lineHeight: 1.375,
    fontWeight: 600,
    color: `var(${CARD_TITLE_INK})`,
    transitionProperty:
      "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionDuration: "150ms",
    transitionTimingFunction: EASE,
  },
  /**
   * shrink-0 rounded-full border border-border px-2 py-0.5 text-[10px]
   * capitalize text-muted-foreground
   *
   * `text-[10px]` is the arbitrary size, which sets no line height — not
   * `text-micro`, which does.
   */
  classChip: {
    flexShrink: 0,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    paddingInline: "0.5rem",
    paddingBlock: "0.125rem",
    fontSize: "10px",
    textTransform: "capitalize",
    color: colors.mutedForeground,
  },
  // mt-auto text-right text-xs text-muted-foreground
  meta: {
    marginTop: "auto",
    textAlign: "right",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.mutedForeground,
  },
  // font-mono tabular-nums
  metaCount: {
    fontFamily: text.fontMono,
    fontVariantNumeric: "tabular-nums",
  },
});

export const grid = stylex.create({
  /**
   * grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4
   * 2xl:grid-cols-5
   *
   * Shared by the real grid and the skeleton so the swap cannot reflow.
   */
  grid: {
    display: "grid",
    gap: "1rem",
    gridTemplateColumns: {
      default: "repeat(1, minmax(0, 1fr))",
      [SM]: "repeat(2, minmax(0, 1fr))",
      [LG]: "repeat(3, minmax(0, 1fr))",
      [XL]: "repeat(4, minmax(0, 1fr))",
      [XXL]: "repeat(5, minmax(0, 1fr))",
    },
  },
  /** The catalog is a real `<ul>`; strip the list affordances it comes with. */
  list: {
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  /** `sr-only`: read but not seen, for the one live status the grid announces. */
  srOnly: {
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

  // overflow-hidden rounded-lg border border-border bg-card
  skeletonCard: {
    overflow: "hidden",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  // The full thumbnail uses a quieter fill than the text placeholders.
  skeletonThumb: {
    aspectRatio: "1 / 1",
    backgroundColor: "hsl(var(--muted) / 0.4)",
  },
  // flex flex-col gap-2.5 p-3.5
  skeletonBody: {
    display: "flex",
    flexDirection: "column",
    gap: "0.625rem",
    padding: "0.875rem",
  },
  // flex items-center justify-between gap-2
  skeletonRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "0.5rem",
  },
  // h-3.5 w-2/3
  skeletonTitle: {
    height: "0.875rem",
    width: "66.666667%",
  },
  // h-3.5 w-12 rounded-full
  skeletonChip: {
    height: "0.875rem",
    width: "3rem",
  },
  // h-3 w-24
  skeletonMeta: {
    height: "0.75rem",
    width: "6rem",
  },
  // h-3 w-16
  skeletonMetaShort: {
    height: "0.75rem",
    width: "4rem",
  },
});
