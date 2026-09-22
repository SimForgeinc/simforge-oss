import * as stylex from "@stylexjs/stylex";
import { colors, space, stroke, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

export const styles = stylex.create({
  scenariosContainer: {
    display: "flex",
    flexDirection: "column",
    gap: space.s3,
  },
  newScenarioSection: {
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: colors.border,
    padding: space.s3,
  },
  newScenarioRow: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: space.s3,
  },
  scenarioContentStack: {
    minWidth: 0,
  },
  newScenarioTitle: {
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    fontWeight: text.weightMedium,
    color: colors.text,
  },
  newScenarioDescription: {
    marginTop: space.s1,
    fontSize: "11px",
    lineHeight: text.lineXs,
    color: colors.mutedForeground,
  },
  scenarioActionButton: {
    flexShrink: 0,
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: colors.border,
    paddingInline: space.s2_5,
    paddingBlock: space.s1,
    fontSize: "11px",
    fontWeight: text.weightMedium,
    color: colors.text,
    backgroundColor: { default: null, ":hover": colors.muted },
    cursor: { default: null, ":disabled": "not-allowed" },
    opacity: { default: null, ":disabled": 0.6 },
  },
  templateScenariosTitle: {
    fontSize: "10px",
    fontWeight: text.weightMedium,
    textTransform: "uppercase",
    letterSpacing: text.trackingWider,
    color: colors.mutedForeground,
  },
  emptyTemplatesMessage: {
    marginTop: space.s2,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.mutedForeground,
  },
  templateScenariosList: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1_5,
    marginTop: space.s2,
  },
  templateScenarioItem: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.s3,
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: colors.border,
    padding: space.s2,
  },
  templateScenarioName: {
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    fontWeight: text.weightMedium,
    color: colors.text,
  },
  templateActorCount: {
    fontSize: "11px",
    color: colors.mutedForeground,
  },
});
