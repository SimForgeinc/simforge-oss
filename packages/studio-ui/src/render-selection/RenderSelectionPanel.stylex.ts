import * as stylex from "@stylexjs/stylex";
import { colors, motion, space, text } from "../stylex/tokens.stylex";

/**
 * StyleX for the one-page render selection surface.
 *
 * The diagnostics card is the only thing on the page that moves: its body is
 * a `grid-template-rows: 0fr -> 1fr` track, which is the one way CSS animates
 * an auto-height reveal without measuring. Everything else is flat.
 */

const pulse = stylex.keyframes({
  "0%": { opacity: 0.35 },
  "50%": { opacity: 1 },
  "100%": { opacity: 0.35 },
});

const sweep = stylex.keyframes({
  from: { transform: "translateX(-100%)" },
  to: { transform: "translateX(100%)" },
});

export const styles = stylex.create({
  page: {
    display: "grid",
    minHeight: "100%",
    placeItems: "center",
    paddingInline: space.xxl,
    paddingBlock: space.xxxl,
  },
  content: {
    width: "100%",
    maxWidth: "56rem",
    color: "#fff",
    display: "grid",
    gap: space.xxl,
  },
  header: {
    textAlign: "center",
    display: "grid",
    gap: space.sm,
  },
  eyebrow: {
    fontFamily: text.fontMeta,
    fontSize: text.sizeMicro,
    fontWeight: text.weightBold,
    letterSpacing: text.trackingMetaWider,
    textTransform: "uppercase",
    color: colors.accent,
  },
  title: {
    fontSize: "1.75rem",
    lineHeight: 1.15,
    fontWeight: text.weightSemibold,
    color: "#fff",
  },
  lede: {
    fontSize: text.sizeSm,
    color: colors.textSubtle,
  },

  /* Diagnostics card */
  card: {
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.lineStrong,
    backgroundColor: colors.glass,
    backdropFilter: motion.blurGlass,
  },
  cardHead: {
    display: "flex",
    alignItems: "center",
    gap: space.lg,
    paddingInline: space.xl,
    paddingBlock: space.lg,
  },
  cardHeadText: {
    display: "grid",
    gap: space.xxs,
    minWidth: 0,
    flex: 1,
  },
  cardTitle: {
    fontSize: text.sizeSm,
    fontWeight: text.weightSemibold,
    color: "#fff",
  },
  cardMeta: {
    fontSize: text.sizeXs,
    color: colors.textSubtle,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  startButton: {
    flexShrink: 0,
    backgroundColor: colors.accent,
    color: colors.accentText,
    fontWeight: text.weightSemibold,
    ":hover": { backgroundColor: colors.accentHover },
  },
  cancelButton: {
    flexShrink: 0,
    color: "#fff",
    borderColor: colors.lineStrong,
    ":hover": { backgroundColor: colors.glassHover },
  },
  reveal: {
    display: "grid",
    gridTemplateRows: "0fr",
    transitionProperty: "grid-template-rows",
    transitionDuration: motion.durSlow,
    transitionTimingFunction: motion.easeExpressive,
    "@media (prefers-reduced-motion: reduce)": { transitionDuration: "0s" },
  },
  revealOpen: {
    gridTemplateRows: "1fr",
  },
  revealClip: {
    overflow: "hidden",
    minHeight: 0,
  },
  body: {
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: colors.hairline,
    paddingInline: space.xl,
    paddingBlock: space.lg,
    display: "grid",
    gap: space.lg,
  },
  progressTrack: {
    position: "relative",
    height: 2,
    overflow: "hidden",
    backgroundColor: colors.chip,
  },
  progressFill: {
    position: "absolute",
    inset: 0,
    transformOrigin: "left",
    backgroundColor: colors.accent,
    transitionProperty: "transform",
    transitionDuration: motion.durSlow,
    transitionTimingFunction: motion.easeStandard,
  },
  progressSweep: {
    position: "absolute",
    inset: 0,
    backgroundImage: `linear-gradient(90deg, transparent, ${colors.accent}, transparent)`,
    animationName: sweep,
    animationDuration: "1.4s",
    animationIterationCount: "infinite",
    animationTimingFunction: "linear",
    "@media (prefers-reduced-motion: reduce)": { animationName: "none" },
  },
  status: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: space.lg,
    fontSize: text.sizeXs,
    color: colors.textSubtle,
  },
  statusStrong: {
    color: "#fff",
    fontWeight: text.weightMedium,
  },

  /* Checks */
  checks: {
    display: "grid",
    gap: space.sm,
  },
  check: {
    display: "grid",
    gridTemplateColumns: "1rem 1fr",
    columnGap: space.md,
    alignItems: "start",
  },
  checkIcon: {
    width: "1rem",
    height: "1rem",
    marginTop: "0.125rem",
  },
  checkPass: { color: colors.signalGreen },
  checkWarn: { color: colors.signalYellow },
  checkFail: { color: colors.signalRed },
  checkPending: {
    color: colors.textFaint,
    animationName: pulse,
    animationDuration: "1.6s",
    animationIterationCount: "infinite",
    "@media (prefers-reduced-motion: reduce)": { animationName: "none" },
  },
  checkTitle: {
    fontSize: text.sizeSm,
    color: "#fff",
  },
  checkDetail: {
    fontSize: text.sizeXs,
    color: colors.textSubtle,
  },

  /* Per-profile lanes */
  lanes: {
    display: "grid",
    gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
    gap: space.sm,
    "@media (max-width: 640px)": { gridTemplateColumns: "repeat(2, minmax(0, 1fr))" },
  },
  lane: {
    display: "grid",
    gap: space.xs,
    paddingInline: space.md,
    paddingBlock: space.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.hairline,
    backgroundColor: colors.overlayMat,
    minWidth: 0,
  },
  laneActive: { borderColor: colors.accent },
  laneBest: { borderColor: colors.signalGreen },
  laneLabel: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: space.sm,
    fontFamily: text.fontMeta,
    fontSize: text.sizeMicro,
    letterSpacing: text.trackingMeta,
    textTransform: "uppercase",
    color: colors.textSubtle,
  },
  laneBadge: {
    color: colors.signalGreen,
  },
  laneValue: {
    fontSize: text.sizeXl,
    lineHeight: 1.1,
    fontWeight: text.weightSemibold,
    color: "#fff",
    fontVariantNumeric: "tabular-nums",
  },
  laneValueMuted: {
    color: colors.textFaint,
    fontWeight: text.weightNormal,
    fontSize: text.sizeSm,
  },
  laneUnit: {
    fontSize: text.sizeXs,
    fontWeight: text.weightNormal,
    color: colors.textSubtle,
    marginLeft: space.xxs,
  },
  laneRows: {
    display: "grid",
    gap: space.xxs,
    fontSize: text.sizeXs,
    color: colors.textSubtle,
    fontVariantNumeric: "tabular-nums",
  },
  laneRow: {
    display: "flex",
    justifyContent: "space-between",
    gap: space.sm,
  },
  laneRowBad: { color: colors.signalYellow },

  alert: {
    display: "grid",
    gap: space.xxs,
    paddingInline: space.md,
    paddingBlock: space.sm,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.signalRed,
    backgroundColor: "rgba(0, 0, 0, 0.3)",
    fontSize: text.sizeXs,
    color: "#fff",
  },

  verdict: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space.md,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: colors.hairline,
    paddingTop: space.lg,
  },
  verdictText: {
    flex: 1,
    minWidth: "12rem",
    display: "grid",
    gap: space.xxs,
  },
  verdictTitle: {
    fontSize: text.sizeSm,
    fontWeight: text.weightSemibold,
    color: "#fff",
  },
  verdictDetail: {
    fontSize: text.sizeXs,
    color: colors.textSubtle,
  },
  ghostButton: {
    color: "#fff",
    ":hover": { backgroundColor: colors.glassHover },
  },

  /* Manual selection */
  section: {
    display: "grid",
    gap: space.md,
  },
  sectionHead: {
    display: "flex",
    alignItems: "center",
    gap: space.lg,
  },
  rule: {
    flex: 1,
    height: 1,
    backgroundColor: colors.hairline,
  },
  sectionTitle: {
    fontFamily: text.fontMeta,
    fontSize: text.sizeMicro,
    fontWeight: text.weightBold,
    letterSpacing: text.trackingMetaWider,
    textTransform: "uppercase",
    color: colors.textSubtle,
  },
  choices: {
    display: "grid",
    gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
    gap: space.sm,
    "@media (max-width: 640px)": { gridTemplateColumns: "repeat(2, minmax(0, 1fr))" },
  },
  choice: {
    display: "grid",
    gap: space.xs,
    textAlign: "left",
    paddingInline: space.md,
    paddingBlock: space.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.lineStrong,
    backgroundColor: colors.glass,
    color: "#fff",
    cursor: "pointer",
    transitionProperty: "background-color, border-color",
    transitionDuration: motion.durFast,
    transitionTimingFunction: motion.easeStandard,
    ":hover": { backgroundColor: colors.glassHover },
    ":focus-visible": { outline: "none", boxShadow: `0 0 0 2px ${colors.accent}` },
  },
  choiceCurrent: {
    borderColor: colors.accent,
    backgroundColor: colors.accentSoft,
  },
  choiceLabel: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: space.sm,
    fontSize: text.sizeSm,
    fontWeight: text.weightSemibold,
  },
  choiceTag: {
    fontFamily: text.fontMeta,
    fontSize: text.sizeMicro,
    letterSpacing: text.trackingMetaNarrow,
    textTransform: "uppercase",
    color: colors.accent,
  },
  choiceCopy: {
    fontSize: text.sizeXs,
    color: colors.textSubtle,
  },
  choiceMeta: {
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    color: colors.textFaint,
  },
  footer: {
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: colors.hairline,
    paddingTop: space.xl,
  },
});
