import * as stylex from "@stylexjs/stylex";
import { colors, text, space } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

export const styles = stylex.create({
  artifactsPanel: {
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderColor: colors.border,
    paddingTop: "1.25rem",
  },
  artifactsHeading: {
    marginBottom: space.s1,
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    fontWeight: 600,
    color: colors.text,
  },
  artifactsDescription: {
    marginBottom: space.s3,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.mutedForeground,
  },
  attachmentIcon: {
    marginRight: space.s1_5,
    width: "0.875rem",
    height: "0.875rem",
  },
  fileInput: {
    display: "none",
  },
  artifactsList: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
    marginTop: space.s2,
  },
  artifactItem: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.mutedForeground,
  },
  artifactFilename: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  artifactTypeBadge: {
    flexShrink: 0,
    fontFamily: "var(--font-mono), ui-monospace, monospace",
    fontSize: "10px",
    lineHeight: "inherit",
  },
});
