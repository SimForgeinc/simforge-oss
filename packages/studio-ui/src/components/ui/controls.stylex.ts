/**
 * Button and Badge styles, on the shared recipes and the control scale.
 *
 * Variants are looks, sizes are geometry; a caller picks both through props
 * and never restyles a button through `xstyle` (see the style guide).
 * `default` is the solid accent: the shadcn "primary" was already the brand
 * yellow, so the two names give the same button.
 */
import * as stylex from "@stylexjs/stylex";
import { colors, space, stroke, text } from "../../stylex/tokens.stylex";

export const button = stylex.create({
  base: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: space.s2,
    whiteSpace: "nowrap",
    fontFamily: text.fontBody,
    fontWeight: text.weightMedium,
    lineHeight: text.lineXs,
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: "transparent",
    cursor: "pointer",
    pointerEvents: { default: null, ":disabled": "none" },
    opacity: { default: null, ":disabled": 0.5 },
  },
});

export const buttonVariants = stylex.create({
  default: {
    backgroundColor: { default: colors.accent, ":hover": colors.accentHover },
    color: colors.accentText,
  },
  accent: {
    backgroundColor: { default: colors.accent, ":hover": colors.accentHover },
    color: colors.accentText,
  },
  destructive: {
    backgroundColor: colors.criticalWash,
    borderColor: { default: "transparent", ":hover": colors.critical },
    color: colors.critical,
  },
  /** A standalone secondary control: a faint plate with a hairline edge. */
  outline: {
    backgroundColor: { default: colors.fillFaint, ":hover": colors.fill },
    borderColor: { default: colors.hairlineStrong, ":hover": colors.hairlineStrong },
    color: colors.ink,
  },
  plate: {
    backgroundColor: { default: colors.fillFaint, ":hover": colors.fill },
    borderColor: { default: colors.hairlineStrong, ":hover": colors.hairlineStrong },
    color: colors.ink,
  },
  secondary: {
    backgroundColor: { default: colors.fillStrong, ":hover": colors.fillStronger },
    color: colors.ink,
  },
  /** No plate until hovered; secondary ink that brightens. */
  ghost: {
    backgroundColor: { default: "transparent", ":hover": colors.fill },
    color: { default: colors.inkSecondary, ":hover": colors.ink },
  },
  quiet: {
    backgroundColor: { default: "transparent", ":hover": colors.fill },
    color: { default: colors.inkMuted, ":hover": colors.ink },
  },
  /** A secondary action that belongs to the current item: accent ink on a wash. */
  accentOutline: {
    backgroundColor: colors.accentWash,
    borderColor: colors.accentLineSubtle,
    color: colors.accent,
  },
  link: {
    color: colors.accent,
    textUnderlineOffset: "4px",
    textDecorationLine: { default: null, ":hover": "underline" },
  },
});

/** The control scale: one height per step, shared with Input, IconButton and Chip. */
export const buttonSizes = stylex.create({
  xs: { height: "1.5rem", paddingInline: space.s2, fontSize: text.sizeMicro, gap: space.s1 },
  sm: { height: "1.75rem", paddingInline: space.s2_5, fontSize: text.sizeXs, gap: space.s1_5 },
  md: { height: "2rem", paddingInline: space.s3, fontSize: text.sizeXs },
  default: { height: "2rem", paddingInline: space.s3, fontSize: text.sizeXs },
  lg: { height: "2.5rem", paddingInline: space.s4, fontSize: text.sizeSm },
  xl: { height: "3rem", paddingInline: space.s6, fontSize: text.sizeSm },
  iconXs: { height: "1.5rem", width: "1.5rem", paddingInline: 0 },
  iconSm: { height: "1.75rem", width: "1.75rem", paddingInline: 0 },
  iconMd: { height: "2rem", width: "2rem", paddingInline: 0 },
  icon: { height: "2.5rem", width: "2.5rem", paddingInline: 0 },
});

export const badge = stylex.create({
  base: {
    display: "inline-flex",
    alignItems: "center",
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    paddingInline: space.s2,
    paddingBlock: space.s0_5,
  },
});

export const badgeVariants = stylex.create({
  default: { borderColor: colors.accentLineSubtle, backgroundColor: colors.accentWash, color: colors.accent },
  secondary: { borderColor: colors.hairline, backgroundColor: colors.fillSubtle, color: colors.inkSecondary },
  destructive: { borderColor: "transparent", backgroundColor: colors.criticalWash, color: colors.critical },
  outline: { borderColor: colors.hairlineStrong, backgroundColor: "transparent", color: colors.inkSecondary },
});
