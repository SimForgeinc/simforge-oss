import * as stylex from "@stylexjs/stylex";
import { colors, layers, motion, space, stroke, text } from "../../stylex/tokens.stylex";

const ICON_SIZE = "2.5rem";
const TRANSITION_PROPERTY = "opacity, background-color, transform, height, color, box-shadow";

export const styles = stylex.create({
  strip: {
    pointerEvents: "auto",
    display: "flex",
    flexDirection: "column",
    height: "100%",
    width: space.datasetStripWidth,
    minWidth: space.datasetStripWidth,
    borderRightWidth: stroke.hairline,
    borderRightStyle: "solid",
    borderColor: colors.hairlineStrong,
    backgroundColor: colors.scrimLight,
    paddingBlock: space.s2,
  },
  /** The icon column. Scrolls when the workspace has more datasets than fit, without a visible bar. */
  list: {
    minHeight: 0,
    flex: "1 1 0%",
    overflowY: "auto",
    overflowX: "hidden",
    scrollbarWidth: "none",
    display: "flex",
    flexDirection: "column",
    alignItems: "stretch",
    listStyle: "none",
    margin: 0,
    padding: 0,
  },
  item: {
    position: "relative",
    display: "flex",
    justifyContent: "center",
    paddingBlock: space.s1,
  },
  /**
   * The left pill: Slack's selection indicator. Height carries the state — a dot on hover, a bar on
   * the active dataset — so the icon's own surface never has to change shape.
   */
  pill: {
    position: "absolute",
    left: 0,
    top: "50%",
    width: "4px",
    height: 0,
    transform: "translateY(-50%)",
    backgroundColor: colors.text,
    pointerEvents: "none",
    transitionProperty: TRANSITION_PROPERTY,
    transitionDuration: motion.durFast,
    transitionTimingFunction: motion.easeStandard,
  },
  pillHover: { height: "1rem" },
  pillActive: { height: "1.75rem" },
  icon: {
    position: "relative",
    display: "grid",
    placeItems: "center",
    width: ICON_SIZE,
    height: ICON_SIZE,
    padding: 0,
    borderWidth: 0,
    cursor: "pointer",
    fontFamily: text.fontMeta,
    fontSize: "0.8125rem",
    lineHeight: 1,
    fontWeight: text.weightBold,
    letterSpacing: text.trackingWider,
    textTransform: "uppercase",
    // Monochrome: brightness is the only per-state signal, so hover lifts the tile and the monogram.
    backgroundColor: { default: colors.fill, ":hover": colors.fillStrong, ":focus-visible": colors.fillStrong },
    color: { default: colors.mutedForeground, ":hover": colors.text, ":focus-visible": colors.text },
    transform: { default: "scale(1)", ":hover": "scale(1.06)", ":active": "scale(0.97)" },
    outline: { default: "none", ":focus-visible": `2px solid ${colors.ring}` },
    outlineOffset: { default: null, ":focus-visible": "2px" },
    transitionProperty: TRANSITION_PROPERTY,
    transitionDuration: motion.durFast,
    transitionTimingFunction: motion.easeStandard,
  },
  iconActive: {
    backgroundColor: colors.fillStronger,
    color: colors.text,
    boxShadow: "0 0 0 1px rgb(255 255 255 / 0.55)",
  },
  iconBusy: {
    cursor: "progress",
  },
  /** Dims the monogram under the spinner. */
  busyOverlay: {
    position: "absolute",
    inset: 0,
    display: "grid",
    placeItems: "center",
    backgroundColor: colors.scrim,
  },
  /**
   * The menu caret in the icon's corner. Opacity-revealed rather than mounted on hover so it stays in
   * the accessibility tree and reachable by keyboard; `:focus-visible` reveals it on its own.
   */
  caret: {
    position: "absolute",
    right: "0.125rem",
    bottom: "0.125rem",
    zIndex: layers.raised,
    display: "grid",
    placeItems: "center",
    width: "0.875rem",
    height: "0.875rem",
    padding: 0,
    borderWidth: 0,
    backgroundColor: { default: colors.scrimHeavy, ":hover": colors.scrimHeavy },
    color: { default: colors.inkSecondary, ":hover": colors.primary },
    opacity: { default: 0, ":focus-visible": 1 },
    cursor: "pointer",
    outline: { default: "none", ":focus-visible": `2px solid ${colors.ring}` },
    transitionProperty: TRANSITION_PROPERTY,
    transitionDuration: motion.durFast,
    transitionTimingFunction: motion.easeStandard,
  },
  caretRevealed: { opacity: 1 },
  caretIcon: { width: "0.625rem", height: "0.625rem" },
  divider: {
    height: "1px",
    width: "1.75rem",
    marginInline: "auto",
    marginBlock: space.s1_5,
    backgroundColor: colors.hairlineStrong,
  },
  /** The `+` and review-queue affordances under the list, kept off the scrolling column. */
  footer: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space.s1,
    paddingTop: space.s2,
    borderTopWidth: stroke.hairline,
    borderTopStyle: "solid",
    borderColor: colors.hairline,
    marginTop: space.s2,
  },
  footerButton: {
    backgroundColor: { default: colors.fill, ":hover": colors.accent },
    color: { default: colors.text, ":hover": colors.accentText },
    transitionProperty: TRANSITION_PROPERTY,
    transitionDuration: motion.durFast,
    transitionTimingFunction: motion.easeStandard,
  },
  footerIcon: { width: space.s4, height: space.s4 },
  skeleton: {
    width: ICON_SIZE,
    height: ICON_SIZE,
    marginInline: "auto",
    marginBlock: space.s1,
    backgroundColor: colors.fill,
  },
  /**
   * A home section's heading: "On this computer", then the organization's name.
   *
   * The rail is 3.5rem wide, which is the whole constraint here. The label is micro type that wraps
   * and clamps to two lines ("ON THIS / COMPUTER"), and the full string is always in the tooltip
   * beside it — so a long organization name degrades to a truncated heading with a readable
   * tooltip, never to a rail that has been widened to fit one tenant's name. Tracking is near zero
   * rather than the meta face's usual `trackingMeta`, which would push "COMPUTER" past the rail's
   * inner width on its own.
   */
  section: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space.s0_5,
    paddingInline: space.s0_5,
    paddingTop: { default: space.s3, ":first-child": 0 },
    paddingBottom: space.s0_5,
  },
  sectionLabel: {
    display: "-webkit-box",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: 2,
    overflow: "hidden",
    width: "100%",
    textAlign: "center",
    overflowWrap: "anywhere",
    // The strip is 3.5rem wide: the tag role's tracking would break a
    // two-word workspace name onto three lines, so this label stays tight.
    letterSpacing: text.trackingWide,
    color: colors.inkMuted,
    cursor: "default",
    outline: { default: "none", ":focus-visible": `2px solid ${colors.ring}` },
    outlineOffset: { default: null, ":focus-visible": "2px" },
  },
  /** The section's own state, when there is something to say instead of tiles: "Signed out". */
  sectionNote: {
    width: "100%",
    textAlign: "center",
    overflowWrap: "anywhere",
    letterSpacing: text.trackingWide,
    color: colors.inkFaint,
  },
  /**
   * A cloud dataset's tile. It states presence, so it drops the pointer affordances the local tile
   * has: opening a dataset happens at its home, and this strip has no transfer actions.
   */
  iconStatic: {
    cursor: "default",
    backgroundColor: { default: colors.fillSubtle, ":hover": colors.fill, ":focus-visible": colors.fill },
    color: { default: colors.inkMuted, ":hover": colors.mutedForeground, ":focus-visible": colors.mutedForeground },
    transform: { default: "none", ":hover": "none", ":active": "none" },
  },
  /** The remainder marker at the foot of a capped cloud section: a count, not a tile. */
  overflowButton: {
    backgroundColor: { default: colors.fillSubtle, ":hover": colors.fill },
    color: { default: colors.inkMuted, ":hover": colors.text },
    fontFamily: text.fontMeta,
    fontWeight: text.weightSemibold,
    letterSpacing: text.trackingWide,
  },
  tooltipTitle: {
    fontWeight: text.weightSemibold,
  },
  tooltipMeta: {
    color: colors.mutedForeground,
  },
});
