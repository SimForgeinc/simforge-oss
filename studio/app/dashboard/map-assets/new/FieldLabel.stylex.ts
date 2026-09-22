import * as stylex from "@stylexjs/stylex";
import { colors, text, space } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

export const styles = stylex.create({
  fieldLabel: {
    marginBottom: space.s1_5,
    display: "block",
    fontSize: text.sizeSm,
    lineHeight: text.lineSm,
    fontWeight: text.weightMedium,
    color: colors.text,
  },
  requiredIndicator: {
    marginLeft: space.s0_5,
    color: colors.danger,
  },
});
