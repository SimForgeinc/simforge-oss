import * as stylex from "@stylexjs/stylex";
import { colors, space, stroke, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

export const styles = stylex.create({
  dangerZone: {
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: "hsl(var(--destructive) / 0.4)",
    backgroundColor: "hsl(var(--destructive) / 0.05)",
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
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    fontWeight: text.weightSemibold,
    textTransform: "uppercase",
    letterSpacing: text.trackingWide,
    color: colors.danger,
  },
  dangerChevron: {
    width: "0.875rem",
    height: "0.875rem",
    flexShrink: 0,
    color: "hsl(var(--destructive) / 0.7)",
  },
  dangerChevronOpen: { transform: "rotate(180deg)" },
  dangerContent: {
    marginTop: space.s2,
  },
  deletionWarning: {
    marginBottom: space.s2,
    fontSize: "11px",
    lineHeight: text.lineRelaxed,
    color: colors.mutedForeground,
  },
  dangerMessage: {
    marginBottom: space.s2,
    fontSize: "11px",
    color: colors.danger,
  },
  emailConfirmationInstruction: {
    marginBottom: space.s1_5,
    fontSize: "11px",
    color: colors.mutedForeground,
  },
  sessionEmailDisplay: {
    marginBottom: space.s2,
    wordBreak: "break-all",
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: "hsl(var(--muted) / 0.4)",
    paddingInline: space.s2,
    paddingBlock: space.s1,
    fontFamily: text.fontMono,
    fontSize: "10px",
    color: colors.text,
  },
  emailConfirmationInput: {
    marginBottom: space.s2,
    height: "2rem",
    fontFamily: text.fontMono,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
  },
  deleteButton: {
    width: "100%",
  },
});
