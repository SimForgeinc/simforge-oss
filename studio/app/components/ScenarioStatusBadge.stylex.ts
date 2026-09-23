import * as stylex from "@stylexjs/stylex";
import { colors, motion } from "@simforge-oss/studio-ui/stylex/tokens.stylex";
const spin = stylex.keyframes({ from: { transform: "rotate(0deg)" }, to: { transform: "rotate(360deg)" } });

export const styles = stylex.create({
  base: { display: "inline-flex", width: "1.5rem", height: "1.5rem", flexShrink: 0, cursor: "default", alignItems: "center", justifyContent: "center", padding: 0 },
  draft: { backgroundColor: "rgba(107,114,128,.15)", color: "rgb(156,163,175)", borderColor: "rgba(107,114,128,.2)" },
  finalized: { backgroundColor: colors.positiveWash, color: colors.positive, borderColor: colors.positive },
  queued: { backgroundColor: "rgba(234,179,8,.15)", color: colors.warning, borderColor: "rgba(234,179,8,.2)" },
  running: { backgroundColor: "rgba(59,130,246,.15)", color: colors.info, borderColor: "rgba(59,130,246,.2)" },
  failed: { backgroundColor: colors.criticalWash, color: colors.critical, borderColor: colors.critical },
  // size-3.5
  clockIcon: {
    width: "0.875rem",
    height: "0.875rem",
  },
  // size-3.5
  checkcheckIcon: {
    width: "0.875rem",
    height: "0.875rem",
  },
  // size-3.5
  clockIcon2: {
    width: "0.875rem",
    height: "0.875rem",
  },
  // size-3.5 animate-spin
  loader2Icon: {
    width: "0.875rem",
    height: "0.875rem",
    animationName: spin,
    animationDuration: motion.durSpin,
    animationTimingFunction: motion.easeLinear,
    animationIterationCount: "infinite",
  },
  // size-3.5
  checkcheckIcon2: {
    width: "0.875rem",
    height: "0.875rem",
  },
  // size-3.5
  xIcon: {
    width: "0.875rem",
    height: "0.875rem",
  },
});
