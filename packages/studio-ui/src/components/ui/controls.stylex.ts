import * as stylex from "@stylexjs/stylex";
import { colors, radii, text } from "../../stylex/tokens.stylex";

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
    gap: "0.5rem",
    whiteSpace: "nowrap",
    borderRadius: radii.md,
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    fontWeight: 500,
    transitionProperty: TRANSITION,
    transitionDuration: "150ms",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    "--tw-ring-offset-color": colors.bg,
    "--tw-ring-offset-width": { default: null, ":focus-visible": "2px" },
    "--tw-ring-color": { default: null, ":focus-visible": colors.ring },
    "--tw-ring-offset-shadow": { default: null, ":focus-visible": RING_OFFSET },
    "--tw-ring-shadow": { default: null, ":focus-visible": RING },
    boxShadow: { default: null, ":focus-visible": SHADOW },
    outlineStyle: { default: null, ":focus-visible": "solid" },
    outlineWidth: { default: null, ":focus-visible": "2px" },
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
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "hsl(var(--input))",
    backgroundColor: { default: colors.bg, ":hover": "hsl(var(--accent))" },
    color: { default: null, ":hover": "hsl(var(--accent-foreground))" },
  },
  secondary: {
    backgroundColor: { default: colors.secondary, ":hover": "hsl(var(--secondary) / 0.7)" },
    color: colors.secondaryForeground,
  },
  ghost: {
    backgroundColor: { default: null, ":hover": "hsl(var(--accent))" },
    color: { default: null, ":hover": "hsl(var(--accent-foreground))" },
  },
  link: {
    color: colors.primary,
    textUnderlineOffset: "4px",
    textDecorationLine: { default: null, ":hover": "underline" },
  },
});

export const buttonSizes = stylex.create({
  default: { height: "2.5rem", paddingInline: "1rem", paddingBlock: "0.5rem" },
  sm: { height: "2.25rem", paddingInline: "0.75rem", borderRadius: radii.md },
  lg: { height: "2.75rem", paddingInline: "1.5rem", borderRadius: radii.md },
  icon: { height: "2.5rem", width: "2.5rem" },
});

export const badge = stylex.create({
  base: {
    display: "inline-flex",
    alignItems: "center",
    borderRadius: radii.md,
    borderWidth: 1,
    borderStyle: "solid",
    paddingInline: "0.625rem",
    paddingBlock: "0.125rem",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    fontWeight: 500,
    transitionProperty: TRANSITION,
    transitionDuration: "150ms",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    "--tw-ring-offset-width": { default: null, ":focus": "2px" },
    "--tw-ring-color": { default: null, ":focus": colors.ring },
    "--tw-ring-offset-shadow": { default: null, ":focus": RING_OFFSET },
    "--tw-ring-shadow": { default: null, ":focus": RING },
    boxShadow: { default: null, ":focus": SHADOW },
    outlineStyle: { default: null, ":focus": "solid" },
    outlineWidth: { default: null, ":focus": "2px" },
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
