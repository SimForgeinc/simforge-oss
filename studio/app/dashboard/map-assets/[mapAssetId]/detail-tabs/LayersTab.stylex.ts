import * as stylex from "@stylexjs/stylex";
import { colors, space, stroke } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

export const styles = stylex.create({
  layersTabContainer: {
    display: "flex",
    flexDirection: "column",
    gap: space.s5,
  },
  featureInspectorPanel: {
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: colors.accentLineSubtle,
    backgroundColor: colors.accentWash,
    padding: space.s3,
  },
});
