/**
 * StyleX styles for the in-app SimCloud account flows: the sign-in / sign-up /
 * reset forms, the verification banner and the account page sections. Theme-
 * following tokens throughout so the same form reads on the Settings plate
 * and inside the account sheet.
 */
import * as stylex from "@stylexjs/stylex";
import { colors, radii, space, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

const SM = "@media (min-width: 640px)";
const AMBER_400_30 = "rgba(251, 191, 36, 0.3)";
const AMBER_400_10 = "rgba(251, 191, 36, 0.1)";
const AMBER_300_90 = "rgba(252, 211, 77, 0.9)";
/** `animate-spin`: one revolution per second on the pending-request loader. */
const spin = stylex.keyframes({ from: { transform: "rotate(0deg)" }, to: { transform: "rotate(360deg)" } });

export const form = stylex.create({
  root: {
    display: "flex",
    flexDirection: "column",
    gap: space.lg,
    width: "100%",
    maxWidth: "26rem",
  },
  heading: {
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    fontWeight: 600,
    color: colors.text,
  },
  intro: {
    fontSize: text.sizeSm,
    lineHeight: "1.5rem",
    color: colors.mutedForeground,
  },
  field: {
    display: "flex",
    flexDirection: "column",
    gap: space.xs,
  },
  label: {
    fontFamily: text.fontMeta,
    fontSize: "9px",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: colors.mutedForeground,
  },
  input: {
    backgroundColor: "rgba(255, 255, 255, 0.04)",
    borderColor: colors.lineStrong,
    color: colors.text,
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
    gap: space.md,
  },
  between: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.md,
  },
  submit: {
    height: "2.5rem",
    gap: space.md,
    borderRadius: radii.full,
    backgroundColor: { default: colors.accent, ":hover": colors.accentHover },
    color: colors.accentText,
    opacity: { default: null, ":disabled": 0.6 },
  },
  secondary: {
    height: "2.5rem",
    gap: space.md,
    borderRadius: radii.full,
    borderColor: colors.lineStrong,
    backgroundColor: { default: "transparent", ":hover": "rgba(255, 255, 255, 0.05)" },
    color: colors.text,
  },
  // An inline text action ("Create account", "Forgot password?").
  link: {
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    color: { default: colors.mutedForeground, ":hover": colors.text },
    textDecorationLine: { default: "none", ":hover": "underline" },
    cursor: { default: "pointer", ":disabled": "not-allowed" },
    opacity: { default: null, ":disabled": 0.5 },
  },
  divider: {
    display: "flex",
    alignItems: "center",
    gap: space.md,
    fontFamily: text.fontMeta,
    fontSize: "9px",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: colors.mutedForeground,
  },
  dividerLine: {
    flex: 1,
    height: "1px",
    backgroundColor: colors.line,
  },
  providers: {
    display: "flex",
    flexDirection: "column",
    gap: space.md,
  },
  error: {
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    color: colors.danger,
  },
  success: {
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    color: AMBER_300_90,
  },
  note: {
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.mutedForeground,
  },
  icon: {
    width: "1rem",
    height: "1rem",
  },
  spin: {
    animationName: { default: spin, "@media (prefers-reduced-motion: reduce)": "none" },
    animationDuration: "1s",
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
  },
});

/** The "verify your email" banner shown while the account is unverified. */
export const banner = stylex.create({
  root: {
    display: "flex",
    flexDirection: "column",
    gap: space.md,
    marginTop: "0.75rem",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: AMBER_400_30,
    borderRadius: radii.xl,
    backgroundColor: AMBER_400_10,
    padding: space.xl,
  },
  title: {
    display: "flex",
    alignItems: "center",
    gap: space.md,
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    fontWeight: 600,
    color: colors.text,
  },
  detail: {
    fontSize: text.sizeXs,
    lineHeight: "1.25rem",
    color: colors.mutedForeground,
  },
});

/** The account page: stacked sections with lists of devices, workspaces and invitations. */
export const account = stylex.create({
  shell: {
    position: "relative",
    height: "100%",
    minHeight: 0,
    overflow: "hidden",
    color: colors.text,
  },
  scroll: {
    position: "relative",
    zIndex: 10,
    height: "100%",
    minHeight: 0,
    overflowY: "auto",
  },
  inner: {
    display: "flex",
    width: "100%",
    maxWidth: "48rem",
    marginInline: "auto",
    flexDirection: "column",
    gap: "2.5rem",
    paddingInline: { default: "1.25rem", [SM]: "2rem" },
    paddingBlock: { default: "2.5rem", [SM]: "3.5rem" },
  },
  section: {
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: colors.line,
    paddingTop: "2rem",
  },
  first: {
    borderTopWidth: 0,
    paddingTop: 0,
  },
  eyebrow: {
    fontFamily: text.fontMeta,
    fontSize: "9px",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaWide,
    color: colors.mutedForeground,
  },
  heading: {
    marginTop: "0.25rem",
    fontSize: text.sizeLg,
    lineHeight: "1.75rem",
    fontWeight: 600,
  },
  subheading: {
    marginTop: "2rem",
  },
  spaced: {
    marginTop: "1.5rem",
  },
  copy: {
    marginTop: "0.5rem",
    marginBottom: "1rem",
    fontSize: text.sizeSm,
    lineHeight: "1.5rem",
    color: colors.mutedForeground,
  },
  list: {
    display: "flex",
    flexDirection: "column",
    marginTop: "1rem",
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: colors.line,
  },
  item: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.lg,
    paddingBlock: "0.75rem",
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: colors.line,
  },
  itemBody: {
    minWidth: 0,
    flex: 1,
  },
  itemTitle: {
    display: "flex",
    alignItems: "center",
    gap: space.md,
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    fontWeight: 600,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  itemDetail: {
    marginTop: "0.125rem",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.mutedForeground,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  tag: {
    flexShrink: 0,
    borderRadius: radii.full,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.accent,
    paddingInline: "0.5rem",
    fontFamily: text.fontMeta,
    fontSize: "9px",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: colors.accent,
  },
  compact: {
    height: "2rem",
    gap: space.sm,
    borderRadius: radii.full,
    paddingInline: "0.75rem",
    fontSize: text.sizeXs,
  },
  empty: {
    marginTop: "1rem",
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    color: colors.mutedForeground,
  },
});
