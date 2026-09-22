import * as stylex from "@stylexjs/stylex";
import { colors, text, space, motion } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

export const styles = stylex.create({
  sectionHeader: {
    marginBottom: space.lg,
    display: "flex",
    alignItems: "center",
    gap: space.lg,
  },
  sectionTitle: {
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    fontWeight: 600,
    color: colors.text,
  },
  tagCount: {
    paddingInline: "0.625rem",
    paddingBlock: space.xxs,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    fontWeight: 600,
    fontVariantNumeric: "tabular-nums",
  },
  tagCountFilled: {
    backgroundColor: "rgba(66, 32, 6, 0.6)",
    color: "#fde047",
  },
  tagCountEmpty: {
    backgroundColor: "hsl(var(--muted) / 0.6)",
    color: colors.mutedForeground,
  },
  loadingStatus: {
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.mutedForeground,
  },
  tagList: {
    marginBottom: space.lg,
    display: "flex",
    flexWrap: "wrap",
    gap: space.sm,
  },
  tagChip: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.xs,
    borderWidth: "1px",
    borderStyle: "solid",
    paddingInline: space.sm,
    paddingBlock: space.xxs,
    fontFamily: "var(--font-mono), ui-monospace, monospace",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
  },
  tagChipAuto: {
    borderColor: "rgba(29, 78, 216, 0.6)",
    backgroundColor: "rgba(23, 37, 84, 0.4)",
    color: "#93c5fd",
  },
  tagChipManual: {
    borderColor: "rgba(161, 98, 7, 0.6)",
    backgroundColor: "rgba(66, 32, 6, 0.4)",
    color: "#fde047",
  },
  autoBadge: {
    backgroundColor: "rgba(30, 64, 175, 0.5)",
    paddingInline: space.xs,
    paddingBlock: "1px",
    fontSize: "9px",
    fontWeight: 600,
    textTransform: "uppercase",
    lineHeight: 1,
    color: "#93c5fd",
  },
  tagRemove: {
    marginLeft: space.xxs,
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: motion.easeStandard,
    transitionDuration: "150ms",
  },
  tagRemoveAuto: {
    color: { default: "rgba(96, 165, 250, 0.7)", ":hover": "#bfdbfe" },
  },
  tagRemoveManual: {
    color: { default: "rgba(250, 204, 21, 0.7)", ":hover": "#fef08a" },
  },
  removeIcon: {
    width: "0.625rem",
    height: "0.625rem",
  },
  addTagSection: {
    position: "relative",
    marginBottom: space.lg,
  },
  compactOutlineControl: {
    height: "1.75rem",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
  },
  tagDropdownPanel: {
    position: "absolute",
    left: "0",
    top: "2rem",
    zIndex: 20,
    width: "20rem",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.bg,
    boxShadow: "0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -4px rgba(0, 0, 0, 0.1)",
  },
  searchInputWrapper: {
    padding: space.md,
  },
  tagOptionsList: {
    maxHeight: "12rem",
    overflowY: "auto",
  },
  noMatchingTags: {
    paddingInline: space.lg,
    paddingBlock: space.md,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.mutedForeground,
  },
  tagOptionButton: {
    display: "flex",
    width: "100%",
    alignItems: "flex-start",
    gap: space.md,
    paddingInline: space.lg,
    paddingBlock: space.sm,
    textAlign: "left",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    backgroundColor: { default: null, ":hover": "hsl(var(--muted) / 0.5)" },
  },
  tagOptionLabel: {
    flexShrink: 0,
    fontFamily: "var(--font-mono), ui-monospace, monospace",
    fontWeight: 500,
    color: colors.text,
  },
  tagOptionDescription: {
    color: colors.mutedForeground,
  },
  csvToggle: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: { default: colors.mutedForeground, ":hover": colors.text },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: motion.easeStandard,
    transitionDuration: "150ms",
  },
  chevron: {
    width: "0.75rem",
    height: "0.75rem",
    flexShrink: 0,
    transitionProperty: "transform",
    transitionTimingFunction: motion.easeStandard,
    transitionDuration: "150ms",
  },
  rotateMinus90: {
    transform: "rotate(-90deg)",
  },
  csvPanel: {
    marginTop: space.md,
    maxWidth: "32rem",
  },
  csvTextarea: {
    width: "100%",
    resize: "none",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "hsl(var(--input))",
    backgroundColor: colors.bg,
    paddingInline: "0.625rem",
    paddingBlock: space.sm,
    fontFamily: "var(--font-mono), ui-monospace, monospace",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.text,
    /*
     * `focus-visible:outline-none` is Tailwind's transparent 2px outline, not
     * `outline: none`: the focus ring above is a box-shadow, which
     * forced-colours mode discards, and this transparent outline is what
     * remains visible there.
     */
    outlineWidth: { default: null, ":focus-visible": "2px" },
    outlineStyle: { default: null, ":focus-visible": "solid" },
    outlineColor: { default: null, ":focus-visible": "transparent" },
    outlineOffset: { default: null, ":focus-visible": "2px" },
    boxShadow: { default: null, ":focus-visible": "0 0 0 1px hsl(var(--ring))" },
    "::placeholder": { color: "hsl(var(--muted-foreground) / 0.5)" },
  },
  stackY1_5: { marginTop: { default: space.sm, ":first-child": space.none } },
  csvErrorMessage: {
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.danger,
  },
  csvErrorList: {
    fontFamily: "var(--font-mono), ui-monospace, monospace",
  },
});
