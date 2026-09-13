import * as stylex from "@stylexjs/stylex";
import { colors, text } from "../../stylex/tokens.stylex";

const RING_OFFSET = "var(--tw-ring-inset) 0 0 0 var(--tw-ring-offset-width) var(--tw-ring-offset-color)";
const RING = "var(--tw-ring-inset) 0 0 0 calc(2px + var(--tw-ring-offset-width)) var(--tw-ring-color)";
const SHADOW = "var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow, 0 0 #0000)";

const common = {
  display: "flex",
  width: "100%",
  borderRadius: "0.375rem",
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "hsl(var(--input))",
  backgroundColor: colors.bg,
  paddingInline: "0.75rem",
  paddingBlock: "0.5rem",
  fontSize: text.sizeSm,
  lineHeight: "1.25rem",
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
  "::placeholder": { color: colors.mutedForeground },
  ":disabled": { cursor: "not-allowed", opacity: 0.5 },
};

export const input = stylex.create({
  base: { ...common, height: "2.5rem" },
  file: { "::file-selector-button": { borderWidth: 0, backgroundColor: "transparent", fontSize: text.sizeSm, lineHeight: "1.25rem", fontWeight: 500, color: colors.text } },
});

export const textarea = stylex.create({ base: { ...common, minHeight: "5rem" } });
