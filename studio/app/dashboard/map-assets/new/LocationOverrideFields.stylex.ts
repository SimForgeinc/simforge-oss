import * as stylex from "@stylexjs/stylex";
import { colors, text, space } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

export const styles = stylex.create({
  locationOverrideHint: {
    marginBottom: space.md,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.mutedForeground,
  },
  locationFieldsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: space.md,
  },
  locationFieldLabel: {
    marginBottom: space.xs,
    display: "block",
    fontSize: "11px",
    color: colors.mutedForeground,
  },
  locationFieldInput: {
    height: "2rem",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
  },
});
