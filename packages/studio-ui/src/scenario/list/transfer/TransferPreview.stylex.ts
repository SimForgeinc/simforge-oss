/**
 * StyleX styles for `TransferPreview`, the plan a transfer candidate is drawn
 * as. SVG paint only: lanes as low-alpha ribbons, the lane lines as a faint
 * dash, the subject and its route in the accent, everyone else in ink.
 * Stroke widths of the ribbons are the lanes' own widths in metres and travel
 * as attributes; the few fixed widths here are metres too, in the plan's frame.
 */

import * as stylex from "@stylexjs/stylex";
import { colors } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  svg: { display: "block", width: "100%", height: "100%" },
  drive: { fill: "none", stroke: colors.fillStrong, strokeLinejoin: "round" },
  walk: { fill: "none", stroke: colors.fillSubtle, strokeLinejoin: "round" },
  park: { fill: "none", stroke: colors.fill, strokeLinejoin: "round" },
  laneLine: { fill: "none", stroke: colors.hairline, strokeWidth: 0.2, strokeDasharray: "2 3" },
  route: { fill: "none", stroke: colors.accentLine, strokeWidth: 1.1, strokeLinejoin: "round" },
  subject: { fill: colors.accent },
  vehicle: { fill: colors.ink },
  vru: { fill: colors.ink },
  object: { fill: colors.inkFaint },
});
