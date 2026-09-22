/**
 * StyleX styles for `AppStage` — the app switcher's chrome, applied to a
 * route instead of to a dialog.
 *
 * Every value here is one the switcher already ships
 * (`AppSwitcherOverlay.stylex.ts`): the same hairline plates over the same
 * `SkyCloudBackdrop`, the same meta eyebrow, the same accent focus ring. A
 * utility route rendered in this chrome is meant to be indistinguishable from
 * a switcher tab, so nothing new is invented — the switcher's plate and tab
 * atoms are exported from here as `plate` for the routes that build rows of
 * their own.
 *
 * The geometry is the one rule the switcher's dialog did not need: the frame
 * is exactly the height of its container and never taller, and the only
 * scroller is `body`. The page itself therefore cannot scroll — an app is a
 * fixed stage with panes inside it, not a document.
 */

import * as stylex from "@stylexjs/stylex";
import { colors, layers, layout, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

const SM = "@media (min-width: 640px)";
const LG = "@media (min-width: 1024px)";
const REDUCED = "@media (prefers-reduced-motion: reduce)";

/** Tailwind's default transition curve and its `transition-colors` set. */
const EASE = "cubic-bezier(0.4, 0, 0.2, 1)";
const COLOR_TRANSITION =
  "color, background-color, border-color, text-decoration-color, fill, stroke";

const FOCUS_RING = `0 0 0 2px ${colors.accent}`;
const FOCUS_RING_INSET = `inset 0 0 0 2px ${colors.accent}`;

export const styles = stylex.create({
  /**
   * The stage: the full height of the dashboard's main area, clipped. Nothing
   * inside can make the document scroll.
   */
  stage: {
    position: "relative",
    height: "100%",
    minHeight: 0,
    overflow: "hidden",
    color: "#fff",
  },

  /** A single bounded body; route chrome belongs to AppTopBar. */
  frame: {
    position: "relative",
    zIndex: layers.raised,
    display: "grid",
    gridTemplateRows: "minmax(0, 1fr)",
    height: "100%",
    minHeight: 0,
    width: "100%",
    maxWidth: layout.utilityFrame,
    marginInline: "auto",
    padding: { default: layout.gutterNarrow, [SM]: layout.gutter, [LG]: layout.gutterWide },
  },

  description: {
    marginTop: "0.25rem",
    fontSize: text.sizeSm,
    lineHeight: text.lineNormal,
    color: colors.textSubtle,
  },

  /**
   * The one scroller on the stage. `overscrollBehavior: contain` keeps a
   * flicked pane from handing the gesture to whatever is behind the stage.
   *
   * The `minmax(0, 1fr)` track is what keeps a pane inside the frame. A grid
   * item defaults to `min-width: auto` and so refuses to shrink below its own
   * min-content, so a single row that cannot wrap - a flex card header, a
   * filesystem path, a target triple - widens the track past the frame, and
   * the frame hides overflow rather than scrolling it, so the excess is
   * silently clipped. An explicit `minmax(0, ...)` lets the pane shrink and
   * leaves the wrapping rules inside it to decide what happens next.
   */
  body: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    alignContent: "start",
    gap: "0.75rem",
    height: "100%",
    minHeight: 0,
    minWidth: 0,
    overflowY: "auto",
    overscrollBehavior: "contain",
  },
  /**
   * A stage that is a fixed instrument rather than a document: the body never
   * scrolls, its one row is the frame's height, and the page composes bounded
   * panes (`plate.scroller`) that scroll their own lists inside it.
   */
  bodyFill: {
    gridTemplateRows: "minmax(0, 1fr)",
    alignContent: "stretch",
    overflowY: "hidden",
  },
});

/**
 * The switcher's plate, tab and fact atoms, for routes that lay out rows of
 * their own inside {@link styles.body}. Same borders, fills and accent as a
 * switcher tab.
 */
export const plate = stylex.create({
  /** A hairline plate: the switcher tab's idle treatment. */
  root: {
    display: "grid",
    gap: "0.5rem",
    minWidth: 0,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "rgb(255 255 255 / 0.08)",
    backgroundColor: "rgb(255 255 255 / 0.025)",
    paddingInline: "1rem",
    paddingBlock: "1rem",
  },
  /** A plate that frames its own scroller: header fixed, list scrolling. */
  scroller: {
    display: "grid",
    gridTemplateRows: "auto minmax(0, 1fr)",
    gap: "0.5rem",
    minHeight: 0,
    overflow: "hidden",
  },
  pane: {
    minHeight: 0,
    overflowY: "auto",
    overscrollBehavior: "contain",
  },
  /** Two columns from LG, stacked below it — the switcher's tab row rule. */
  columns: {
    display: "grid",
    gap: "0.75rem",
    minHeight: 0,
    gridTemplateColumns: { default: null, [LG]: "repeat(2, minmax(0, 1fr))" },
  },
  sidebarColumns: {
    display: "grid",
    gap: "0.75rem",
    minHeight: 0,
    gridTemplateColumns: { default: null, [LG]: "minmax(0, 20rem) minmax(0, 1fr)" },
  },

  eyebrow: {
    fontFamily: text.fontMeta,
    fontSize: "10px",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaWide,
    color: "rgb(255 255 255 / 0.3)",
  },
  title: {
    fontFamily: text.fontDisplay,
    fontSize: "1rem",
    lineHeight: "1.375rem",
    fontWeight: 600,
    letterSpacing: "-0.02em",
    color: "#fff",
  },
  copy: {
    fontSize: "0.75rem",
    lineHeight: "1.125rem",
    color: "rgb(255 255 255 / 0.45)",
  },
  row: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "0.5rem",
    minWidth: 0,
  },
  spread: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "0.5rem",
    minWidth: 0,
  },
  truncate: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },

  /** Name/value facts: the switcher's highlight lines, given a label. */
  facts: { display: "grid", gap: "0.375rem", margin: 0 },
  fact: { display: "flex", alignItems: "baseline", gap: "0.5rem", minWidth: 0 },
  factLabel: {
    flexShrink: 0,
    width: "6.5rem",
    fontFamily: text.fontMeta,
    fontSize: "10px",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaNarrow,
    color: "rgb(255 255 255 / 0.3)",
  },
  factValue: {
    margin: 0,
    minWidth: 0,
    fontSize: "0.75rem",
    lineHeight: "1.125rem",
    color: "rgb(255 255 255 / 0.65)",
  },
  mono: { fontFamily: text.fontMono },
  accent: { color: colors.accent },

  /** The switcher's utility row, reused as a segmented tab strip. */
  tabs: {
    display: "flex",
    flexWrap: "wrap",
    gap: "0.25rem",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "rgb(255 255 255 / 0.07)",
    backgroundColor: "rgb(255 255 255 / 0.025)",
    padding: "0.25rem",
  },
  tab: {
    display: "flex",
    minHeight: "2rem",
    alignItems: "center",
    gap: "0.375rem",
    paddingInline: "0.625rem",
    fontSize: "10px",
    fontWeight: 500,
    whiteSpace: "nowrap",
    transitionProperty: { default: COLOR_TRANSITION, [REDUCED]: "none" },
    transitionDuration: "150ms",
    transitionTimingFunction: EASE,
    outlineWidth: { default: null, ":focus-visible": "2px" },
    outlineStyle: { default: null, ":focus-visible": "solid" },
    outlineColor: { default: null, ":focus-visible": "transparent" },
    outlineOffset: { default: null, ":focus-visible": "2px" },
    boxShadow: { default: null, ":focus-visible": FOCUS_RING_INSET },
  },
  tabActive: {
    backgroundColor: "rgb(232 224 68 / 0.1)",
    color: colors.accent,
  },
  tabIdle: {
    backgroundColor: { default: null, ":hover": "rgb(255 255 255 / 0.05)" },
    color: { default: "rgb(255 255 255 / 0.45)", ":hover": "#fff" },
  },
  tabIcon: { width: "0.875rem", height: "0.875rem", flexShrink: 0 },

  /** A pill stating a fact about the account, never a quota or a balance. */
  pill: {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.25rem",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "rgb(255 255 255 / 0.12)",
    paddingInline: "0.375rem",
    paddingBlock: "0.125rem",
    fontFamily: text.fontMeta,
    fontSize: "10px",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaNarrow,
    color: "rgb(255 255 255 / 0.55)",
  },
  pillAccent: {
    borderColor: "rgb(232 224 68 / 0.35)",
    backgroundColor: "rgb(232 224 68 / 0.1)",
    color: colors.accent,
  },
  pillMuted: { color: "rgb(255 255 255 / 0.35)" },

  /** The switcher's own button treatment, for actions on a plate. */
  button: {
    height: "2rem",
    gap: "0.375rem",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: {
      default: "rgb(255 255 255 / 0.14)",
      ":hover": "rgb(255 255 255 / 0.28)",
    },
    backgroundColor: {
      default: "rgb(255 255 255 / 0.025)",
      ":hover": "rgb(255 255 255 / 0.06)",
    },
    paddingInline: "0.75rem",
    fontSize: "0.75rem",
    color: "#fff",
    boxShadow: { default: null, ":focus-visible": FOCUS_RING },
  },
  buttonAccent: {
    borderColor: "rgb(232 224 68 / 0.4)",
    backgroundColor: {
      default: "rgb(232 224 68 / 0.12)",
      ":hover": "rgb(232 224 68 / 0.2)",
    },
    color: colors.accent,
  },
  icon: { width: "0.875rem", height: "0.875rem", flexShrink: 0 },
  spinner: {
    animationName: stylex.keyframes({
      from: { transform: "rotate(0deg)" },
      to: { transform: "rotate(360deg)" },
    }),
    animationDuration: "1s",
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
  },

  /** A message about the last action; success and failure share the shape. */
  notice: {
    display: "flex",
    alignItems: "flex-start",
    gap: "0.5rem",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "rgb(232 224 68 / 0.3)",
    backgroundColor: "rgb(232 224 68 / 0.08)",
    paddingInline: "0.75rem",
    paddingBlock: "0.5rem",
    fontSize: "0.75rem",
    lineHeight: "1.125rem",
    color: colors.accent,
  },
  noticeError: {
    borderColor: "rgb(248 113 113 / 0.35)",
    backgroundColor: "rgb(248 113 113 / 0.1)",
    color: "#fca5a5",
  },

  /** The `ul` reset used by every list on these plates. */
  list: { display: "grid", gap: "0.25rem", margin: 0, padding: 0, listStyle: "none" },
  item: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "0.5rem",
    minWidth: 0,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "rgb(255 255 255 / 0.06)",
    paddingInline: "0.625rem",
    paddingBlock: "0.5rem",
  },
  empty: {
    fontSize: "0.75rem",
    lineHeight: "1.125rem",
    color: "rgb(255 255 255 / 0.35)",
  },
});
