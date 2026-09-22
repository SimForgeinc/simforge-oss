import * as stylex from "@stylexjs/stylex";
import { colors, text, space } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

export const styles = stylex.create({
  fieldLabel: {
    marginBottom: space.sm,
    display: "block",
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    fontWeight: 500,
    color: colors.text,
  },
  requiredIndicator: {
    marginLeft: space.xxs,
    color: colors.danger,
  },
});
