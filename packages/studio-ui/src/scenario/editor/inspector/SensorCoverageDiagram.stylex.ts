import * as stylex from "@stylexjs/stylex";
import { colors } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // h-full w-full
  wideTall: {
    height: "100%",
    width: "100%",
  },
  // fill-muted/40 stroke-foreground/25
  fillMuted40StrokeForeground25: {
    fill: "hsl(var(--muted) / 0.4)",
    stroke: "hsl(var(--foreground) / 0.25)",
  },
  // fill-none stroke-foreground/40
  fillNoneStrokeForeground40: {
    fill: "none",
    stroke: "hsl(var(--foreground) / 0.4)",
  },
  // cursor-pointer fill-transparent
  pointer: {
    cursor: "pointer",
    fill: "transparent",
  },

  // stroke-background
  markerStroke: {
    stroke: colors.bg,
  },
  // fill-primary
  markerSelected: {
    fill: colors.primary,
  },
  // fill-foreground/70
  markerEnabled: {
    fill: "hsl(var(--foreground) / 0.7)",
  },
  // fill-muted-foreground/40
  markerDisabled: {
    fill: "hsl(var(--muted-foreground) / 0.4)",
  },
  // fill-[url(#sensor-wedge-fade)] stroke-current
  wedge: {
    fill: "url(#sensor-wedge-fade)",
    stroke: "currentColor",
  },
  // text-primary
  wedgeSelected: {
    color: colors.primary,
  },
  // text-sky-300
  wedgeCamera: {
    color: "rgb(125 211 252 / 1)",
  },
  // text-emerald-300
  wedgeLidar: {
    color: "rgb(110 231 183 / 1)",
  },
  // text-orange-300
  wedgeOther: {
    color: "rgb(253 186 116 / 1)",
  },
});
