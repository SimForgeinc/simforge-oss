import * as stylex from "@stylexjs/stylex";
import { colors, text, space } from "../../../stylex/tokens.stylex";

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
    gap: space.md,
  },
  // truncate text-sm font-semibold text-editor-text
  smSemiboldTruncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    fontWeight: text.weightSemibold,
    color: "rgb(242 242 242 / 1)",
  },
  // shrink-0 border border-editor-line bg-editor-panel2 px-1.5 py-0.5 font-meta text-micro uppercase tracking-meta text-editor-muted
  tightCapsMeta: {
    flexShrink: "0",
    borderWidth: "1px",
    borderColor: colors.line,
    backgroundColor: colors.panel2,
    paddingLeft: space.sm,
    paddingRight: space.sm,
    paddingTop: space.xxs,
    paddingBottom: space.xxs,
    fontFamily: text.fontMeta,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: "rgb(154 154 154 / 1)",
  },
  // truncate font-meta text-micro uppercase tracking-meta text-editor-muted
  capsMetaMicro: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontFamily: text.fontMeta,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: "rgb(154 154 154 / 1)",
  },
  // hidden shrink-0 items-center gap-2 font-meta text-micro uppercase tracking-meta text-editor-muted sm:flex
  hiddenCenterTight: {
    display: {
      default: "none",
      "@media (min-width: 640px)": "flex",
    },
    flexShrink: "0",
    alignItems: "center",
    gap: space.md,
    fontFamily: text.fontMeta,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: "rgb(154 154 154 / 1)",
  },
  // flex shrink-0 items-center gap-1.5
  flexCenterTight: {
    display: "flex",
    flexShrink: "0",
    alignItems: "center",
    gap: space.sm,
  },
  // flex min-h-[var(--scenario-header-height)] min-w-0 items-center gap-3 border-b border-editor-line bg-editor-bg/95 px-3 text-editor-text backdrop-blur-md sm:px-4
  flexCenterRuleB: {
    display: "flex",
    minHeight: "var(--scenario-header-height)",
    minWidth: "0px",
    alignItems: "center",
    gap: space.lg,
    borderBottomWidth: "1px",
    borderColor: colors.line,
    backgroundColor: "rgb(10 10 10 / 0.95)",
    paddingLeft: {
      default: space.lg,
      "@media (min-width: 640px)": space.xl,
    },
    paddingRight: {
      default: space.lg,
      "@media (min-width: 640px)": space.xl,
    },
    color: "rgb(242 242 242 / 1)",
    backdropFilter: "blur(12px)",
  },
  // size-1.5 rounded-full
  round: {
    width: "0.375rem",
    height: "0.375rem",
    borderRadius: "0",
  },
  // border border-editor-line bg-editor-bg/90 px-3 py-2 font-meta text-micro uppercase tracking-meta text-editor-muted shadow-xl backdrop-blur-md
  capsMetaMicro2: {
    borderWidth: "1px",
    borderColor: colors.line,
    backgroundColor: "rgb(10 10 10 / 0.9)",
    paddingLeft: space.lg,
    paddingRight: space.lg,
    paddingTop: space.md,
    paddingBottom: space.md,
    fontFamily: text.fontMeta,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: "rgb(154 154 154 / 1)",
    boxShadow: "0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)",
    backdropFilter: "blur(12px)",
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
