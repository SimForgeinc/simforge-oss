import * as stylex from "@stylexjs/stylex";
import { colors, motion } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

const pulse = stylex.keyframes({
  "0%, 100%": { opacity: 1 },
  "50%": { opacity: 0.5 },
});

export const styles = stylex.create({
  mapPreviewLoadingPlaceholder: {
    position: "absolute",
    inset: "0",
    animationName: pulse,
    animationDuration: motion.durPulse,
    animationTimingFunction: motion.easePulse,
    animationIterationCount: "infinite",
    backgroundColor: colors.muted,
  },
});
