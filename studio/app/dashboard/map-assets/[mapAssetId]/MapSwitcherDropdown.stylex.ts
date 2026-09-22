import * as stylex from "@stylexjs/stylex";
import { colors, layout, space, stroke, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

export const styles = stylex.create({
  dropdownTrigger: {
    display: "flex",
    height: "2.5rem",
    width: { default: "11rem", [layout.bpSm]: "280px" },
    alignItems: "center",
    gap: space.s1_5,
    backgroundColor: { default: colors.fillFaint, ":hover": colors.fillSubtle },
    paddingInline: space.s3,
    fontSize: text.sizeSm,
    lineHeight: text.lineSm,
    fontWeight: text.weightMedium,
  },
  currentMapName: {
    flex: "1 1 0%",
    textAlign: "left",
  },
  dropdownChevron: {
    width: "0.875rem",
    height: "0.875rem",
    flexShrink: 0,
    color: colors.mutedForeground,
    marginLeft: "auto",
  },
  dropdownContent: {
    width: "280px",
    padding: 0,
  },
  searchSection: {
    borderBottomWidth: stroke.hairline,
    borderBottomStyle: "solid",
    borderColor: colors.hairline,
    padding: space.s2,
  },
  searchFieldWrapper: {
    position: "relative",
  },
  searchIcon: {
    pointerEvents: "none",
    position: "absolute",
    left: "0.625rem",
    top: "50%",
    width: "0.875rem",
    height: "0.875rem",
    transform: "translateY(-50%)",
    color: colors.mutedForeground,
  },
  searchInput: {
    paddingLeft: space.s8,
  },
  mapList: {
    maxHeight: "16rem",
    overflowY: "auto",
    paddingBlock: space.s1,
  },
  noResultsMessage: {
    paddingInline: space.s3,
    paddingBlock: space.s4,
    textAlign: "center",
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.mutedForeground,
  },
  switcherItem: {
    display: "flex",
    width: "100%",
    alignItems: "center",
    gap: space.s2,
    paddingInline: space.s3,
    paddingBlock: space.s2,
    textAlign: "left",
  },
  switcherItemCurrent: {
    backgroundColor: colors.accentWash,
    color: colors.primary,
  },
  switcherItemOther: {
    color: colors.text,
    backgroundColor: { default: null, ":hover": colors.fillSubtle },
  },
  selectedMapIcon: {
    width: "0.875rem",
    height: "0.875rem",
    flexShrink: 0,
    color: colors.primary,
  },
  unselectedMapIndicator: {
    width: "0.875rem",
    height: "0.875rem",
    flexShrink: 0,
  },
  mapItemText: {
    minWidth: 0,
    flex: "1 1 0%",
  },
  switcherLabel: {
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
  },
  switcherLabelCurrent: {
    fontWeight: text.weightMedium,
  },
  mapLocation: {
    fontSize: text.sizeMicro,
    color: colors.mutedForeground,
  },
});
