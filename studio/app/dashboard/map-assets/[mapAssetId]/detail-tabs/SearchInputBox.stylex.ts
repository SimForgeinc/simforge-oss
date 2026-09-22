import * as stylex from "@stylexjs/stylex";
import { colors, layers, space, stroke, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

export const styles = stylex.create({
  searchContainer: {
    position: "relative",
  },
  searchIcon: {
    pointerEvents: "none",
    position: "absolute",
    left: "0.75rem",
    top: "50%",
    zIndex: layers.raised,
    width: "1rem",
    height: "1rem",
    transform: "translateY(-50%)",
    color: colors.mutedForeground,
  },
  searchInput: {
    height: "2.5rem",
    borderColor: colors.border,
    backgroundColor: "hsl(var(--muted) / 0.3)",
    paddingLeft: "2.25rem",
    paddingRight: "2.25rem",
    fontSize: text.sizeSm,
    lineHeight: text.lineSm,
  },
  clearButton: {
    position: "absolute",
    right: "0.75rem",
    top: "50%",
    zIndex: layers.raised,
    transform: "translateY(-50%)",
    color: { default: colors.mutedForeground, ":hover": colors.text },
  },
  clearIcon: {
    width: "0.875rem",
    height: "0.875rem",
  },
  suggestionsList: {
    position: "absolute",
    left: "0",
    right: "0",
    top: "100%",
    zIndex: layers.float,
    marginTop: space.s1,
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.popover,
    padding: space.s1,
    boxShadow: "0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -2px rgba(0, 0, 0, 0.1)",
  },
  suggestion: {
    display: "flex",
    width: "100%",
    alignItems: "center",
    paddingInline: space.s2,
    paddingBlock: space.s1_5,
    textAlign: "left",
    fontSize: text.sizeSm,
    lineHeight: text.lineSm,
    color: colors.text,
    backgroundColor: { default: null, ":hover": "hsl(var(--secondary) / 0.4)" },
  },
  suggestionHighlighted: {
    backgroundColor: "hsl(var(--secondary) / 0.4)",
  },
});
