/**
 * StyleX styles for the host's map-preparation rows.
 *
 * The same install row the onboarding screen shows, at the density the
 * dashboard uses: this component is mounted inside existing panels rather than
 * on its own screen, so it is a shade tighter and carries no screen chrome.
 * Radii stay `none` because the product's radius scale resolves to zero.
 */

import * as stylex from "@stylexjs/stylex";
import { colors, space, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

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
    color: colors.inkFaint,
  },
  list: {
    display: "grid",
    gap: space.s2,
    marginTop: space.s3,
  },
  row: {
    backgroundColor: colors.fillFaint,
    paddingInline: space.s3,
    paddingBlock: space.s2_5,
  },
  rowHead: {
    display: "flex",
    alignItems: "center",
    gap: space.s3,
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
    flex: 1,
    fontSize: text.sizeSm,
    lineHeight: text.lineSm,
    color: colors.inkSecondary,
  },
  rowBytes: {
    fontFamily: text.fontMono,
    fontSize: text.sizeMeta,
    color: colors.inkMuted,
  },
  rowActions: {
    display: "flex",
    flexShrink: 0,
    gap: space.s2,
  },
  track: {
    marginTop: space.s2,
    height: "0.25rem",
    overflow: "hidden",
    backgroundColor: colors.fillStrong,
  },
  fill: {
    height: "100%",
    width: `var(${PROGRESS_VAR})`,
    backgroundColor: colors.accent,
    transitionProperty: "width",
    transitionDuration: "500ms",
  },
  rowMessage: {
    marginTop: space.s2,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.danger,
  },
});
