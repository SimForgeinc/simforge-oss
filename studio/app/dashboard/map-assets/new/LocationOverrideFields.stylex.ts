import * as stylex from "@stylexjs/stylex";
import { colors, text, space } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

export const styles = stylex.create({
  locationOverrideHint: {
    marginBottom: space.s2,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.mutedForeground,
  },
  locationFieldsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: space.s2,
  },
  locationFieldLabel: {
    marginBottom: space.s1,
    display: "block",
    fontSize: "11px",
    color: colors.mutedForeground,
  },
  locationFieldInput: {
    height: "2rem",
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
  },
});
