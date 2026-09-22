import * as stylex from "@stylexjs/stylex";
import { colors, motion, space, stroke, text } from "../../stylex/tokens.stylex";

/**
 * Text fields. One look: a faint plate with a hairline edge that turns
 * accent on focus (the field's focus is its border, not a ring around it).
 */
const common = {
  display: "flex",
  width: "100%",
  borderWidth: stroke.hairline,
  borderStyle: "solid",
  borderColor: { default: colors.hairline, ":hover": colors.hairlineStrong, ":focus-visible": colors.accentLine },
  backgroundColor: colors.fillSubtle,
  color: colors.ink,
  paddingInline: space.s3,
  paddingBlock: space.s2,
  fontFamily: text.fontBody,
  fontSize: text.sizeSm,
  lineHeight: text.lineSm,
  // Focus is the accent border. The transparent outline is what forced-colours
  // mode repaints, so high-contrast users still see where focus is.
  outlineWidth: { default: null, ":focus-visible": stroke.thick },
  outlineStyle: { default: null, ":focus-visible": "solid" },
  outlineColor: { default: null, ":focus-visible": "transparent" },
  transitionProperty: "border-color",
  transitionDuration: motion.durStandard,
  "::placeholder": { color: colors.inkFaint },
  ":disabled": { cursor: "not-allowed", opacity: 0.5 },
} as const;

export const input = stylex.create({
  base: { ...common, height: "2rem", paddingBlock: 0, fontSize: text.sizeXs },
  file: { "::file-selector-button": { borderWidth: 0, backgroundColor: "transparent", fontSize: text.sizeXs, lineHeight: text.lineXs, fontWeight: text.weightMedium, color: colors.ink } },
});

export const textarea = stylex.create({ base: { ...common, minHeight: "5rem" } });

/** Heights on the shared control scale; `md` is the default `Input`. */
export const inputSizes = stylex.create({
  xs: { height: "1.5rem", paddingInline: space.s2, fontSize: text.sizeXs },
  sm: { height: "1.75rem", paddingInline: space.s2, fontSize: text.sizeXs },
  md: { height: "2rem" },
  lg: { height: "2.5rem", fontSize: text.sizeSm },
});

/** `plate` is the default look; the name stays so callers can be explicit. */
export const inputVariants = stylex.create({
  default: {},
  plate: {},
});
