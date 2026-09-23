/**
 * StyleX styles for the in-app SimCloud account flows: the sign-in / sign-up /
 * reset forms, the verification banner and the account page sections. Theme-
 * following tokens throughout so the same form reads on the Settings plate
 * and inside the account sheet.
 */
import * as stylex from "@stylexjs/stylex";
import { colors, layout, motion, space, stroke, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

const SM = "@media (min-width: 640px)";
/** `animate-spin`: one revolution per second on the pending-request loader. */
const spin = stylex.keyframes({ from: { transform: "rotate(0deg)" }, to: { transform: "rotate(360deg)" } });

export const form = stylex.create({
  root: {
    display: "flex",
    flexDirection: "column",
    gap: space.s3,
    width: "100%",
    maxWidth: "26rem",
  },
  heading: {
    fontSize: text.sizeSm,
    lineHeight: text.lineSm,
    fontWeight: text.weightSemibold,
    color: colors.text,
  },
  intro: {
    fontSize: text.sizeSm,
    lineHeight: text.lineBase,
    color: colors.mutedForeground,
  },
  field: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
  },
  label: {
    fontFamily: text.fontMeta,
    fontSize: text.sizeTag,
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: colors.mutedForeground,
  },
  input: {
  },
  // A six-digit code: monospaced, spaced, and only as wide as it needs to be.
  code: {
    fontFamily: text.fontMono,
    fontSize: text.sizeLg,
    letterSpacing: "0.3em",
    width: "11ch",
  },
  row: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space.s2,
  },
  between: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.s2,
  },
  submit: {
    gap: space.s2,
  },
  secondary: {
    gap: space.s2,
  },
  // An inline text action ("Create account", "Forgot password?").
  link: {
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    fontSize: text.sizeSm,
    lineHeight: text.lineSm,
    color: { default: colors.mutedForeground, ":hover": colors.text },
    textDecorationLine: { default: "none", ":hover": "underline" },
    cursor: { default: "pointer", ":disabled": "not-allowed" },
    opacity: { default: null, ":disabled": 0.5 },
  },
  divider: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    fontFamily: text.fontMeta,
    fontSize: text.sizeTag,
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: colors.mutedForeground,
  },
  dividerLine: {
    flex: 1,
    height: "1px",
    backgroundColor: colors.hairline,
  },
  providers: {
    display: "flex",
    flexDirection: "column",
    gap: space.s2,
  },
  error: {
    fontSize: text.sizeSm,
    lineHeight: text.lineSm,
    color: colors.danger,
  },
  success: {
    fontSize: text.sizeSm,
    lineHeight: text.lineSm,
    color: colors.warning,
  },
  note: {
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.mutedForeground,
  },
  icon: {
    width: "1rem",
    height: "1rem",
  },
  spin: {
    animationName: { default: spin, [layout.reducedMotion]: "none" },
    animationDuration: motion.durSpin,
    animationTimingFunction: motion.easeLinear,
    animationIterationCount: "infinite",
  },
});

/** The "verify your email" banner shown while the account is unverified. */
export const banner = stylex.create({
  root: {
    display: "flex",
    flexDirection: "column",
    gap: space.s2,
    marginTop: space.s3,
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: colors.warning,
    backgroundColor: colors.warningWash,
    padding: space.s4,
  },
  title: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    fontSize: text.sizeSm,
    lineHeight: text.lineSm,
    fontWeight: text.weightSemibold,
    color: colors.text,
  },
  detail: {
    fontSize: text.sizeXs,
    lineHeight: text.lineSm,
    color: colors.mutedForeground,
  },
});
