import * as stylex from "@stylexjs/stylex";
import { space } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

export const styles = stylex.create({
  layersTabContainer: {
    display: "flex",
    flexDirection: "column",
    gap: "1.25rem",
  },
  featureInspectorPanel: {
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "hsl(var(--primary) / 0.2)",
    backgroundColor: "hsl(var(--primary) / 0.05)",
    padding: space.s3,
  },
});
