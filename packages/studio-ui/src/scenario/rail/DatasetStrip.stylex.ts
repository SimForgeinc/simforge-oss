import * as stylex from "@stylexjs/stylex";
import { colors, layers, motion, space, text } from "../../stylex/tokens.stylex";

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
    borderRightWidth: "1px",
    borderRightStyle: "solid",
    borderColor: colors.lineStrong,
    backgroundColor: "rgb(0 0 0 / 0.22)",
    paddingBlock: space.md,
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
    paddingBlock: space.xs,
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
    letterSpacing: "0.04em",
    textTransform: "uppercase",
    // Monochrome: brightness is the only per-state signal, so hover lifts the tile and the monogram.
    backgroundColor: { default: colors.glassRaised, ":hover": colors.chip, ":focus-visible": colors.chip },
    color: { default: colors.textMuted, ":hover": colors.text, ":focus-visible": colors.text },
    transform: { default: "scale(1)", ":hover": "scale(1.06)", ":active": "scale(0.97)" },
    outline: { default: "none", ":focus-visible": `2px solid ${colors.ring}` },
    outlineOffset: { default: null, ":focus-visible": "2px" },
    transitionProperty: TRANSITION_PROPERTY,
    transitionDuration: motion.durFast,
    transitionTimingFunction: motion.easeStandard,
  },
  iconActive: {
    backgroundColor: colors.glassHover,
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
    backgroundColor: colors.overlayScrim,
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
    backgroundColor: { default: "rgb(0 0 0 / 0.72)", ":hover": "rgb(0 0 0 / 0.9)" },
    color: { default: "rgb(255 255 255 / 0.8)", ":hover": colors.primary },
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
    marginBlock: space.sm,
    backgroundColor: colors.lineStrong,
  },
  /** The `+` and review-queue affordances under the list, kept off the scrolling column. */
  footer: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space.xs,
    paddingTop: space.md,
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderColor: colors.line,
    marginTop: space.md,
  },
  footerButton: {
    width: ICON_SIZE,
    height: ICON_SIZE,
    backgroundColor: { default: colors.glassRaised, ":hover": colors.accent },
    color: { default: colors.text, ":hover": colors.accentText },
    transitionProperty: TRANSITION_PROPERTY,
    transitionDuration: motion.durFast,
    transitionTimingFunction: motion.easeStandard,
  },
  footerLink: {
    width: ICON_SIZE,
    height: ICON_SIZE,
    backgroundColor: { default: "transparent", ":hover": colors.glassRaised },
    color: { default: colors.textSubtle, ":hover": colors.text },
  },
  footerIcon: { width: space.xl, height: space.xl },
  skeleton: {
    width: ICON_SIZE,
    height: ICON_SIZE,
    marginInline: "auto",
    marginBlock: space.xs,
    backgroundColor: colors.glassRaised,
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
    gap: space.xxs,
    paddingInline: space.xxs,
    paddingTop: { default: space.lg, ":first-child": space.none },
    paddingBottom: space.xxs,
  },
  sectionLabel: {
    display: "-webkit-box",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: 2,
    overflow: "hidden",
    width: "100%",
    textAlign: "center",
    fontFamily: text.fontMeta,
    fontSize: "0.5625rem",
    lineHeight: 1.2,
    fontWeight: text.weightSemibold,
    textTransform: "uppercase",
    letterSpacing: "0.02em",
    overflowWrap: "anywhere",
    color: colors.textSubtle,
    cursor: "default",
    outline: { default: "none", ":focus-visible": `2px solid ${colors.ring}` },
    outlineOffset: { default: null, ":focus-visible": "2px" },
  },
  /** The section's own state, when there is something to say instead of tiles: "Signed out". */
  sectionNote: {
    width: "100%",
    textAlign: "center",
    fontFamily: text.fontMeta,
    fontSize: "0.5rem",
    lineHeight: 1.2,
    textTransform: "uppercase",
    letterSpacing: "0.02em",
    overflowWrap: "anywhere",
    color: colors.textFaint,
  },
  /**
   * A cloud dataset's tile. It states presence, so it drops the pointer affordances the local tile
   * has: opening a dataset happens at its home, and this strip has no transfer actions.
   */
  iconStatic: {
    cursor: "default",
    backgroundColor: { default: colors.glass, ":hover": colors.glassRaised, ":focus-visible": colors.glassRaised },
    color: { default: colors.textSubtle, ":hover": colors.textMuted, ":focus-visible": colors.textMuted },
    transform: { default: "none", ":hover": "none", ":active": "none" },
  },
  /** The signed-out cloud section's way in. Dashed, so it reads as an opening rather than a tile. */
  connectButton: {
    width: ICON_SIZE,
    height: ICON_SIZE,
    backgroundColor: { default: colors.glass, ":hover": colors.glassRaised },
    color: { default: colors.textSubtle, ":hover": colors.text },
    borderWidth: "1px",
    borderStyle: "dashed",
    borderColor: { default: colors.lineStrong, ":hover": colors.accent },
    transitionProperty: TRANSITION_PROPERTY,
    transitionDuration: motion.durFast,
    transitionTimingFunction: motion.easeStandard,
  },
  /** The remainder marker at the foot of a capped cloud section: a count, not a tile. */
  overflowButton: {
    width: ICON_SIZE,
    height: ICON_SIZE,
    backgroundColor: { default: colors.glass, ":hover": colors.glassRaised },
    color: { default: colors.textSubtle, ":hover": colors.text },
    fontFamily: text.fontMeta,
    fontSize: text.sizeMicro,
    fontWeight: text.weightSemibold,
    letterSpacing: "0.02em",
  },
  // sr-only
  srOnly: {
    position: "absolute",
    width: "1px",
    height: "1px",
    padding: space.none,
    margin: "-1px",
    overflow: "hidden",
    clip: "rect(0, 0, 0, 0)",
    whiteSpace: "nowrap",
    borderWidth: 0,
  },
  tooltipTitle: {
    fontWeight: text.weightSemibold,
  },
  tooltipMeta: {
    fontFamily: text.fontMeta,
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: colors.mutedForeground,
  },
});
