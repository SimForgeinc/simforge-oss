/**
 * The app switcher's plate, tab and fact atoms, for utility routes rendered
 * in `PageShell` (the frame itself now lives in studio-ui).
 *
 * Every value here is one the switcher already ships
 * (`AppSwitcherOverlay.stylex.ts`): the same hairline plates over the same
 * `SkyCloudBackdrop`, the same meta eyebrow, the same accent focus ring. A
 * utility route rendered in this chrome is meant to be indistinguishable from
 * a switcher tab, so nothing new is invented — the switcher's plate and tab
 * atoms are exported from here as `plate` for the routes that build rows of
 * their own.
 *
 */

import * as stylex from "@stylexjs/stylex";
import { colors, layout, motion, space, stroke, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";
const COLOR_TRANSITION =
  "color, background-color, border-color, text-decoration-color, fill, stroke";

const FOCUS_RING = `0 0 0 2px ${colors.accent}`;
const FOCUS_RING_INSET = `inset 0 0 0 2px ${colors.accent}`;

/**
 * The switcher's plate, tab and fact atoms, for routes that lay out rows of
 * their own inside {@link styles.body}. Same borders, fills and accent as a
 * switcher tab.
 */
export const plate = stylex.create({
  /** A hairline plate: the switcher tab's idle treatment. */
  root: {
    display: "grid",
    gap: space.s2,
    minWidth: 0,
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: colors.hairline,
    backgroundColor: "rgb(255 255 255 / 0.025)",
    paddingInline: space.s4,
    paddingBlock: space.s4,
  },
  /** A plate that frames its own scroller: header fixed, list scrolling. */
  scroller: {
    display: "grid",
    gridTemplateRows: "auto minmax(0, 1fr)",
    gap: space.s2,
    minHeight: 0,
    overflow: "hidden",
  },
  pane: {
    minHeight: 0,
    overflowY: "auto",
    overscrollBehavior: "contain",
  },
  sidebarColumns: {
    display: "grid",
    gap: space.s3,
    minHeight: 0,
    gridTemplateColumns: { default: null, [layout.bpLg]: "minmax(0, 20rem) minmax(0, 1fr)" },
  },

  eyebrow: {
    fontFamily: text.fontMeta,
    fontSize: "10px",
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaWide,
    color: "rgb(255 255 255 / 0.3)",
  },
  title: {
    fontFamily: text.fontDisplay,
    fontSize: text.sizeBase,
    lineHeight: "1.375rem",
    fontWeight: text.weightSemibold,
    letterSpacing: "-0.02em",
    color: colors.ink,
  },
  copy: {
    fontSize: text.sizeXs,
    lineHeight: "1.125rem",
    color: colors.inkMuted,
  },
  row: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space.s2,
    minWidth: 0,
  },
  spread: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.s2,
    minWidth: 0,
  },
  truncate: {
    minWidth: 0,
  },

  /** Name/value facts: the switcher's highlight lines, given a label. */
  facts: { display: "grid", gap: space.s1_5, margin: 0 },
  fact: { display: "flex", alignItems: "baseline", gap: space.s2, minWidth: 0 },
  factLabel: {
    flexShrink: 0,
    width: "6.5rem",
    fontFamily: text.fontMeta,
    fontSize: "10px",
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaNarrow,
    color: "rgb(255 255 255 / 0.3)",
  },
  factValue: {
    margin: 0,
    minWidth: 0,
    fontSize: text.sizeXs,
    lineHeight: "1.125rem",
    color: "rgb(255 255 255 / 0.65)",
  },
  mono: { fontFamily: text.fontMono },
  accent: { color: colors.accent },

  /** The switcher's utility row, reused as a segmented tab strip. */
  tabs: {
    display: "flex",
    flexWrap: "wrap",
    gap: space.s1,
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: "rgb(255 255 255 / 0.07)",
    backgroundColor: "rgb(255 255 255 / 0.025)",
    padding: space.s1,
  },
  tab: {
    display: "flex",
    minHeight: "2rem",
    alignItems: "center",
    gap: space.s1_5,
    paddingInline: space.s2_5,
    fontSize: "10px",
    fontWeight: text.weightMedium,
    whiteSpace: "nowrap",
    transitionProperty: { default: COLOR_TRANSITION, [layout.reducedMotion]: "none" },
    transitionDuration: motion.durStandard,
    transitionTimingFunction: motion.easeStandard,
    outlineWidth: { default: null, ":focus-visible": stroke.thick },
    outlineStyle: { default: null, ":focus-visible": "solid" },
    outlineColor: { default: null, ":focus-visible": "transparent" },
    outlineOffset: { default: null, ":focus-visible": "2px" },
    boxShadow: { default: null, ":focus-visible": FOCUS_RING_INSET },
  },
  tabActive: {
    backgroundColor: colors.accentWash,
    color: colors.accent,
  },
  tabIdle: {
    backgroundColor: { default: null, ":hover": "rgb(255 255 255 / 0.05)" },
    color: { default: colors.inkMuted, ":hover": colors.ink },
  },
  tabIcon: { width: "0.875rem", height: "0.875rem", flexShrink: 0 },

  /** A pill stating a fact about the account, never a quota or a balance. */
  pill: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1,
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: "rgb(255 255 255 / 0.12)",
    paddingInline: space.s1_5,
    paddingBlock: space.s0_5,
    fontFamily: text.fontMeta,
    fontSize: "10px",
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaNarrow,
    color: "rgb(255 255 255 / 0.55)",
  },
  pillAccent: {
    borderColor: "rgb(232 224 68 / 0.35)",
    backgroundColor: colors.accentWash,
    color: colors.accent,
  },
  pillMuted: { color: colors.inkFaint },

  /** The switcher's own button treatment, for actions on a plate. */
  button: {
    height: "2rem",
    gap: space.s1_5,
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: {
      default: colors.hairlineStrong,
      ":hover": "rgb(255 255 255 / 0.28)",
    },
    backgroundColor: {
      default: "rgb(255 255 255 / 0.025)",
      ":hover": colors.fill,
    },
    paddingInline: space.s3,
    fontSize: text.sizeXs,
    color: colors.ink,
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
    animationDuration: motion.durSpin,
    animationTimingFunction: motion.easeLinear,
    animationIterationCount: "infinite",
  },

  /** A message about the last action; success and failure share the shape. */
  notice: {
    display: "flex",
    alignItems: "flex-start",
    gap: space.s2,
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: colors.accentLineSubtle,
    backgroundColor: "rgb(232 224 68 / 0.08)",
    paddingInline: space.s3,
    paddingBlock: space.s2,
    fontSize: text.sizeXs,
    lineHeight: "1.125rem",
    color: colors.accent,
  },
  noticeError: {
    borderColor: "rgb(248 113 113 / 0.35)",
    backgroundColor: "rgb(248 113 113 / 0.1)",
    color: colors.critical,
  },

  /** The `ul` reset used by every list on these plates. */
  list: { display: "grid", gap: space.s1, margin: 0, padding: 0, listStyle: "none" },
  item: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.s2,
    minWidth: 0,
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: "rgb(255 255 255 / 0.06)",
    paddingInline: space.s2_5,
    paddingBlock: space.s2,
  },
  empty: {
    fontSize: text.sizeXs,
    lineHeight: "1.125rem",
    color: colors.inkFaint,
  },
});
