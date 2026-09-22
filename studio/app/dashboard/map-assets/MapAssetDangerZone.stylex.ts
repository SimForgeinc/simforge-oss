import * as stylex from "@stylexjs/stylex";
import { colors, space, stroke, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

export const styles = stylex.create({
  dangerZone: {
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: colors.critical,
    backgroundColor: colors.criticalWash,
    padding: space.s3,
  },
  dangerToggle: {
    display: "flex",
    width: "100%",
    alignItems: "center",
    gap: space.s2,
    textAlign: "left",
  },
  dangerIcon: {
    marginTop: space.s0_5,
    width: "1rem",
    height: "1rem",
    flexShrink: 0,
    color: colors.danger,
  },
  dangerHeading: {
    flex: "1 1 0%",
    color: colors.danger,
  },
  dangerChevron: {
    width: "0.875rem",
    height: "0.875rem",
    flexShrink: 0,
    color: colors.critical,
  },
  dangerChevronOpen: { transform: "rotate(180deg)" },
  dangerContent: {
    marginTop: space.s2,
  },
  deletionWarning: {
    marginBottom: space.s2,
    fontSize: text.sizeMeta,
    lineHeight: text.lineRelaxed,
    color: colors.mutedForeground,
  },
  dangerMessage: {
    marginBottom: space.s2,
    fontSize: text.sizeMeta,
    color: colors.danger,
  },
  emailConfirmationInstruction: {
    marginBottom: space.s1_5,
    fontSize: text.sizeMeta,
    color: colors.mutedForeground,
  },
  sessionEmailDisplay: {
    marginBottom: space.s2,
    wordBreak: "break-all",
    backgroundColor: colors.fillSubtle,
    paddingInline: space.s2,
    paddingBlock: space.s1,
    fontFamily: text.fontMono,
    fontSize: text.sizeMicro,
    color: colors.text,
  },
  emailConfirmationInput: {
    marginBottom: space.s2,
    fontFamily: text.fontMono,
  },
  deleteButton: {
    width: "100%",
  },
});
