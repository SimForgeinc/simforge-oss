import * as stylex from "@stylexjs/stylex";
import { space, stroke } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

export const styles = stylex.create({
  layersTabContainer: {
    display: "flex",
    flexDirection: "column",
    gap: space.s5,
  },
  featureInspectorPanel: {
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: "hsl(var(--primary) / 0.2)",
    backgroundColor: "hsl(var(--primary) / 0.05)",
    padding: space.s3,
  },
});
