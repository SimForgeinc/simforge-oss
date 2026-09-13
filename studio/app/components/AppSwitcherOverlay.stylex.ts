/**
 * StyleX styles for `AppSwitcherOverlay` — the full-screen app switcher that
 * the top bar's logo button opens.
 *
 * Translated one-for-one from the Tailwind the overlay shipped with: literal
 * rems where the utility compiled to a literal rem, Tailwind's own transition
 * curve and durations, and the same `rgb(r g b / a)` channels the slash-opacity
 * utilities produced. Nothing here changes a pixel.
 *
 * Radii are absent throughout. The Tailwind config resolves the whole radius
 * scale to `0` and `styles.css` re-asserts it with
 * `*, *::before, *::after { border-radius: 0 !important }`, so `rounded-full`,
 * `rounded-xl` and `rounded-[20px]` contributed nothing to render here.
 *
 * The backdrop's `animate-in`/`animate-out` pair came from
 * `tailwindcss-animate`; the dialog's own fade came from `styles.css`, where
 * it was the `app-switcher-center-fade` class. Both are written out below,
 * each with the `prefers-reduced-motion` cancel the original carried.
 */

import * as stylex from "@stylexjs/stylex";
import {
  colors,
  layers,
  text,
} from "@simforge-oss/studio-ui/stylex/tokens.stylex";

/** The breakpoints this overlay responds to. */
const SM = "@media (min-width: 640px)";
const LG = "@media (min-width: 1024px)";
const XL = "@media (min-width: 1280px)";
const REDUCED = "@media (prefers-reduced-motion: reduce)";

/** Tailwind's default transition curve and its `transition-colors` set. */
const EASE = "cubic-bezier(0.4, 0, 0.2, 1)";
const COLOR_TRANSITION =
  "color, background-color, border-color, text-decoration-color, fill, stroke";

/**
 * `focus-visible:ring-2 focus-visible:ring-[#E8E044]` — Tailwind draws a ring
 * as a box-shadow; the offset ring is zero-width here, so the visible half is
 * the 2px one. `ring-inset` moves the same shadow inside the box.
 */
const FOCUS_RING = `0 0 0 2px ${colors.accent}`;
const FOCUS_RING_INSET = `inset 0 0 0 2px ${colors.accent}`;

/** `hover:shadow-[…]` and the active card's resting elevation. */
const CARD_SHADOW_ACTIVE =
  "inset 0 1px 0 rgba(255, 255, 255, 0.06), 0 18px 50px rgba(0, 0, 0, 0.18)";
const CARD_SHADOW_HOVER = "0 20px 55px rgba(0, 0, 0, 0.25)";

/**
 * `animate-in fade-in-0` / `animate-out fade-out-0` from `tailwindcss-animate`,
 * written out. The plugin's `enter`/`exit` keyframes carry the identity
 * transform alongside the opacity, and it is kept: it is what puts the
 * backdrop on its own compositing layer for the duration of the fade.
 */
const IDENTITY_TRANSFORM =
  "translate3d(0, 0, 0) scale3d(1, 1, 1) rotate(0)";
const enter = stylex.keyframes({
  from: { opacity: 0, transform: IDENTITY_TRANSFORM },
});
const exit = stylex.keyframes({
  to: { opacity: 0, transform: IDENTITY_TRANSFORM },
});

/**
 * The dialog's own fade, formerly `.app-switcher-center-fade[data-state]` in
 * `styles.css`: 180ms out of nothing on open, 120ms back on close, both with
 * `animation-fill-mode: both` so Radix's exit state holds the last frame
 * until it unmounts the content.
 *
 * Opacity-only, deliberately. This surface is centred by a `transform` in
 * other compositions, and a keyframe that animated `transform` would replace
 * that centring for the duration of the fade.
 */
const centerFadeIn = stylex.keyframes({
  from: { opacity: 0 },
  to: { opacity: 1 },
});
const centerFadeOut = stylex.keyframes({
  from: { opacity: 1 },
  to: { opacity: 0 },
});

/**
 * The card's hover state, published to its own descendants.
 *
 * StyleX styles an element by itself: there is no `group-hover`, because there
 * is no selector reaching from a parent's `:hover` down to a child. The card
 * sets these custom properties on itself instead, its descendants read them,
 * and the substituted value changes when the card is hovered — so each child's
 * own `transition` still animates exactly as the `group-hover:` utilities did.
 *
 * Each carries the finished value rather than a scalar to interpolate, so an
 * un-hovered art tile computes to `transform: none` and stays out of its own
 * stacking context, exactly as it did under the utilities.
 *
 * The three `*Idle` values exist because only the non-current cards dim and
 * desaturate their art: a current card's art is already at full opacity with a
 * yellow drop shadow, and hovering it must not disturb that.
 */
export const artTransform = stylex.defineVars({ value: "none" });
export const artIdleOpacity = stylex.defineVars({ value: "0.45" });
export const artIdleFilter = stylex.defineVars({ value: "grayscale(100%)" });
export const metaIdleInk = stylex.defineVars({
  value: "rgb(255 255 255 / 0.35)",
});

export const styles = stylex.create({
  /**
   * fixed inset-0 z-[300] overflow-hidden
   * data-[state=closed]:animate-out data-[state=closed]:fade-out-0
   * data-[state=open]:animate-in data-[state=open]:fade-in-0
   * motion-reduce:animate-none
   */
  backdrop: {
    position: "fixed",
    inset: 0,
    zIndex: layers.appSwitcher,
    overflow: "hidden",
    animationDuration: "150ms",
    animationName: {
      default: null,
      "[data-state=open]": { default: enter, [REDUCED]: "none" },
      "[data-state=closed]": { default: exit, [REDUCED]: "none" },
    },
  },

  /**
   * fixed inset-0 z-[310] overflow-y-auto text-white outline-none, plus the
   * open/close fade `styles.css` used to own.
   *
   * `outline-none` is Tailwind's transparent outline, not `outline: none`: the
   * focus affordances on this surface are box-shadow rings, which forced-colors
   * mode discards, and the transparent outline is what remains visible there.
   *
   * The fade keys off Radix's `data-state` rather than the `open` prop, as the
   * backdrop above does: the closing frame is a state React has already left,
   * so only the attribute Radix keeps on the mounted node describes it.
   */
  dialog: {
    position: "fixed",
    inset: 0,
    zIndex: layers.appSwitcherTop,
    overflowY: "auto",
    color: "#fff",
    outlineWidth: "2px",
    outlineStyle: "solid",
    outlineColor: "transparent",
    outlineOffset: "2px",
    animationDuration: {
      default: null,
      "[data-state=open]": "180ms",
      "[data-state=closed]": "120ms",
    },
    animationTimingFunction: {
      default: null,
      "[data-state=open]": "ease-out",
      "[data-state=closed]": "ease-in",
    },
    animationFillMode: {
      default: null,
      "[data-state=open]": "both",
      "[data-state=closed]": "both",
    },
    animationName: {
      default: null,
      "[data-state=open]": { default: centerFadeIn, [REDUCED]: "none" },
      "[data-state=closed]": { default: centerFadeOut, [REDUCED]: "none" },
    },
  },

  /** `sr-only`: the dialog's accessible name and description. */
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

  /**
   * fixed right-5 top-5 z-20 grid size-10 place-items-center rounded-full
   * text-white/40 transition-colors hover:bg-white/[0.06] hover:text-white
   * focus-visible:outline-none focus-visible:ring-2
   * focus-visible:ring-[#E8E044] sm:right-8 sm:top-8
   *
   * `z-20` is local to the dialog's own stacking context — it lifts the close
   * button over the card grid, not over anything in the page — so it stays a
   * literal rather than joining the app-wide `layers` scale.
   */
  close: {
    position: "fixed",
    right: { default: "1.25rem", [SM]: "2rem" },
    top: { default: "1.25rem", [SM]: "2rem" },
    zIndex: 20,
    display: "grid",
    width: "2.5rem",
    height: "2.5rem",
    placeItems: "center",
    color: { default: "rgb(255 255 255 / 0.4)", ":hover": "#fff" },
    backgroundColor: { default: null, ":hover": "rgb(255 255 255 / 0.06)" },
    transitionProperty: COLOR_TRANSITION,
    transitionDuration: "150ms",
    transitionTimingFunction: EASE,
    outlineWidth: { default: null, ":focus-visible": "2px" },
    outlineStyle: { default: null, ":focus-visible": "solid" },
    outlineColor: { default: null, ":focus-visible": "transparent" },
    outlineOffset: { default: null, ":focus-visible": "2px" },
    boxShadow: { default: null, ":focus-visible": FOCUS_RING },
  },
  // size-5
  closeIcon: { width: "1.25rem", height: "1.25rem" },

  /**
   * relative mx-auto flex min-h-full w-full max-w-[1120px] flex-col
   * justify-center gap-8 px-5 py-20 sm:px-8 sm:py-24
   */
  container: {
    position: "relative",
    marginInline: "auto",
    display: "flex",
    minHeight: "100%",
    width: "100%",
    maxWidth: "1120px",
    flexDirection: "column",
    justifyContent: "center",
    gap: "2rem",
    paddingInline: { default: "1.25rem", [SM]: "2rem" },
    paddingBlock: { default: "5rem", [SM]: "6rem" },
  },

  /**
   * pointer-events-none absolute -left-24 top-0 h-56 w-96 rounded-full
   * bg-[#E8E044]/[0.055] blur-[90px]
   *
   * The one warm light in the scene, thrown from off-canvas left.
   */
  ambience: {
    pointerEvents: "none",
    position: "absolute",
    left: "-6rem",
    top: 0,
    height: "14rem",
    width: "24rem",
    backgroundColor: "rgb(232 224 68 / 0.055)",
    filter: "blur(90px)",
  },

  // relative grid gap-3 sm:grid-cols-2 xl:grid-cols-4
  grid: {
    position: "relative",
    display: "grid",
    gap: "0.75rem",
    gridTemplateColumns: {
      default: null,
      [SM]: "repeat(2, minmax(0, 1fr))",
      [XL]: "repeat(4, minmax(0, 1fr))",
    },
  },

  /**
   * group relative flex min-h-60 flex-col overflow-hidden rounded-[20px]
   * border p-5 transition-[border-color,background-color,box-shadow,transform]
   * duration-300 focus-visible:outline-none focus-visible:ring-2
   * focus-visible:ring-[#E8E044] motion-reduce:transition-none sm:min-h-64
   * sm:p-6
   *
   * The published values replace the `group` marker: the art tile's shift,
   * fade and desaturation and the footer rule's ink all lived on
   * `group-hover:` utilities. They are published from the shared base so a
   * disabled card keeps the hover response it has today — a disabled `<button>`
   * still matches `:hover`, and `.group:hover` reached it too.
   */
  card: {
    [artTransform.value]: {
      default: "none",
      ":hover": "translate(-0.25rem, 0) scale(1.04)",
    },
    [artIdleOpacity.value]: { default: "0.45", ":hover": "0.8" },
    [artIdleFilter.value]: {
      default: "grayscale(100%)",
      ":hover": "grayscale(0)",
    },
    [metaIdleInk.value]: {
      default: "rgb(255 255 255 / 0.35)",
      ":hover": "rgb(255 255 255 / 0.7)",
    },
    position: "relative",
    display: "flex",
    minHeight: { default: "15rem", [SM]: "16rem" },
    flexDirection: "column",
    overflow: "hidden",
    borderWidth: 1,
    borderStyle: "solid",
    padding: { default: "1.25rem", [SM]: "1.5rem" },
    transitionProperty: {
      default: "border-color, background-color, box-shadow, transform",
      [REDUCED]: "none",
    },
    transitionDuration: "300ms",
    transitionTimingFunction: EASE,
    outlineWidth: { default: null, ":focus-visible": "2px" },
    outlineStyle: { default: null, ":focus-visible": "solid" },
    outlineColor: { default: null, ":focus-visible": "transparent" },
    outlineOffset: { default: null, ":focus-visible": "2px" },
  },
  // cursor-not-allowed border-white/[0.05] bg-black/20 opacity-60
  cardDisabled: {
    cursor: "not-allowed",
    borderColor: "rgb(255 255 255 / 0.05)",
    backgroundColor: "rgb(0 0 0 / 0.2)",
    opacity: 0.6,
    boxShadow: { default: null, ":focus-visible": FOCUS_RING },
  },
  /**
   * border-[#E8E044]/25
   * bg-[linear-gradient(145deg,rgba(232,224,68,0.09),rgba(255,255,255,0.025))]
   * shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_18px_50px_rgba(0,0,0,0.18)]
   */
  cardActive: {
    borderColor: "rgb(232 224 68 / 0.25)",
    backgroundImage:
      "linear-gradient(145deg, rgba(232,224,68,0.09), rgba(255,255,255,0.025))",
    boxShadow: {
      default: CARD_SHADOW_ACTIVE,
      ":focus-visible": `${FOCUS_RING}, ${CARD_SHADOW_ACTIVE}`,
    },
  },
  /**
   * border-white/[0.08] bg-white/[0.025] hover:-translate-y-1
   * hover:border-white/20 hover:bg-white/[0.05]
   * hover:shadow-[0_20px_55px_rgba(0,0,0,0.25)]
   *
   * Hover and focus can be true at once, and Tailwind renders both shadows
   * then — the ring and the elevation are separate slots in one `box-shadow`.
   * The combined key restores that; without it the last matching condition
   * would silently drop the lift shadow off a focused card the pointer is over.
   */
  cardIdle: {
    borderColor: {
      default: "rgb(255 255 255 / 0.08)",
      ":hover": "rgb(255 255 255 / 0.2)",
    },
    backgroundColor: {
      default: "rgb(255 255 255 / 0.025)",
      ":hover": "rgb(255 255 255 / 0.05)",
    },
    transform: { default: "none", ":hover": "translateY(-0.25rem)" },
    boxShadow: {
      default: null,
      ":hover": CARD_SHADOW_HOVER,
      ":focus-visible": FOCUS_RING,
      ":hover:focus-visible": `${FOCUS_RING}, ${CARD_SHADOW_HOVER}`,
    },
  },

  // relative z-10 flex items-center justify-between
  cardHead: {
    position: "relative",
    zIndex: 10,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  // font-meta text-[9px] font-semibold tracking-[0.18em] text-white/30
  cardIndex: {
    fontFamily: text.fontMeta,
    fontSize: "9px",
    fontWeight: 600,
    letterSpacing: text.trackingMetaWider,
    color: "rgb(255 255 255 / 0.3)",
  },

  /**
   * rounded-full border px-2.5 py-1 font-meta text-[8px] font-bold uppercase
   * tracking-[0.13em]
   */
  badge: {
    borderWidth: 1,
    borderStyle: "solid",
    paddingInline: "0.625rem",
    paddingBlock: "0.25rem",
    fontFamily: text.fontMeta,
    fontSize: "8px",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.13em",
  },
  // border-white/[0.07] text-white/25
  badgeDisabled: {
    borderColor: "rgb(255 255 255 / 0.07)",
    color: "rgb(255 255 255 / 0.25)",
  },
  // border-[#E8E044]/30 bg-[#E8E044]/10 text-[#E8E044]
  badgeActive: {
    borderColor: "rgb(232 224 68 / 0.3)",
    backgroundColor: "rgb(232 224 68 / 0.1)",
    color: colors.accent,
  },
  // border-white/10 text-white/40
  badgeIdle: {
    borderColor: "rgb(255 255 255 / 0.1)",
    color: "rgb(255 255 255 / 0.4)",
  },

  /**
   * pointer-events-none absolute -right-4 top-7 grid size-40 place-items-center
   * transition-[transform,opacity,filter] duration-500 group-hover:-translate-x-1
   * group-hover:scale-[1.04]
   */
  art: {
    pointerEvents: "none",
    position: "absolute",
    right: "-1rem",
    top: "1.75rem",
    display: "grid",
    width: "10rem",
    height: "10rem",
    placeItems: "center",
    transform: artTransform.value,
    transitionProperty: "transform, opacity, filter",
    transitionDuration: "500ms",
    transitionTimingFunction: EASE,
  },
  // opacity-100 drop-shadow-[0_16px_34px_rgba(232,224,68,0.14)]
  artActive: {
    opacity: 1,
    filter: "drop-shadow(0 16px 34px rgba(232,224,68,0.14))",
  },
  // opacity-45 grayscale group-hover:opacity-80 group-hover:grayscale-0
  artIdle: {
    opacity: artIdleOpacity.value,
    filter: artIdleFilter.value,
  },
  // size-40 object-contain
  artImage: { width: "10rem", height: "10rem", objectFit: "contain" },

  // relative z-10 mt-20 block max-w-[75%] text-left
  copy: {
    position: "relative",
    zIndex: 10,
    marginTop: "5rem",
    display: "block",
    maxWidth: "75%",
    textAlign: "left",
  },
  // block font-display text-2xl font-semibold tracking-[-0.035em]
  title: {
    display: "block",
    fontFamily: text.fontDisplay,
    fontSize: "1.5rem",
    lineHeight: "2rem",
    fontWeight: 600,
    letterSpacing: "-0.035em",
  },
  titleActive: { color: colors.accent },
  titleIdle: { color: "#fff" },
  // mt-2 block text-xs leading-5 text-white/45
  description: {
    marginTop: "0.5rem",
    display: "block",
    fontSize: "0.75rem",
    lineHeight: "1.25rem",
    color: "rgb(255 255 255 / 0.45)",
  },

  /**
   * relative z-10 mt-6 flex items-center justify-between border-t pt-4
   * text-left font-meta text-[9px] font-bold uppercase tracking-[0.14em]
   */
  meta: {
    position: "relative",
    zIndex: 10,
    marginTop: "1.5rem",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    borderTopWidth: 1,
    borderTopStyle: "solid",
    paddingTop: "1rem",
    textAlign: "left",
    fontFamily: text.fontMeta,
    fontSize: "9px",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
  },
  // border-[#E8E044]/20 text-[#E8E044]
  metaActive: {
    borderTopColor: "rgb(232 224 68 / 0.2)",
    color: colors.accent,
  },
  // border-white/[0.07] text-white/35 group-hover:text-white/70
  metaIdle: {
    borderTopColor: "rgb(255 255 255 / 0.07)",
    color: metaIdleInk.value,
  },
  // text-base leading-none
  metaArrow: { fontSize: "1rem", lineHeight: 1 },

  // grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(320px,1.2fr)]
  footerGrid: {
    display: "grid",
    gap: "0.75rem",
    gridTemplateColumns: {
      default: null,
      [LG]: "minmax(0,1fr) minmax(0,1fr) minmax(320px,1.2fr)",
    },
  },

  /**
   * flex min-w-0 items-center gap-3 rounded-xl border border-white/[0.07]
   * bg-white/[0.025] px-3 py-2.5
   */
  workspace: {
    display: "flex",
    minWidth: 0,
    alignItems: "center",
    gap: "0.75rem",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "rgb(255 255 255 / 0.07)",
    backgroundColor: "rgb(255 255 255 / 0.025)",
    paddingInline: "0.75rem",
    paddingBlock: "0.625rem",
  },
  // size-4 shrink-0 text-[#E8E044]
  workspaceIcon: {
    width: "1rem",
    height: "1rem",
    flexShrink: 0,
    color: colors.accent,
  },
  // min-w-0 flex-1
  workspaceBody: { minWidth: 0, flexGrow: 1, flexShrink: 1, flexBasis: "0%" },
  // mb-0.5 font-meta text-[8px] font-bold uppercase tracking-[0.16em]
  // text-white/30
  workspaceLabel: {
    marginBottom: "0.125rem",
    fontFamily: text.fontMeta,
    fontSize: "8px",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaWide,
    color: "rgb(255 255 255 / 0.3)",
  },
  // truncate text-xs font-semibold text-white/80
  workspaceName: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    fontWeight: 600,
    color: "rgb(255 255 255 / 0.8)",
  },
  // truncate text-[10px] text-white/35
  workspaceHint: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "10px",
    color: "rgb(255 255 255 / 0.35)",
  },

  /**
   * grid gap-1 rounded-xl border border-white/[0.07] bg-white/[0.025] p-1
   *
   * The column track came from an inline `style` because it counts the
   * utilities at runtime; `utilityColumns` below keeps that a style, not a
   * hand-written inline declaration.
   */
  utilities: {
    display: "grid",
    gap: "0.25rem",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "rgb(255 255 255 / 0.07)",
    backgroundColor: "rgb(255 255 255 / 0.025)",
    padding: "0.25rem",
  },
  utilityColumns: (count: number) => ({
    gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))`,
  }),

  /**
   * flex min-h-12 items-center justify-center gap-2 rounded-lg px-2 text-center
   * text-[10px] font-medium transition-colors focus-visible:outline-none
   * focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#E8E044]
   */
  utility: {
    display: "flex",
    minHeight: "3rem",
    alignItems: "center",
    justifyContent: "center",
    gap: "0.5rem",
    paddingInline: "0.5rem",
    textAlign: "center",
    fontSize: "10px",
    fontWeight: 500,
    transitionProperty: COLOR_TRANSITION,
    transitionDuration: "150ms",
    transitionTimingFunction: EASE,
    outlineWidth: { default: null, ":focus-visible": "2px" },
    outlineStyle: { default: null, ":focus-visible": "solid" },
    outlineColor: { default: null, ":focus-visible": "transparent" },
    outlineOffset: { default: null, ":focus-visible": "2px" },
    boxShadow: { default: null, ":focus-visible": FOCUS_RING_INSET },
  },
  // bg-[#E8E044]/10 text-[#E8E044]
  utilityActive: {
    backgroundColor: "rgb(232 224 68 / 0.1)",
    color: colors.accent,
  },
  // text-white/45 hover:bg-white/[0.05] hover:text-white
  utilityIdle: {
    backgroundColor: { default: null, ":hover": "rgb(255 255 255 / 0.05)" },
    color: { default: "rgb(255 255 255 / 0.45)", ":hover": "#fff" },
  },
  // size-3.5 shrink-0
  utilityIcon: { width: "0.875rem", height: "0.875rem", flexShrink: 0 },
});
