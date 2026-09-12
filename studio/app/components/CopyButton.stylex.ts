import * as stylex from "@stylexjs/stylex";
import { colors, radii } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

const COLOR_TRANSITION =
  "color, background-color, border-color, text-decoration-color, fill, stroke";
const FOCUS_RING = `0 0 0 2px ${colors.ring}`;

export const styles = stylex.create({
  button: {
    display: "inline-flex",
    flexShrink: 0,
    color: { default: colors.mutedForeground, ":hover": colors.text },
    transitionProperty: COLOR_TRANSITION,
    transitionDuration: "150ms",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    outlineStyle: { default: null, ":focus-visible": "solid" },
    outlineWidth: { default: null, ":focus-visible": "2px" },
    outlineColor: { default: null, ":focus-visible": "transparent" },
    outlineOffset: { default: null, ":focus-visible": "2px" },
    boxShadow: { default: null, ":focus-visible": FOCUS_RING },
    pointerEvents: { default: null, ":disabled": "none" },
    opacity: { default: null, ":disabled": 0.5 },
  },
  compact: {
    alignItems: "center",
    gap: "0.25rem",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: {
      default: colors.border,
      ":hover": "hsl(var(--foreground) / 0.4)",
    },
    borderRadius: radii.sm,
    paddingInline: "0.375rem",
    paddingBlock: "0.125rem",
    fontSize: "0.6875rem",
  },
  compactIcon: {
    width: "0.75rem",
    height: "0.75rem",
  },
  iconOnlyIcon: {
    width: "0.875rem",
    height: "0.875rem",
  },
  copiedIcon: {
    color: "#4ade80",
  },
});
