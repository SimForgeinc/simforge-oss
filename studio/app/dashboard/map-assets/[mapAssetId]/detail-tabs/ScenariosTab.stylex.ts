import * as stylex from "@stylexjs/stylex";
import { colors, space, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

export const styles = stylex.create({
  scenariosContainer: {
    display: "flex",
    flexDirection: "column",
    gap: space.s3,
  },
  newScenarioSection: {
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
    fontSize: text.sizeMeta,
    lineHeight: text.lineXs,
    color: colors.mutedForeground,
  },
  scenarioActionButton: {
    flexShrink: 0,
    paddingInline: space.s2_5,
    paddingBlock: space.s1,
    fontSize: text.sizeMeta,
    fontWeight: text.weightMedium,
    color: colors.text,
    backgroundColor: { default: null, ":hover": colors.muted },
    cursor: { default: null, ":disabled": "not-allowed" },
    opacity: { default: null, ":disabled": 0.6 },
  },
  templateScenariosTitle: {
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
    padding: space.s2,
  },
  templateScenarioName: {
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    fontWeight: text.weightMedium,
    color: colors.text,
  },
  templateActorCount: {
    fontSize: text.sizeMeta,
    color: colors.mutedForeground,
  },
});
