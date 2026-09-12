import * as stylex from "@stylexjs/stylex";

import { colors, motion, radii, space, text } from "../stylex/tokens.stylex";

export const scrub = stylex.defineVars({
  trackHeight: "3px",
  thumbScale: "0",
});

const COLOR_TRANSITION = "color, background-color, border-color, text-decoration-color, fill, stroke";

export const styles = stylex.create({
  root: {
    display: "flex",
    flexDirection: "column",
  },
  toolbar: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: space.lg,
    borderBottomStyle: "solid",
    borderBottomWidth: "1px",
    borderBottomColor: "rgba(255, 255, 255, 0.1)",
    backgroundColor: "rgba(0, 0, 0, 0.8)",
    paddingInline: space.xl,
    paddingBlock: space.md,
  },
  control: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.full,
    color: "white",
    transitionProperty: COLOR_TRANSITION,
    transitionDuration: "150ms",
    transitionTimingFunction: motion.easeStandard,
  },
  playControl: {
    width: "2rem",
    height: "2rem",
    backgroundColor: {
      default: colors.chip,
      ":hover": "rgba(255, 255, 255, 0.2)",
    },
  },
  restartControl: {
    width: "1.75rem",
    height: "1.75rem",
    color: {
      default: "rgba(255, 255, 255, 0.5)",
      ":hover": "white",
    },
    backgroundColor: {
      default: "transparent",
      ":hover": colors.chip,
    },
  },
  playIcon: {
    width: "0.875rem",
    height: "0.875rem",
  },
  playIconOffset: {
    marginLeft: space.xxs,
  },
  restartIcon: {
    width: "0.75rem",
    height: "0.75rem",
  },
  elapsedTime: {
    width: "2.5rem",
    textAlign: "right",
    fontFamily: text.fontMono,
    fontSize: text.sizeXs,
    lineHeight: text.lineMeta,
    color: "rgba(255, 255, 255, 0.6)",
  },
  durationTime: {
    width: "2.5rem",
    fontFamily: text.fontMono,
    fontSize: text.sizeXs,
    lineHeight: text.lineMeta,
    color: "rgba(255, 255, 255, 0.6)",
  },
  scrubArea: {
    [scrub.trackHeight]: "3px",
    [scrub.thumbScale]: "0",
    position: "relative",
    display: "flex",
    height: "1.5rem",
    flex: 1,
    cursor: "pointer",
    alignItems: "center",
    ":hover": {
      [scrub.trackHeight]: "5px",
      [scrub.thumbScale]: "1",
    },
  },
  scrubbing: {
    [scrub.trackHeight]: "5px",
    [scrub.thumbScale]: "1",
  },
  scrubTrack: {
    height: scrub.trackHeight,
    width: "100%",
    borderRadius: radii.full,
    backgroundColor: colors.chipStrong,
    transitionProperty: "all",
    transitionDuration: "150ms",
    transitionTimingFunction: motion.easeStandard,
  },
  scrubProgress: {
    position: "relative",
    height: "100%",
    borderRadius: radii.full,
    backgroundColor: colors.primary,
    transitionProperty: "width",
    transitionDuration: "75ms",
  },
  scrubThumb: {
    position: "absolute",
    right: "-5px",
    top: "50%",
    width: "0.625rem",
    height: "0.625rem",
    borderRadius: radii.full,
    backgroundColor: colors.primary,
    transform: `translateY(-50%) scale(${scrub.thumbScale})`,
    transitionProperty: "transform",
    transitionDuration: "150ms",
    transitionTimingFunction: motion.easeStandard,
  },
  body: {
    minHeight: 0,
    flex: 1,
    overflowY: "auto",
  },
});
