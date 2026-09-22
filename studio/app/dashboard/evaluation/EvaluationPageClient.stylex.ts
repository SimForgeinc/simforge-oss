import * as stylex from "@stylexjs/stylex";
import { colors, space, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

export const styles = stylex.create({
  /** The workspace picker in the rail header. */
  organization: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
  },
  organizationLabel: {
    fontFamily: text.fontMeta,
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    letterSpacing: text.trackingMetaWide,
    textTransform: "uppercase",
    color: colors.mutedForeground,
  },
  stagePad: {
    paddingInline: space.s6,
    paddingBlock: space.s6,
  },
});
