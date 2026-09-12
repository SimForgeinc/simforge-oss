import * as stylex from "@stylexjs/stylex";
import { colors, text } from "../../stylex/tokens.stylex";

export const styles = stylex.create({
  card: {
    borderRadius: "0.375rem",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.card,
    color: "hsl(var(--card-foreground))",
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionDuration: "150ms",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
  },
  header: {
    display: "grid",
    gridAutoRows: "min-content",
    gridTemplateColumns: "1fr auto",
    alignItems: "start",
    columnGap: "0.75rem",
    rowGap: "0.375rem",
    padding: "1.25rem",
  },
  title: {
    gridColumnStart: 1,
    fontSize: "15px",
    fontWeight: 600,
    lineHeight: "1.375",
    letterSpacing: "-0.025em",
  },
  description: { gridColumnStart: 1, fontSize: text.sizeSm, color: colors.mutedForeground },
  action: { gridColumnStart: 2, gridRow: "span 2 / span 2", gridRowStart: 1, alignSelf: "start", justifySelf: "end" },
  content: { paddingInline: "1.25rem", paddingBottom: "0.75rem" },
  footer: { display: "flex", alignItems: "center", borderTopWidth: 1, borderTopStyle: "solid", borderTopColor: colors.border, padding: "1rem", paddingInline: "1.25rem" },
});
