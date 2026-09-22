/**
 * StyleX styles for `AppSwitcherOverlay` — the full-screen app switcher that
 * the top bar's logo button opens.
 *
 * The surface is deliberately plain: a centred column with three equal app
 * cards and one continuous bar beneath them. The overlay and dialog fades are the ones the switcher shipped
 * with (`tailwindcss-animate`'s `fade-in-0`/`fade-out-0` and the former
 * `app-switcher-center-fade` class in `styles.css`), each keeping the
 * `prefers-reduced-motion` cancel the original carried.
 */

import * as stylex from "@stylexjs/stylex";
import {
  colors,
  layers,
  layout,
  motion,
  space,
  stroke,
  text,
} from "@simforge-oss/studio-ui/stylex/tokens.stylex";
/** Wide enough for utilities and account segments to share one bar line. */
const XL = "@media (min-width: 1200px)";
const COLOR_TRANSITION =
  "color, background-color, border-color, text-decoration-color, fill, stroke";

/**
 * `focus-visible:ring-2 focus-visible:ring-[#E8E044]` — Tailwind draws a ring
 * as a box-shadow; the offset ring is zero-width here, so the visible half is
 * the 2px one. `ring-inset` moves the same shadow inside the box.
 */
const FOCUS_RING = `0 0 0 2px ${colors.accent}`;
const FOCUS_RING_INSET = `inset 0 0 0 2px ${colors.accent}`;
/** The bar's one height: every utility and segment is exactly this tall. */
const BAR_HEIGHT = "3.25rem";


/**
 * `animate-in fade-in-0` / `animate-out fade-out-0` from `tailwindcss-animate`:
 * the plugin animates from its own reset transform, so the frame it starts
 * from is an explicit identity transform, not `none`.
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
 * `styles.css`: 180ms out of nothing on open, 120ms back on close.
 */
const centerFadeIn = stylex.keyframes({
  from: { opacity: 0 },
  to: { opacity: 1 },
});
const centerFadeOut = stylex.keyframes({
  from: { opacity: 1 },
  to: { opacity: 0 },
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
    animationDuration: motion.durStandard,
    animationName: {
      default: null,
      "[data-state=open]": { default: enter, [layout.reducedMotion]: "none" },
      "[data-state=closed]": { default: exit, [layout.reducedMotion]: "none" },
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
    overflow: "hidden",
    color: colors.ink,
    outlineWidth: stroke.thick,
    outlineStyle: "solid",
    outlineColor: "transparent",
    outlineOffset: "2px",
    animationDuration: {
      default: null,
      "[data-state=open]": motion.durBase,
      "[data-state=closed]": motion.durFast,
    },
    animationTimingFunction: {
      default: null,
      "[data-state=open]": motion.easeOut,
      "[data-state=closed]": motion.easeIn,
    },
    animationFillMode: {
      default: null,
      "[data-state=open]": "both",
      "[data-state=closed]": "both",
    },
    animationName: {
      default: null,
      "[data-state=open]": { default: centerFadeIn, [layout.reducedMotion]: "none" },
      "[data-state=closed]": { default: centerFadeOut, [layout.reducedMotion]: "none" },
    },
  },

  /**
   * fixed right-5 top-5 z-20 grid size-10 place-items-center text-white/40
   * transition-colors hover:bg-white/[0.06] hover:text-white
   * focus-visible:ring-2 focus-visible:ring-[#E8E044] sm:right-8 sm:top-8
   *
   * `z-20` is local to the dialog's own stacking context, so it stays a
   * literal rather than joining the app-wide `layers` scale.
   */
  close: {
    position: "fixed",
    right: { default: "1.25rem", [layout.bpSm]: "2rem" },
    top: { default: "1.25rem", [layout.bpSm]: "2rem" },
    zIndex: layers.float,
    display: "grid",
    width: "2.5rem",
    height: "2.5rem",
    placeItems: "center",
    color: { default: "rgb(255 255 255 / 0.4)", ":hover": colors.ink },
    backgroundColor: { default: null, ":hover": colors.fill },
  },
  // size-5
  closeIcon: { width: "1.25rem", height: "1.25rem" },


  /**
   * The page frame: a centred column, never taller than the viewport, so the
   * switcher does not scroll on a desktop screen.
   */
  container: {
    position: "relative",
    marginInline: "auto",
    display: "grid",
    alignContent: "safe center",
    gap: space.s4,
    minHeight: "100%",
    height: "100%",
    overflow: "hidden",
    width: "100%",
    maxWidth: "1080px",
    paddingInline: { default: layout.gutterNarrow, [layout.bpSm]: layout.gutter },
    paddingBlock: space.s6,
  },

  /** The three app cards: stacked on narrow viewports, one row of equal cards from LG. */
  tabs: {
    display: "grid",
    gap: space.s3,
    gridTemplateColumns: { default: "minmax(0, 1fr)", [layout.bpLg]: "repeat(3, minmax(0, 1fr))" },
    gridAutoRows: { default: null, [layout.bpLg]: "1fr" },
  },

  /**
   * One app card: an artwork stage over a text body. Beside each other from
   * LG, the stage on the left below it. Every card has the same frame, so the
   * row reads as three equal choices.
   */
  tab: {
    position: "relative",
    display: "grid",
    gridTemplateColumns: { default: "7rem minmax(0, 1fr)", [layout.bpLg]: "minmax(0, 1fr)" },
    gridTemplateRows: { default: null, [layout.bpLg]: "auto 1fr" },
    minWidth: 0,
    overflow: "hidden",
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    textAlign: "left",
    transitionProperty: { default: "border-color, background-color, box-shadow", [layout.reducedMotion]: "none" },
    transitionDuration: "200ms",
    transitionTimingFunction: motion.easeStandard,
    outlineWidth: { default: null, ":focus-visible": stroke.thick },
    outlineStyle: { default: null, ":focus-visible": "solid" },
    outlineColor: { default: null, ":focus-visible": "transparent" },
    outlineOffset: { default: null, ":focus-visible": "2px" },
  },
  tabIdle: {
    borderColor: { default: colors.hairline, ":hover": "rgb(255 255 255 / 0.18)" },
    backgroundColor: { default: colors.fillFaint, ":hover": colors.fillSubtle },
    boxShadow: { default: null, ":focus-visible": FOCUS_RING },
  },
  /** The app you are in: an accent rule across the top and a warmer plate. */
  tabActive: {
    borderColor: "rgb(232 224 68 / 0.28)",
    backgroundColor: "rgb(232 224 68 / 0.05)",
    boxShadow: {
      default: `inset 0 2px 0 ${colors.accent}`,
      ":focus-visible": `inset 0 2px 0 ${colors.accent}, ${FOCUS_RING}`,
    },
  },
  tabDisabled: {
    cursor: "not-allowed",
    borderColor: colors.hairlineSubtle,
    backgroundColor: "rgb(0 0 0 / 0.2)",
    opacity: 0.6,
  },

  /**
   * The artwork stage: a fixed-height well with a soft floor light, so every
   * card's picture sits at the same height whatever the card's text.
   */
  art: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: { default: "auto", [layout.bpLg]: "11rem" },
    minHeight: { default: "7rem", [layout.bpLg]: null },
    paddingBlock: { default: space.s3, [layout.bpLg]: space.s5 },
    paddingInline: space.s3,
    borderColor: colors.hairline,
    borderStyle: "solid",
    borderWidth: 0,
    borderBottomWidth: { default: 0, [layout.bpLg]: stroke.hairline },
    borderInlineEndWidth: { default: stroke.hairline, [layout.bpLg]: 0 },
    backgroundImage:
      "radial-gradient(60% 55% at 50% 62%, rgb(255 255 255 / 0.06), transparent 70%)",
  },
  artStageActive: {
    backgroundImage:
      "radial-gradient(60% 55% at 50% 62%, rgb(232 224 68 / 0.1), transparent 70%)",
  },
  /** The box the artwork is fitted into; each picture takes a share of its height. */
  artFrame: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "100%",
    height: { default: "4.5rem", [layout.bpLg]: "8.5rem" },
    minHeight: 0,
    transitionProperty: { default: "opacity, filter, transform", [layout.reducedMotion]: "none" },
    transitionDuration: "300ms",
    transitionTimingFunction: motion.easeStandard,
  },
  /** Card hover and keyboard focus both wake the artwork inside it. */
  artIdle: {
    opacity: { default: 0.6, [stylex.when.ancestor(":hover")]: 1, [stylex.when.ancestor(":focus-visible")]: 1 },
    filter: {
      default: "grayscale(0.6)",
      [stylex.when.ancestor(":hover")]: "none",
      [stylex.when.ancestor(":focus-visible")]: "none",
    },
    transform: { default: null, [stylex.when.ancestor(":hover")]: "translateY(-3px)" },
  },
  artActive: { opacity: 1, filter: "none" },
  artDisabled: { opacity: 0.3, filter: "grayscale(1)" },
  /**
   * The picture cropped to its drawn content: the source files carry uneven
   * transparent margins, so the crop, not the file, is what gets sized.
   */
  artCrop: {
    position: "relative",
    display: "block",
    maxWidth: "100%",
    overflow: "hidden",
  },
  artImage: {
    position: "absolute",
    display: "block",
    maxWidth: "none",
  },

  /** Inline views (Render Settings) replace the tabs inside the same column. */
  inlineView: { display: "grid", gap: space.s4, minWidth: 0, minHeight: 0, overflow: "hidden" },
  inlineHead: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: space.s3 },
  inlineBack: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1_5,
    paddingBlock: space.s1_5,
    paddingInline: space.s3,
    fontSize: text.sizeXs,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: { default: "rgb(255 255 255 / 0.6)", ":hover": colors.ink },
    backgroundColor: colors.fillSubtle,
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: "rgb(255 255 255 / 0.1)",
    cursor: "pointer",
    boxShadow: { default: null, ":focus-visible": FOCUS_RING },
  },
  inlineBackIcon: { width: "0.875rem", height: "0.875rem" },

  /** The card's words: name, what it is, and what it does. */
  tabBody: {
    display: "grid",
    alignContent: "start",
    gap: space.s1_5,
    minWidth: 0,
    paddingInline: { default: space.s4, [layout.bpLg]: space.s5 },
    paddingBlock: { default: space.s3_5, [layout.bpLg]: "1rem 1.25rem" },
  },
  tabHead: { display: "flex", alignItems: "center", gap: space.s2, minWidth: 0 },
  tabIcon: {
    width: "1rem",
    height: "1rem",
    flexShrink: 0,
    color: colors.inkMuted,
  },
  tabIconActive: { color: colors.accent },
  tabTitle: {
    fontFamily: text.fontDisplay,
    fontSize: text.sizeLg,
    lineHeight: text.lineBase,
    fontWeight: text.weightSemibold,
    letterSpacing: "-0.03em",
  },
  tabTitleActive: { color: colors.accent },
  tabTitleIdle: { color: colors.ink },
  tabDescription: {
    fontFamily: text.fontMeta,
    fontSize: "10px",
    lineHeight: text.lineMicro,
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaWide,
    color: colors.textSubtle,
  },
  /** The three capability phrases, one per line. */
  tabHighlights: {
    display: "grid",
    gap: space.s0_5,
    marginTop: space.s1_5,
    paddingTop: space.s2_5,
    borderTopWidth: stroke.hairline,
    borderTopStyle: "solid",
    borderTopColor: colors.hairlineSubtle,
  },
  tabHighlight: {
    fontSize: text.sizeXs,
    lineHeight: "1.125rem",
    color: colors.inkMuted,
  },

  /**
   * The bar under the cards: one hairline frame holding the utilities and,
   * after them, the workspace and account segments. One line from
   * XL; below it the same frame holds two rows split by a hairline.
   */
  footer: {
    display: "flex",
    flexDirection: { default: "column", [XL]: "row" },
    alignItems: "stretch",
    minWidth: 0,
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: colors.hairline,
    backgroundColor: "rgb(14 14 16 / 0.72)",
    backdropFilter: "blur(14px)",
  },
  /** The utilities: text tabs, scrolling sideways rather than wrapping. */
  utilities: {
    display: "flex",
    flex: { default: null, [XL]: "1 1 auto" },
    minWidth: 0,
    overflowX: "auto",
    scrollbarWidth: "none",
    // On a phone the row scrolls; the fade says there is more to the right.
    maskImage: { default: "linear-gradient(to right, #000 calc(100% - 2.5rem), transparent)", [layout.bpSm]: null },
    borderBottomWidth: { default: stroke.hairline, [XL]: 0 },
    borderBottomStyle: "solid",
    borderBottomColor: colors.hairline,
  },
  utility: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: space.s2,
    height: BAR_HEIGHT,
    paddingInline: space.s3_5,
    fontSize: "11px",
    fontWeight: text.weightMedium,
    whiteSpace: "nowrap",
    cursor: "pointer",
    transitionProperty: `${COLOR_TRANSITION}, box-shadow`,
    transitionDuration: motion.durStandard,
    transitionTimingFunction: motion.easeStandard,
    outlineWidth: { default: null, ":focus-visible": stroke.thick },
    outlineStyle: { default: null, ":focus-visible": "solid" },
    outlineColor: { default: null, ":focus-visible": "transparent" },
    outlineOffset: { default: null, ":focus-visible": "-2px" },
  },
  /** The current utility: accent text over an accent underline. */
  utilityActive: {
    color: colors.accent,
    backgroundColor: "rgb(232 224 68 / 0.06)",
    boxShadow: {
      default: `inset 0 -2px 0 ${colors.accent}`,
      ":focus-visible": FOCUS_RING_INSET,
    },
  },
  utilityIdle: {
    backgroundColor: { default: null, ":hover": colors.fillSubtle },
    color: { default: "rgb(255 255 255 / 0.55)", ":hover": colors.ink },
    boxShadow: { default: null, ":focus-visible": FOCUS_RING_INSET },
  },
  utilityIcon: { width: "0.875rem", height: "0.875rem", flexShrink: 0 },

  /** Workspace and account: segments divided by hairlines. */
  footerAside: {
    display: "flex",
    flexShrink: 0,
    alignItems: "stretch",
    minWidth: 0,
    height: BAR_HEIGHT,
  },
});
