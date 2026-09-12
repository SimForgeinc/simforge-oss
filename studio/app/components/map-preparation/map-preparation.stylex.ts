/**
 * StyleX styles for the host's map-preparation rows.
 *
 * The same install row the onboarding screen shows, at the density the
 * dashboard uses: this component is mounted inside existing panels rather than
 * on its own screen, so it is a shade tighter and carries no screen chrome.
 * Radii stay `none` because the product's radius scale resolves to zero.
 */

import * as stylex from "@stylexjs/stylex";
import { colors, radii, space, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

/**
 * Completed fraction of one row, as a percentage string. The fill is one
 * static class; only this variable changes as bytes land.
 */
export const PROGRESS_VAR = "--map-preparation-progress";

export const preparation = stylex.create({
  summary: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    fontFamily: text.fontMono,
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    textTransform: "uppercase",
    color: colors.textFaint,
  },
  list: {
    display: "grid",
    gap: space.md,
    marginTop: space.lg,
  },
  row: {
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.line,
    borderRadius: radii.none,
    backgroundColor: "rgba(255, 255, 255, 0.03)",
    paddingInline: space.lg,
    paddingBlock: "0.625rem",
  },
  rowHead: {
    display: "flex",
    alignItems: "center",
    gap: space.lg,
  },
  stateIcon: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: "1.25rem",
    height: "1.25rem",
    color: colors.accent,
  },
  rowLabel: {
    minWidth: 0,
    flexGrow: 1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "0.875rem",
    lineHeight: "1.25rem",
    color: "rgba(255, 255, 255, 0.8)",
  },
  rowBytes: {
    fontFamily: text.fontMono,
    fontSize: "0.6875rem",
    color: "rgba(255, 255, 255, 0.4)",
  },
  rowActions: {
    display: "flex",
    flexShrink: 0,
    gap: space.md,
  },
  track: {
    marginTop: space.md,
    height: "0.25rem",
    overflow: "hidden",
    borderRadius: radii.none,
    backgroundColor: colors.chip,
  },
  fill: {
    height: "100%",
    width: `var(${PROGRESS_VAR})`,
    borderRadius: radii.none,
    backgroundColor: colors.accent,
    transitionProperty: "width",
    transitionDuration: "500ms",
  },
  rowMessage: {
    marginTop: space.md,
    fontSize: "0.75rem",
    lineHeight: "1rem",
    color: colors.danger,
  },
});
