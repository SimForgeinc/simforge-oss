import * as stylex from "@stylexjs/stylex";
import { colors, motion, space, stroke, text } from "../../stylex/tokens.stylex";

export const styles = stylex.create({
  card: {
    borderRadius: "0.375rem",
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.card,
    color: "hsl(var(--card-foreground))",
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionDuration: motion.durStandard,
    transitionTimingFunction: motion.easeStandard,
  },
  header: {
    display: "grid",
    gridAutoRows: "min-content",
    gridTemplateColumns: "1fr auto",
    alignItems: "start",
    columnGap: space.s3,
    rowGap: space.s1_5,
    padding: space.s5,
  },
  title: {
    gridColumnStart: 1,
    fontSize: "15px",
    fontWeight: text.weightSemibold,
    lineHeight: text.lineSnug,
    letterSpacing: text.trackingTight,
  },
  description: { gridColumnStart: 1, fontSize: text.sizeSm, lineHeight: text.lineSm, color: colors.mutedForeground },
  action: { gridColumnStart: 2, gridRow: "span 2 / span 2", gridRowStart: 1, alignSelf: "start", justifySelf: "end" },
  content: { paddingInline: space.s5, paddingBottom: space.s3 },
  footer: { display: "flex", alignItems: "center", borderTopWidth: stroke.hairline, borderTopStyle: "solid", borderTopColor: colors.border, padding: space.s4, paddingInline: space.s5 },
});
