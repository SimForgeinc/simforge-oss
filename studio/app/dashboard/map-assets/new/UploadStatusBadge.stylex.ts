import * as stylex from "@stylexjs/stylex";
import { colors, motion, space } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

const spin = stylex.keyframes({
  from: { transform: "rotate(0deg)" },
  to: { transform: "rotate(360deg)" },
});

export const styles = stylex.create({
  hashingStatus: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1,
    fontSize: "10px",
    color: colors.mutedForeground,
  },
  loadingIcon: {
    width: "0.75rem",
    height: "0.75rem",
    animationName: spin,
    animationDuration: motion.durSpin,
    animationTimingFunction: motion.easeLinear,
    animationIterationCount: "infinite",
  },
  uploadingStatus: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1,
    fontSize: "10px",
    color: "#60a5fa",
  },
  successStatus: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1,
    fontSize: "10px",
    color: colors.positive,
  },
  statusIcon: {
    width: "0.75rem",
    height: "0.75rem",
  },
  errorStatus: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1,
    fontSize: "10px",
    color: colors.danger,
  },
});
