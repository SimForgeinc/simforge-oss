import * as stylex from "@stylexjs/stylex";
import { colors, layout, motion, shadows, space, stroke, text } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // shrink-0
  tight: {
    flexShrink: "0",
  },
  // min-w-0 flex-1
  fillNarrowable: {
    minWidth: "0px",
    flex: "1 1 0%",
  },
  // flex min-w-0 items-center gap-2
  flexCenterNarrowable: {
    display: "flex",
    minWidth: "0px",
    alignItems: "center",
    gap: space.s2,
  },
  // truncate text-sm font-semibold text-editor-text
  smSemiboldTruncate: {
    fontSize: text.sizeSm,
    lineHeight: text.lineSm,
    fontWeight: text.weightSemibold,
    color: colors.ink,
  },
  // shrink-0 border border-editor-line bg-editor-panel2 px-1.5 py-0.5 font-meta text-micro uppercase tracking-meta text-editor-muted
  tightCapsMeta: {
    flexShrink: "0",
    borderWidth: stroke.hairline,
    borderColor: colors.hairline,
    backgroundColor: colors.panel2,
    paddingLeft: space.s1_5,
    paddingRight: space.s1_5,
    paddingTop: space.s0_5,
    paddingBottom: space.s0_5,
    color: "rgb(154 154 154 / 1)",
  },
  // truncate font-meta text-micro uppercase tracking-meta text-editor-muted
  capsMetaMicro: {
    color: "rgb(154 154 154 / 1)",
  },
  // hidden shrink-0 items-center gap-2 font-meta text-micro uppercase tracking-meta text-editor-muted sm:flex
  hiddenCenterTight: {
    display: {
      default: "none",
      [layout.bpSm]: "flex",
    },
    flexShrink: "0",
    alignItems: "center",
    gap: space.s2,
    color: "rgb(154 154 154 / 1)",
  },
  // flex shrink-0 items-center gap-1.5
  flexCenterTight: {
    display: "flex",
    flexShrink: "0",
    alignItems: "center",
    gap: space.s1_5,
  },
  // flex min-h-[var(--scenario-header-height)] min-w-0 items-center gap-3 border-b border-editor-line bg-editor-bg/95 px-3 text-editor-text backdrop-blur-md sm:px-4
  flexCenterRuleB: {
    display: "flex",
    minHeight: "var(--scenario-header-height)",
    minWidth: "0px",
    alignItems: "center",
    gap: space.s3,
    borderBottomWidth: stroke.hairline,
    borderColor: colors.hairline,
    backgroundColor: "rgb(10 10 10 / 0.95)",
    paddingLeft: {
      default: space.s3,
      [layout.bpSm]: space.s4,
    },
    paddingRight: {
      default: space.s3,
      [layout.bpSm]: space.s4,
    },
    color: colors.ink,
    backdropFilter: motion.blurGlass,
  },
  // size-1.5 rounded-full
  round: {
    width: "0.375rem",
    height: "0.375rem",
  },
  // border border-editor-line bg-editor-bg/90 px-3 py-2 font-meta text-micro uppercase tracking-meta text-editor-muted shadow-xl backdrop-blur-md
  capsMetaMicro2: {
    borderWidth: stroke.hairline,
    borderColor: colors.hairline,
    backgroundColor: colors.scrimHeavy,
    paddingLeft: space.s3,
    paddingRight: space.s3,
    paddingTop: space.s2,
    paddingBottom: space.s2,
    color: "rgb(154 154 154 / 1)",
    boxShadow: shadows.elevationXl,
    backdropFilter: motion.blurGlass,
  },

  // bg-editor-muted (#9a9a9a)
  statusNeutral: {
    backgroundColor: "#9a9a9a",
  },
  // bg-emerald-400
  statusSaved: {
    backgroundColor: "rgb(52 211 153 / 1)",
  },
  // bg-editor-accent (#E8E044)
  statusWorking: {
    backgroundColor: colors.accent,
  },
  // bg-amber-400
  statusWarning: {
    backgroundColor: "rgb(251 191 36 / 1)",
  },
  // bg-rose-400
  statusError: {
    backgroundColor: "rgb(251 113 133 / 1)",
  },
});
