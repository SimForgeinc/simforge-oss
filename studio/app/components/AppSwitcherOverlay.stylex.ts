/**
 * StyleX styles for `AppSwitcherOverlay` — the full-screen app switcher that
 * the top bar's logo button opens.
 *
 * The surface is deliberately plain: a centred column with three tabs and one
 * footer line. The overlay and dialog fades are the ones the switcher shipped
 * with (`tailwindcss-animate`'s `fade-in-0`/`fade-out-0` and the former
 * `app-switcher-center-fade` class in `styles.css`), each keeping the
 * `prefers-reduced-motion` cancel the original carried.
 */

import * as stylex from "@stylexjs/stylex";
import {
  colors,
  layers,
  text,
  space,
  layout,
} from "@simforge-oss/studio-ui/stylex/tokens.stylex";

/** The breakpoints this overlay responds to. */
const SM = "@media (min-width: 640px)";
const LG = "@media (min-width: 1024px)";
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
    overflow: "hidden",
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
   * fixed right-5 top-5 z-20 grid size-10 place-items-center text-white/40
   * transition-colors hover:bg-white/[0.06] hover:text-white
   * focus-visible:ring-2 focus-visible:ring-[#E8E044] sm:right-8 sm:top-8
   *
   * `z-20` is local to the dialog's own stacking context, so it stays a
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
   * The page frame: a centred column, narrow enough that three tabs read as
   * one row of choices rather than a wall of cards. It is never taller than
   * the viewport, so the switcher does not scroll on a desktop screen.
   */
  container: {
    position: "relative",
    marginInline: "auto",
    display: "grid",
    alignContent: "safe center",
    gap: "1.5rem",
    minHeight: "100%",
    height: "100%",
    overflow: "hidden",
    width: "100%",
    maxWidth: layout.utilityFrame,
    paddingInline: { default: layout.gutterNarrow, [SM]: layout.gutter },
    paddingBlock: space.xxl,
  },

  /** The three product tabs: stacked on narrow viewports, a row from LG. */
  tabs: {
    display: "grid",
    gap: "0.75rem",
    gridTemplateColumns: {
      default: null,
      [LG]: "repeat(3, minmax(0, 1fr))",
    },
  },

  /**
   * One tab: a hairline plate with its name, what the page is, and the three
   * things it does. No artwork, no badge, no index.
   */
  tab: {
    "@media (max-width: 1023px)": { display: "grid", gridTemplateColumns: "4rem minmax(0, 1fr)", columnGap: space.lg },
    display: "flex",
    flexDirection: "column",
    gap: "0.5rem",
    minWidth: 0,
    borderWidth: 1,
    borderStyle: "solid",
    paddingInline: "1rem",
    paddingBlock: "1rem",
    textAlign: "left",
    transitionProperty: {
      default: "border-color, background-color, color",
      [REDUCED]: "none",
    },
    transitionDuration: "150ms",
    transitionTimingFunction: EASE,
    outlineWidth: { default: null, ":focus-visible": "2px" },
    outlineStyle: { default: null, ":focus-visible": "solid" },
    outlineColor: { default: null, ":focus-visible": "transparent" },
    outlineOffset: { default: null, ":focus-visible": "2px" },
  },
  tabIdle: {
    borderColor: {
      default: "rgb(255 255 255 / 0.08)",
      ":hover": "rgb(255 255 255 / 0.2)",
    },
    backgroundColor: {
      default: "rgb(255 255 255 / 0.025)",
      ":hover": "rgb(255 255 255 / 0.05)",
    },
    boxShadow: { default: null, ":focus-visible": FOCUS_RING },
  },
  tabActive: {
    borderColor: "rgb(232 224 68 / 0.25)",
    backgroundColor: "rgb(232 224 68 / 0.07)",
    boxShadow: { default: null, ":focus-visible": FOCUS_RING },
  },
  tabDisabled: {
    cursor: "not-allowed",
    borderColor: "rgb(255 255 255 / 0.05)",
    backgroundColor: "rgb(0 0 0 / 0.2)",
    opacity: 0.6,
    boxShadow: { default: null, ":focus-visible": FOCUS_RING },
  },

  tabHead: { display: "flex", alignItems: "center", gap: "0.5rem", "@media (max-width: 1023px)": { gridColumn: 2 } },
  /**
   * The app's artwork: a square tile at the top of the tab, dimmed until the
   * tab is current or hovered, so the row reads as three pictures first and
   * three names second.
   */
  art: {
    display: "grid",
    placeItems: "center",
    width: "100%",
    aspectRatio: "4 / 3",
    paddingBlock: "0.5rem",
    "@media (max-width: 1023px)": { aspectRatio: "1", width: "4rem", gridRow: "1 / span 3", alignSelf: "center" },
  },
  /** The whole picture, never clipped: it is the square source scaled to fit the tile. */
  artImage: {
    display: "block",
    width: "auto",
    height: "100%",
    maxWidth: "100%",
    objectFit: "contain",
    transitionProperty: { default: "opacity, filter", [REDUCED]: "none" },
    transitionDuration: "300ms",
    transitionTimingFunction: EASE,
  },
  artFrame: { display: "grid", placeItems: "center", height: "100%", width: "100%", minHeight: 0 },
  artIdle: { opacity: 0.55, filter: "grayscale(0.6)" },
  artActive: { opacity: 1, filter: "none" },
  artDisabled: { opacity: 0.3, filter: "grayscale(1)" },
  /** Inline views (Render Settings) replace the tabs inside the same column. */
  inlineView: { display: "grid", gap: space.xl, minWidth: 0, minHeight: 0, overflow: "hidden" },
  inlineHead: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: space.lg },
  inlineBack: {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.375rem",
    paddingBlock: "0.375rem",
    paddingInline: "0.75rem",
    fontSize: "0.75rem",
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: { default: "rgb(255 255 255 / 0.6)", ":hover": "#fff" },
    backgroundColor: "rgb(255 255 255 / 0.04)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "rgb(255 255 255 / 0.1)",
    cursor: "pointer",
    boxShadow: { default: null, ":focus-visible": FOCUS_RING },
  },
  inlineBackIcon: { width: "0.875rem", height: "0.875rem" },
  tabIcon: {
    width: "1rem",
    height: "1rem",
    flexShrink: 0,
    color: "rgb(255 255 255 / 0.45)",
  },
  tabIconActive: { color: colors.accent },
  tabTitle: {
    fontFamily: text.fontDisplay,
    fontSize: "1.125rem",
    lineHeight: "1.5rem",
    fontWeight: 600,
    letterSpacing: "-0.03em",
  },
  tabTitleActive: { color: colors.accent },
  tabTitleIdle: { color: "#fff" },
  tabDescription: {
    "@media (max-width: 1023px)": { gridColumn: 2 },
    fontFamily: text.fontMeta,
    fontSize: "10px",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaWide,
    color: colors.textSubtle,
  },
  /** The three capability phrases, one per line. */
  tabHighlights: {
    display: "grid",
    gap: "0.125rem",
    marginTop: "0.25rem",
    "@media (max-width: 1023px)": { gridColumn: 2 },
  },
  tabHighlight: {
    fontSize: "0.75rem",
    lineHeight: "1.125rem",
    color: "rgb(255 255 255 / 0.45)",
  },

  /** Utilities on the left, account and graphics level on the right. */
  footer: {
    display: "grid",
    gap: "0.75rem",
    alignItems: "center",
    gridTemplateColumns: {
      default: null,
      [LG]: "minmax(0, 1fr) auto",
    },
  },
  footerAside: {
    display: "flex",
    alignItems: "center",
    justifyContent: { default: "flex-start", [LG]: "flex-end" },
    gap: "0.5rem",
    minWidth: 0,
  },

  /** grid gap-1 border border-white/[0.07] bg-white/[0.025] p-1 */
  utilities: {
    display: "flex",
    flexWrap: "wrap",
    gap: "0.25rem",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "rgb(255 255 255 / 0.07)",
    backgroundColor: "rgb(255 255 255 / 0.025)",
    padding: "0.25rem",
  },

  /**
   * flex min-h-8 items-center gap-2 px-2 text-[10px] font-medium
   * transition-colors focus-visible:ring-2 focus-visible:ring-inset
   * focus-visible:ring-[#E8E044]
   */
  utility: {
    display: "flex",
    minHeight: "2rem",
    alignItems: "center",
    gap: "0.375rem",
    paddingInline: "0.5rem",
    fontSize: "10px",
    fontWeight: 500,
    whiteSpace: "nowrap",
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

  /**
   * The graphics level: one square icon button that advances to the next
   * level, sized to the utility row beside it.
   */
  graphicsButton: {
    display: "grid",
    placeItems: "center",
    width: "2.25rem",
    height: "2.25rem",
    flexShrink: 0,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: {
      default: "rgb(255 255 255 / 0.07)",
      ":hover": "rgb(255 255 255 / 0.2)",
    },
    backgroundColor: {
      default: "rgb(255 255 255 / 0.025)",
      ":hover": "rgb(255 255 255 / 0.05)",
    },
    color: { default: colors.accent, ":hover": colors.accent },
    transitionProperty: COLOR_TRANSITION,
    transitionDuration: "150ms",
    transitionTimingFunction: EASE,
    outlineWidth: { default: null, ":focus-visible": "2px" },
    outlineStyle: { default: null, ":focus-visible": "solid" },
    outlineColor: { default: null, ":focus-visible": "transparent" },
    outlineOffset: { default: null, ":focus-visible": "2px" },
    boxShadow: { default: null, ":focus-visible": FOCUS_RING_INSET },
  },
  graphicsIcon: { width: "1rem", height: "1rem" },
});
