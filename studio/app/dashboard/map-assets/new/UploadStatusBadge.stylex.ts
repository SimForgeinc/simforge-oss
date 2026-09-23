import * as stylex from "@stylexjs/stylex";
import { colors, space, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

export const styles = stylex.create({
  hashingStatus: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1,
    fontSize: text.sizeMicro,
    color: colors.mutedForeground,
  },
  loadingIcon: {
    width: "0.75rem",
    height: "0.75rem",
  },
  uploadingStatus: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1,
    fontSize: text.sizeMicro,
    color: colors.info,
  },
  successStatus: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1,
    fontSize: text.sizeMicro,
    color: colors.positive,
  },
  statusIcon: {
    width: "0.75rem",
    height: "0.75rem",
  },
  errorStatus: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1,
    fontSize: text.sizeMicro,
    color: colors.danger,
  },
});
