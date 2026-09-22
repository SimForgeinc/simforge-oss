/**
 * StyleX styles for `ScenarioTransferOverlay`: the full-screen surface a
 * scenario is transferred to other maps from.
 *
 * It is the app switcher's language on purpose — the smoke backdrop, a
 * centred column, equal cards in hairline frames, the accent drawn as a rule
 * across the top of whatever is chosen, and one hairline bar beneath — so the
 * two full-screen surfaces read as one family. Cards and the bar sit on the
 * fixed plate rather than on glass: the smoke behind them is bright in places
 * and would wash the plans out.
 */

import * as stylex from "@stylexjs/stylex";
import { colors, layers, layout, motion, shadows, space, stroke, text } from "../../../stylex/tokens.stylex";

/** The accent rule across the top of a chosen card. */
const ACCENT_RULE = `inset 0 ${stroke.thick} 0 ${colors.accent}`;
/** The bar's one height, the app switcher's. */
const BAR_HEIGHT = "3.25rem";

const focusVisible = {
  outlineWidth: { default: null, ":focus-visible": stroke.thick },
  outlineStyle: { default: null, ":focus-visible": "solid" },
  outlineColor: { default: null, ":focus-visible": "transparent" },
  outlineOffset: { default: null, ":focus-visible": stroke.thick },
  boxShadow: { default: null, ":focus-visible": shadows.ringAccent },
} as const;

const colorTransition = {
  transitionProperty: { default: "color, background-color, border-color, box-shadow, opacity", [layout.reducedMotion]: "none" },
  transitionDuration: motion.durFast,
  transitionTimingFunction: motion.easeStandard,
} as const;

/** The meta face: uppercase, tracked out, for labels, counters and status. */
const metaType = {
  fontFamily: text.fontMeta,
  fontSize: text.sizeMicro,
  lineHeight: text.lineMicro,
  letterSpacing: text.trackingMeta,
  textTransform: "uppercase",
} as const;

export const styles = stylex.create({
  backdrop: {
    position: "fixed",
    inset: 0,
    zIndex: layers.appSwitcher,
    overflow: "hidden",
    backgroundColor: colors.panelSolid,
  },
  dialog: {
    position: "fixed",
    inset: 0,
    zIndex: layers.appSwitcherTop,
    display: "flex",
    justifyContent: "center",
    color: colors.ink,
    outlineStyle: "none",
  },

  /** Header, scrolling body and bar, in one centred column. */
  column: {
    display: "grid",
    gridTemplateRows: "auto minmax(0, 1fr) auto",
    gap: space.s4,
    width: "100%",
    maxWidth: "1180px",
    height: "100%",
    minHeight: 0,
    paddingInline: { default: layout.gutterNarrow, [layout.bpSm]: layout.gutter },
    paddingTop: { default: space.s4, [layout.bpSm]: space.s8 },
    paddingBottom: { default: space.s4, [layout.bpSm]: space.s6 },
  },

  header: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: space.s4,
    minWidth: 0,
  },
  heading: { display: "grid", gap: space.s1, minWidth: 0 },
  eyebrow: { ...metaType, letterSpacing: text.trackingMetaWide, color: colors.inkMuted },
  title: {
    margin: 0,
    fontFamily: text.fontDisplay,
    fontSize: { default: text.sizeXl, [layout.bpSm]: text.size2xl },
    lineHeight: text.lineTight,
    fontWeight: text.weightSemibold,
    letterSpacing: text.trackingTight,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  lede: { margin: 0, fontSize: text.sizeSm, lineHeight: text.lineNormal, color: colors.inkSecondary },
  close: {
    display: "grid",
    flexShrink: 0,
    width: space.s10,
    height: space.s10,
    placeItems: "center",
    color: { default: colors.inkFaint, ":hover": colors.ink },
    backgroundColor: { default: "transparent", ":hover": colors.fillSubtle },
    borderWidth: 0,
    cursor: "pointer",
    ...colorTransition,
    ...focusVisible,
  },
  closeIcon: { width: space.s5, height: space.s5 },

  /** The scrolling list of maps; the column keeps the header and the bar still. */
  body: {
    minHeight: 0,
    // Focused on open so Tab starts at the cards; the cards carry the visible focus.
    outlineStyle: "none",
    overflowY: "auto",
    overscrollBehavior: "contain",
    display: "grid",
    alignContent: "start",
    gap: space.s6,
    // Room for the focus ring of the outermost cards.
    padding: space.s1,
    marginInline: `calc(-1 * ${space.s1})`,
  },

  section: { display: "grid", gap: space.s3, minWidth: 0 },
  sectionHead: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: space.s3,
    minWidth: 0,
    paddingBottom: space.s1_5,
    borderBottomWidth: stroke.hairline,
    borderBottomStyle: "solid",
    borderBottomColor: colors.hairline,
  },
  sectionTitle: {
    margin: 0,
    minWidth: 0,
    fontFamily: text.fontDisplay,
    fontSize: text.sizeBase,
    fontWeight: text.weightSemibold,
    letterSpacing: text.trackingTight,
  },
  sectionStatus: {
    ...metaType,
    display: "inline-flex",
    alignItems: "center",
    gap: space.s2,
    flexShrink: 0,
    color: colors.inkMuted,
  },
  sectionError: {
    fontFamily: text.fontBody,
    fontSize: text.sizeXs,
    letterSpacing: "normal",
    textTransform: "none",
    color: colors.critical,
  },
  inlineAction: {
    ...metaType,
    paddingInline: space.s1_5,
    paddingBlock: space.s0_5,
    color: { default: colors.inkMuted, ":hover": colors.ink },
    backgroundColor: { default: "transparent", ":hover": colors.fillSubtle },
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: colors.hairline,
    cursor: "pointer",
    ...colorTransition,
    ...focusVisible,
  },

  grid: {
    display: "grid",
    gap: space.s3,
    gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 15rem), 1fr))",
  },

  /** One placement: the plan over a line of text, in the switcher's card frame. */
  card: {
    position: "relative",
    display: "grid",
    minWidth: 0,
    overflow: "hidden",
    textAlign: "left",
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    cursor: "pointer",
    ...colorTransition,
    outlineWidth: { default: null, ":focus-visible": stroke.thick },
    outlineStyle: { default: null, ":focus-visible": "solid" },
    outlineColor: { default: null, ":focus-visible": "transparent" },
    outlineOffset: { default: null, ":focus-visible": stroke.thick },
  },
  cardIdle: {
    borderColor: { default: colors.hairline, ":hover": colors.hairlineStrong },
    backgroundColor: { default: colors.panel, ":hover": colors.panel2 },
    boxShadow: { default: null, ":focus-visible": shadows.ringAccent },
  },
  /** Chosen: the accent rule across the top and a warmer plate, as the switcher marks the app you are in. */
  cardSelected: {
    borderColor: colors.accentLineSubtle,
    backgroundColor: colors.panel,
    backgroundImage: `linear-gradient(${colors.accentWash}, ${colors.accentWash})`,
    boxShadow: { default: ACCENT_RULE, ":focus-visible": `${ACCENT_RULE}, ${shadows.ringAccent}` },
  },
  /** Not part of the batch being created: still visible, plainly out of play. */
  cardInert: { cursor: "default", opacity: 0.35 },
  cardLocked: { cursor: "default" },

  stage: {
    position: "relative",
    aspectRatio: "4 / 3",
    backgroundColor: colors.panelSolid,
    borderBottomWidth: stroke.hairline,
    borderBottomStyle: "solid",
    borderBottomColor: colors.hairline,
  },
  stageEmpty: { ...metaType, display: "grid", placeItems: "center", color: colors.inkFaint },
  /** The selection mark in the stage's corner: a hairline square, filled when chosen. */
  check: {
    position: "absolute",
    top: space.s2,
    right: space.s2,
    display: "grid",
    placeItems: "center",
    width: space.s5,
    height: space.s5,
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: colors.hairlineStrong,
    backgroundColor: colors.scrim,
    color: colors.accentText,
  },
  checkOn: { borderColor: colors.accent, backgroundColor: colors.accent },
  checkIcon: { width: space.s3_5, height: space.s3_5 },

  cardBody: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.s2,
    minWidth: 0,
    paddingInline: space.s3,
    paddingBlock: space.s2_5,
  },
  cardName: { fontSize: text.sizeSm, lineHeight: text.lineSm, fontWeight: text.weightMedium, whiteSpace: "nowrap" },
  cardMeta: {
    ...metaType,
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1,
    minWidth: 0,
    color: colors.inkMuted,
  },
  cardWarn: { color: colors.warning },

  /** The create outcome laid over the plan's lower edge. */
  job: {
    position: "absolute",
    insetInline: 0,
    bottom: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.s2,
    paddingInline: space.s3,
    paddingBlock: space.s2,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    backgroundColor: colors.scrim,
    backdropFilter: motion.blurMd,
    borderTopWidth: stroke.hairline,
    borderTopStyle: "solid",
    borderTopColor: colors.hairline,
  },
  jobState: { display: "inline-flex", alignItems: "center", gap: space.s1_5, minWidth: 0 },
  jobIcon: { width: space.s3_5, height: space.s3_5, flexShrink: 0 },
  jobDone: { color: colors.accent },
  jobFailed: { color: colors.critical },
  jobMessage: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  openLink: {
    ...metaType,
    flexShrink: 0,
    color: { default: colors.accent, ":hover": colors.accentHover },
    textDecorationLine: { default: "none", ":hover": "underline" },
    textUnderlineOffset: space.s1,
    ...focusVisible,
  },

  skeletonCard: {
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: colors.hairline,
    backgroundColor: colors.panel,
  },
  skeletonStage: { aspectRatio: "4 / 3" },
  skeletonLine: { height: space.s2_5, width: "45%", margin: space.s3 },

  /** One message where the grid would be: reading the scenario, a refusal, or nothing found. */
  notice: {
    display: "grid",
    alignContent: "center",
    justifyItems: "start",
    gap: space.s2,
    maxWidth: layout.formMeasure,
    paddingBlock: space.s8,
  },
  noticeTitle: { margin: 0, fontFamily: text.fontDisplay, fontSize: text.sizeLg, fontWeight: text.weightSemibold },
  noticeText: { margin: 0, fontSize: text.sizeSm, lineHeight: text.lineNormal, color: colors.inkSecondary },
  noticeList: {
    margin: 0,
    paddingInlineStart: space.s4,
    display: "grid",
    gap: space.s1,
    fontSize: text.sizeXs,
    lineHeight: text.lineNormal,
    color: colors.inkMuted,
  },

  /** The one bar: status on the left, the actions on the right, a hairline frame round both. */
  bar: {
    display: "flex",
    alignItems: "stretch",
    minHeight: BAR_HEIGHT,
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: colors.hairline,
    backgroundColor: colors.panel,
  },
  barStatus: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    flexGrow: 1,
    minWidth: 0,
    paddingInline: space.s4,
    fontSize: text.sizeSm,
    color: colors.inkMuted,
  },
  barStatusText: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  barProgress: { position: "absolute", insetInline: 0, bottom: 0 },
  barActions: { display: "flex", alignItems: "stretch", flexShrink: 0 },
  barButton: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1_5,
    paddingInline: { default: space.s3, [layout.bpSm]: space.s4 },
    fontFamily: "inherit",
    fontSize: text.sizeSm,
    fontWeight: text.weightMedium,
    whiteSpace: "nowrap",
    borderWidth: 0,
    borderInlineStartWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: colors.hairline,
    cursor: { default: "pointer", ":disabled": "default" },
    ...colorTransition,
    ...focusVisible,
  },
  barButtonQuiet: {
    color: { default: colors.inkMuted, ":hover": colors.ink, ":disabled": colors.inkFaint },
    backgroundColor: { default: "transparent", ":hover": colors.fillSubtle, ":disabled": "transparent" },
  },
  barButtonPrimary: {
    color: colors.accentText,
    backgroundColor: { default: colors.accent, ":hover": colors.accentHover },
    opacity: { default: 1, ":disabled": 0.35 },
  },
  barIcon: { width: space.s4, height: space.s4 },
  keyHint: {
    display: { default: "none", [layout.bpSm]: "inline" },
    fontFamily: text.fontMeta,
    fontSize: text.sizeMicro,
    opacity: 0.6,
  },
});
