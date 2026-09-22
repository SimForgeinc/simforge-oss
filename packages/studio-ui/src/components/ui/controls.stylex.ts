import * as stylex from "@stylexjs/stylex";
import { colors, space, stroke, text } from "../../stylex/tokens.stylex";

const TRANSITION = "color, background-color, border-color, text-decoration-color, fill, stroke";
const RING_OFFSET = "var(--tw-ring-inset) 0 0 0 var(--tw-ring-offset-width) var(--tw-ring-offset-color)";
const RING = "var(--tw-ring-inset) 0 0 0 calc(2px + var(--tw-ring-offset-width)) var(--tw-ring-color)";
const SHADOW = "var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow, 0 0 #0000)";

// Preserve the ring/shadow variables consumed by appearance-frozen Tailwind callers.
export const button = stylex.create({
  base: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: space.s2,
    whiteSpace: "nowrap",
    fontSize: text.sizeSm,
    lineHeight: text.lineSm,
    fontWeight: text.weightMedium,
    "--tw-ring-offset-color": colors.bg,
    "--tw-ring-offset-width": { default: null, ":focus-visible": "2px" },
    "--tw-ring-color": { default: null, ":focus-visible": colors.ring },
    "--tw-ring-offset-shadow": { default: null, ":focus-visible": RING_OFFSET },
    "--tw-ring-shadow": { default: null, ":focus-visible": RING },
    boxShadow: { default: null, ":focus-visible": SHADOW },
    outlineStyle: { default: null, ":focus-visible": "solid" },
    outlineWidth: { default: null, ":focus-visible": stroke.thick },
    outlineColor: { default: null, ":focus-visible": "transparent" },
    outlineOffset: { default: null, ":focus-visible": "2px" },
    pointerEvents: { default: null, ":disabled": "none" },
    opacity: { default: null, ":disabled": 0.5 },
  },
});

export const buttonVariants = stylex.create({
  default: {
    backgroundColor: { default: colors.primary, ":hover": "hsl(var(--primary) / 0.85)" },
    color: colors.primaryForeground,
  },
  destructive: {
    backgroundColor: { default: colors.danger, ":hover": "hsl(var(--destructive) / 0.9)" },
    color: colors.dangerText,
  },
  outline: {
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: colors.input,
    backgroundColor: { default: colors.bg, ":hover": colors.hoverWash },
    color: { default: null, ":hover": colors.hoverWashText },
  },
  secondary: {
    backgroundColor: { default: colors.secondary, ":hover": "hsl(var(--secondary) / 0.7)" },
    color: colors.secondaryForeground,
  },
  ghost: {
    backgroundColor: { default: null, ":hover": colors.hoverWash },
    color: { default: null, ":hover": colors.hoverWashText },
  },
  link: {
    color: colors.primary,
    textUnderlineOffset: "4px",
    textDecorationLine: { default: null, ":hover": "underline" },
  },
  /** The one primary action on a surface: solid accent. */
  accent: {
    backgroundColor: { default: colors.accent, ":hover": colors.accentHover },
    color: colors.accentText,
  },
  /** A standalone secondary control: a faint plate with a hairline edge. */
  plate: {
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: { default: colors.hairlineStrong, ":hover": colors.hairlineStrong },
    backgroundColor: { default: colors.fillFaint, ":hover": colors.fill },
    color: colors.ink,
  },
  /** A secondary action that belongs to the current item: accent ink on a wash. */
  accentOutline: {
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: colors.accentLineSubtle,
    backgroundColor: { default: colors.accentWash, ":hover": colors.accentWash },
    color: colors.accent,
  },
  /** Quiet: no plate until hovered, muted ink that brightens. */
  quiet: {
    backgroundColor: { default: "transparent", ":hover": colors.fill },
    color: { default: colors.inkMuted, ":hover": colors.ink },
  },
});

export const buttonSizes = stylex.create({
  default: { height: "2.5rem", paddingInline: space.s4, paddingBlock: space.s2 },
  sm: { height: "2.25rem", paddingInline: space.s3, },
  lg: { height: "2.75rem", paddingInline: space.s6, },
  icon: { height: "2.5rem", width: "2.5rem" },
  // The control scale (recipes `control`): one height per step, shared with
  // Input, IconButton and Chip so a row of mixed controls lines up.
  xs: { height: "1.5rem", paddingInline: space.s2, fontSize: text.sizeMicro, gap: space.s1 },
  md: { height: "2rem", paddingInline: space.s3, fontSize: text.sizeXs, gap: space.s1_5 },
  xl: { height: "3rem", paddingInline: space.s6, fontSize: text.sizeSm },
  iconXs: { height: "1.5rem", width: "1.5rem" },
  iconSm: { height: "1.75rem", width: "1.75rem" },
  iconMd: { height: "2rem", width: "2rem" },
});

export const badge = stylex.create({
  base: {
    display: "inline-flex",
    alignItems: "center",
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    paddingInline: space.s2_5,
    paddingBlock: space.s0_5,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    fontWeight: text.weightMedium,
    "--tw-ring-offset-width": { default: null, ":focus": "2px" },
    "--tw-ring-color": { default: null, ":focus": colors.ring },
    "--tw-ring-offset-shadow": { default: null, ":focus": RING_OFFSET },
    "--tw-ring-shadow": { default: null, ":focus": RING },
    boxShadow: { default: null, ":focus": SHADOW },
    outlineStyle: { default: null, ":focus": "solid" },
    outlineWidth: { default: null, ":focus": stroke.thick },
    outlineColor: { default: null, ":focus": "transparent" },
    outlineOffset: { default: null, ":focus": "2px" },
  },
});

export const badgeVariants = stylex.create({
  default: {
    borderColor: "transparent",
    backgroundColor: { default: colors.primary, ":hover": "hsl(var(--primary) / 0.8)" },
    color: colors.primaryForeground,
  },
  secondary: {
    borderColor: "transparent",
    backgroundColor: { default: colors.secondary, ":hover": "hsl(var(--secondary) / 0.8)" },
    color: colors.secondaryForeground,
  },
  destructive: {
    borderColor: "transparent",
    backgroundColor: { default: colors.danger, ":hover": "hsl(var(--destructive) / 0.8)" },
    color: colors.dangerText,
  },
  outline: { color: colors.text },
});
