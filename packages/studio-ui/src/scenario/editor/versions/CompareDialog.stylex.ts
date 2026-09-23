import * as stylex from "@stylexjs/stylex";

import { colors, stroke } from "../../../stylex/tokens.stylex";

/**
 * The compare stage's artwork: base simulation in secondary ink, candidate in accent, the
 * per-actor error line in warning. Paths scale with the SVG, so strokes do not.
 */
export const art = stylex.create({
  basePath: { fill: "none", stroke: colors.inkSecondary, strokeWidth: stroke.thick },
  candidatePath: { fill: "none", stroke: colors.accent, strokeWidth: stroke.hairline, strokeDasharray: "4 3" },
  baseMarker: { fill: colors.ink },
  candidateMarker: { fill: colors.accent },
  errorLine: { stroke: colors.warning, strokeWidth: stroke.hairline },
  path: { vectorEffect: "non-scaling-stroke" },
  scrubber: { accentColor: colors.accent },
  legendBase: { display: "inline-block", width: "1.5rem", borderTopWidth: stroke.thick, borderTopStyle: "solid", borderTopColor: colors.inkSecondary },
  legendCandidate: { display: "inline-block", width: "1.5rem", borderTopWidth: stroke.hairline, borderTopStyle: "dashed", borderTopColor: colors.accent },
});
