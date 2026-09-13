import * as stylex from "@stylexjs/stylex";
import { colors } from "../../../stylex/tokens.stylex";

/**
 * The lamp colours, as StyleX rules rather than class names.
 *
 * `indication-style.ts` used to hand callers Tailwind strings (`bg-signal-green`,
 * `border-signal-red`) because its own comment noted that Tailwind's scanner
 * reads source text, so `bg-signal-${indication}` would compile to nothing.
 * Writing the rules here removes that constraint entirely: the table below is
 * ordinary data, and the three surfaces that read it (the reference-light
 * editor, the timeline signal lane and the V1 rail) compose real styles.
 *
 * The values are the `--signal-*` custom properties, unchanged. A red light is a
 * red light: these are never remapped onto `danger` or `accent`, which mean
 * "something went wrong" and "this is the brand", not "stop".
 */
export const swatches = stylex.create({
  // bg-signal-green
  greenFill: { backgroundColor: colors.signalGreen },
  // bg-signal-green/25
  greenGhost: { backgroundColor: "hsl(var(--signal-green) / 0.25)" },
  // border-signal-green
  greenBorder: { borderColor: colors.signalGreen },
  // text-signal-green
  greenText: { color: colors.signalGreen },

  // bg-signal-yellow
  yellowFill: { backgroundColor: colors.signalYellow },
  // bg-signal-yellow/25
  yellowGhost: { backgroundColor: "hsl(var(--signal-yellow) / 0.25)" },
  // border-signal-yellow
  yellowBorder: { borderColor: colors.signalYellow },
  // text-signal-yellow
  yellowText: { color: colors.signalYellow },

  // bg-signal-red
  redFill: { backgroundColor: colors.signalRed },
  // bg-signal-red/25
  redGhost: { backgroundColor: "hsl(var(--signal-red) / 0.25)" },
  // border-signal-red
  redBorder: { borderColor: colors.signalRed },
  // text-signal-red
  redText: { color: colors.signalRed },

  // bg-signal-off
  offFill: { backgroundColor: colors.signalOff },
  // bg-signal-off/50
  offGhost: { backgroundColor: "hsl(var(--signal-off) / 0.5)" },

  // bg-signal-unknown
  unknownFill: { backgroundColor: colors.signalUnknown },
  // bg-signal-unknown/25
  unknownGhost: { backgroundColor: "hsl(var(--signal-unknown) / 0.25)" },
  // border-signal-unknown
  unknownBorder: { borderColor: colors.signalUnknown },
  // text-signal-unknown
  unknownText: { color: colors.signalUnknown },
});
