import * as stylex from "@stylexjs/stylex";
import { colors, space, stroke } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

const COLOR_TRANSITION =
  "color, background-color, border-color, text-decoration-color, fill, stroke";
const FOCUS_RING = `0 0 0 2px ${colors.ring}`;

export const styles = stylex.create({
  button: {
    display: "inline-flex",
    flexShrink: 0,
    color: { default: colors.mutedForeground, ":hover": colors.text },
    pointerEvents: { default: null, ":disabled": "none" },
    opacity: { default: null, ":disabled": 0.5 },
  },
  compact: {
    alignItems: "center",
    gap: space.s1,
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: {
      default: colors.border,
      ":hover": "hsl(var(--foreground) / 0.4)",
    },
    paddingInline: space.s1_5,
    paddingBlock: space.s0_5,
    fontSize: "11px",
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
