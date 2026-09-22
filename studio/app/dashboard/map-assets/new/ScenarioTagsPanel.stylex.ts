import * as stylex from "@stylexjs/stylex";
import { colors, layers, shadows, space, stroke, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

export const styles = stylex.create({
  sectionHeader: {
    marginBottom: space.s3,
    display: "flex",
    alignItems: "center",
    gap: space.s3,
  },
  sectionTitle: {
    fontSize: text.sizeSm,
    lineHeight: text.lineSm,
    fontWeight: text.weightSemibold,
    color: colors.text,
  },
  tagCount: {
    paddingInline: space.s2_5,
    paddingBlock: space.s0_5,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    fontWeight: text.weightSemibold,
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
    lineHeight: text.lineXs,
    color: colors.mutedForeground,
  },
  tagList: {
    marginBottom: space.s3,
    display: "flex",
    flexWrap: "wrap",
    gap: space.s1_5,
  },
  tagChip: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1,
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    paddingInline: space.s1_5,
    paddingBlock: space.s0_5,
    fontFamily: text.fontMono,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
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
    paddingInline: space.s1,
    paddingBlock: "1px",
    fontSize: "9px",
    fontWeight: text.weightSemibold,
    textTransform: "uppercase",
    lineHeight: 1,
    color: "#93c5fd",
  },
  tagRemove: {
    marginLeft: space.s0_5,
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
    marginBottom: space.s3,
  },
  compactOutlineControl: {
    height: "1.75rem",
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
  },
  tagDropdownPanel: {
    position: "absolute",
    left: "0",
    top: "2rem",
    zIndex: layers.float,
    width: "20rem",
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.bg,
    boxShadow: shadows.elevationLg,
  },
  searchInputWrapper: {
    padding: space.s2,
  },
  tagOptionsList: {
    maxHeight: "12rem",
    overflowY: "auto",
  },
  noMatchingTags: {
    paddingInline: space.s3,
    paddingBlock: space.s2,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.mutedForeground,
  },
  tagOptionButton: {
    display: "flex",
    width: "100%",
    alignItems: "flex-start",
    gap: space.s2,
    paddingInline: space.s3,
    paddingBlock: space.s1_5,
    textAlign: "left",
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    backgroundColor: { default: null, ":hover": "hsl(var(--muted) / 0.5)" },
  },
  tagOptionLabel: {
    flexShrink: 0,
    fontFamily: text.fontMono,
    fontWeight: text.weightMedium,
    color: colors.text,
  },
  tagOptionDescription: {
    color: colors.mutedForeground,
  },
  csvToggle: {
    display: "flex",
    alignItems: "center",
    gap: space.s1_5,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: { default: colors.mutedForeground, ":hover": colors.text },
  },
  chevron: {
    width: "0.75rem",
    height: "0.75rem",
    flexShrink: 0,
  },
  rotateMinus90: {
    transform: "rotate(-90deg)",
  },
  csvPanel: {
    marginTop: space.s2,
    maxWidth: "32rem",
  },
  csvTextarea: {
    width: "100%",
    resize: "none",
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: colors.input,
    backgroundColor: colors.bg,
    paddingInline: space.s2_5,
    paddingBlock: space.s1_5,
    fontFamily: text.fontMono,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.text,
    /*
     * `focus-visible:outline-none` is Tailwind's transparent 2px outline, not
     * `outline: none`: the focus ring above is a box-shadow, which
     * forced-colours mode discards, and this transparent outline is what
     * remains visible there.
     */
    outlineWidth: { default: null, ":focus-visible": stroke.thick },
    outlineStyle: { default: null, ":focus-visible": "solid" },
    outlineColor: { default: null, ":focus-visible": "transparent" },
    outlineOffset: { default: null, ":focus-visible": "2px" },
    boxShadow: { default: null, ":focus-visible": "0 0 0 1px hsl(var(--ring))" },
    "::placeholder": { color: "hsl(var(--muted-foreground) / 0.5)" },
  },
  stackY1_5: { marginTop: { default: space.s1_5, ":first-child": 0 } },
  csvErrorMessage: {
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.danger,
  },
  csvErrorList: {
    fontFamily: text.fontMono,
  },
});
