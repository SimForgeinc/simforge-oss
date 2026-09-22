import * as stylex from "@stylexjs/stylex";
import { colors } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

export const styles = stylex.create({
  mapPreviewLoadingPlaceholder: {
    position: "absolute",
    inset: "0",
    backgroundColor: colors.muted,
  },
});
