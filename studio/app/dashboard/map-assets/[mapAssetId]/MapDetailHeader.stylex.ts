import * as stylex from "@stylexjs/stylex";
import { colors, layout, space, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

export const styles = stylex.create({
  headerNavigationGroup: {
    display: "flex",
    minWidth: 0,
    alignItems: "center",
    gap: space.s2,
  },
  backToMapsLink: {
    display: "flex",
    height: "2.5rem",
    flexShrink: 0,
    alignItems: "center",
    gap: space.s1_5,
    paddingInline: space.s2,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: { default: colors.mutedForeground, ":hover": colors.text },
    backgroundColor: { default: null, ":hover": "hsl(var(--foreground) / 0.08)" },
  },
  sharedActionIcon: {
    width: "0.875rem",
    height: "0.875rem",
  },
  backToMapsLabel: {
    display: { default: "none", [layout.bpLg]: "inline" },
  },
  backLabel: {
    display: { default: null, [layout.bpLg]: "none" },
  },
  headerNavigationDivider: {
    display: { default: "none", [layout.bpMd]: "block" },
    height: "1.25rem",
    width: "1px",
    flexShrink: 0,
    backgroundColor: colors.border,
  },
  createScenarioButton: {
    gap: space.s1_5,
  },
  actionsMenuTrigger: {
    marginLeft: space.s2,
    width: "2.5rem",
    height: "2.5rem",
    flexShrink: 0,
    color: { default: "hsl(var(--foreground) / 0.7)", ":hover": colors.text },
    backgroundColor: { default: null, ":hover": "hsl(var(--foreground) / 0.08)" },
  },
  actionsMenuContent: {
    width: "12rem",
  },
  menuItemIcon: {
    marginRight: space.s2,
    width: "0.875rem",
    height: "0.875rem",
  },
  headerActionIcon: {
    marginRight: space.s2,
    width: "0.875rem",
    height: "0.875rem",
  },
  actionTooltip: {
    maxWidth: "20rem",
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
  },
});
