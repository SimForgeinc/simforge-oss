import * as stylex from "@stylexjs/stylex";
import { swatches } from "./indication-style.stylex";
import type { ControlIndication, MapSignalIndication } from "../../../lib/scenario/signals";

/**
 * How every signal surface names and colours an indication.
 *
 * One module because the panel, the movement diagram and the timeline lane must
 * agree: an author who sees a `flashing_yellow` band on the lane and a
 * "Flashing yellow" row in the phase list has to be able to tell they are the
 * same thing, and v1's three separate colour tables in
 * `signal-plan-model.ts` and the timeline signal lane
 * are why its own surfaces disagreed on grey.
 *
 * Colours come from the `--signal-*` tokens (plan §5.1), not from hex literals.
 * They are delivered as StyleX styles from `indication-style.stylex`, so the
 * table below is ordinary data — the old "write every class out because
 * Tailwind's scanner reads source text" constraint is gone with the classes.
 */

/** Eleven, not six: the lane draws whatever the compiled result carries. */
const INDICATION_LABELS: Readonly<Record<ControlIndication, string>> = {
  green: "Green",
  yellow: "Yellow",
  red: "Red",
  flashing_yellow: "Flashing yellow",
  flashing_red: "Flashing red",
  flashing_yellow_arrow: "Flashing yellow arrow",
  flashing_red_arrow: "Flashing red arrow",
  off: "Off",
  green_arrow: "Green arrow",
  yellow_arrow: "Yellow arrow",
  red_x: "Red X",
  proceed: "Proceed",
  stop: "Stop",
};

export function indicationLabel(indication: ControlIndication): string {
  return INDICATION_LABELS[indication];
}

/**
 * The six an author may write, in lamp order.
 *
 * Ordered top-to-bottom as the housing is, so a picker reads like the hardware.
 * There is deliberately **no arrow entry**: an arrow is a lens derived from the
 * plan's protected turns (`signalLensKindIndex`), and `MapSignalPlanClipSchema`
 * refines the enum down to exactly these six — offering `green_arrow` here would
 * be rejected at save time. See `lib/scenario/signals/types.ts`.
 */
export const AUTHORABLE_INDICATIONS: readonly MapSignalIndication[] = [
  "green",
  "yellow",
  "red",
  "flashing_yellow",
  "flashing_red",
  "off",
];

type IndicationSwatch = {
  /** Solid fill, for a swatch or an authored band. */
  readonly fill: stylex.StyleXStyles;
  /** Faint fill, for a baseline band the author cannot retime. */
  readonly ghost: stylex.StyleXStyles;
  /** Border, so a dark `off` lamp is still visible against the card. */
  readonly border: stylex.StyleXStyles;
  readonly text: stylex.StyleXStyles;
};

const NEUTRAL: IndicationSwatch = {
  fill: swatches.unknownFill,
  ghost: swatches.unknownGhost,
  border: swatches.unknownBorder,
  text: swatches.unknownText,
};

const GREEN: IndicationSwatch = {
  fill: swatches.greenFill,
  ghost: swatches.greenGhost,
  border: swatches.greenBorder,
  text: swatches.greenText,
};

const YELLOW: IndicationSwatch = {
  fill: swatches.yellowFill,
  ghost: swatches.yellowGhost,
  border: swatches.yellowBorder,
  text: swatches.yellowText,
};

const RED: IndicationSwatch = {
  fill: swatches.redFill,
  ghost: swatches.redGhost,
  border: swatches.redBorder,
  text: swatches.redText,
};

const SWATCHES: Readonly<Record<ControlIndication, IndicationSwatch>> = {
  green: GREEN,
  // The two arrows share their ball colour: the glyph carries the difference,
  // and tinting an arrow differently from a ball would imply the lamp is a
  // different colour than it is.
  green_arrow: GREEN,
  proceed: GREEN,
  yellow: YELLOW,
  yellow_arrow: YELLOW,
  flashing_yellow: YELLOW,
  flashing_yellow_arrow: YELLOW,
  red: RED,
  red_x: RED,
  stop: RED,
  flashing_red: RED,
  flashing_red_arrow: RED,
  // An unlit lamp keeps the neutral outline and label: the housing is still
  // there, and `border-signal-off` on `bg-signal-off` would be invisible.
  off: {
    fill: swatches.offFill,
    ghost: swatches.offGhost,
    border: swatches.unknownBorder,
    text: swatches.unknownText,
  },
};

/** Swatch styles for an indication; the neutral set when nothing is stated. */
export function indicationSwatch(indication: ControlIndication | null): IndicationSwatch {
  return indication ? SWATCHES[indication] : NEUTRAL;
}

/**
 * Whether an indication flashes, so a band can carry the `editor-pulse`
 * utility. That utility is already `prefers-reduced-motion`-guarded in
 * `globals.css`, which is why this returns a flag rather than an animation.
 */
export function indicationFlashes(indication: ControlIndication): boolean {
  return indication === "flashing_red" || indication === "flashing_yellow"
    || indication === "flashing_red_arrow" || indication === "flashing_yellow_arrow";
}

/** `12.3` rather than `12.300000000000001`, for a readout or a label. */
export function formatSeconds(seconds: number): string {
  return seconds.toFixed(1);
}
