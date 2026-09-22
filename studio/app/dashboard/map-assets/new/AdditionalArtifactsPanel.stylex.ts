import * as stylex from "@stylexjs/stylex";
import { colors, space, stroke, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

export const styles = stylex.create({
  artifactsPanel: {
    borderTopWidth: stroke.hairline,
    borderTopStyle: "solid",
    borderColor: colors.hairline,
    paddingTop: space.s5,
  },
  artifactsHeading: {
    marginBottom: space.s1,
    fontSize: text.sizeSm,
    lineHeight: text.lineSm,
    fontWeight: text.weightSemibold,
    color: colors.text,
  },
  artifactsDescription: {
    marginBottom: space.s3,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
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
    lineHeight: text.lineXs,
    color: colors.mutedForeground,
  },
  artifactTypeBadge: {
    flexShrink: 0,
    fontFamily: text.fontMono,
    fontSize: text.sizeMicro,
    lineHeight: "inherit",
  },
});
