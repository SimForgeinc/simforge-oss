import * as stylex from "@stylexjs/stylex";
import { colors, text, space } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // min-w-0 (was min-w-0 space-y-2)
  /*
   * `space-y-2` is a `> * + *` rule with no StyleX form. Every child of this
   * section is a block-level box with no vertical margin of its own, so a flex
   * column with the same 8px gap places them identically.
   */
  narrowable: {
    minWidth: "0px",
    display: "flex",
    flexDirection: "column",
    gap: space.md,
  },
  // flex min-w-0 items-center justify-between gap-2
  flexCenterBetween: {
    display: "flex",
    minWidth: "0px",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.md,
  },
  // min-w-0 truncate text-meta font-semibold text-foreground
  metaInkSemibold: {
    minWidth: "0px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: text.sizeMeta,
    lineHeight: "1rem",
    fontWeight: text.weightSemibold,
    color: colors.text,
  },
  // flex h-2 w-full overflow-hidden border border-border bg-muted
  flexBorderedClip: {
    display: "flex",
    height: "0.5rem",
    width: "100%",
    overflow: "hidden",
    borderWidth: "1px",
    borderColor: colors.border,
    backgroundColor: colors.muted,
  },
  // overflow-hidden rounded-md border border-border
  borderedClip: {
    overflow: "hidden",
    borderRadius: "0",
    borderWidth: "1px",
    borderColor: colors.border,
  },
  // grid grid-cols-[20px_minmax(0,1fr)_58px_42px] items-center border-b border-border bg-muted/60 px-1.5 py-1 text-micro uppercase tracking-wide text-muted-foreground
  gridCenterCaps: {
    display: "grid",
    gridTemplateColumns: "20px minmax(0, 1fr) 58px 42px",
    alignItems: "center",
    borderBottomWidth: "1px",
    borderColor: colors.border,
    backgroundColor: "hsl(var(--muted) / 0.6)",
    paddingLeft: space.sm,
    paddingRight: space.sm,
    paddingTop: space.xs,
    paddingBottom: space.xs,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    textTransform: "uppercase",
    letterSpacing: "0.025em",
    color: colors.mutedForeground,
  },
  // text-right
  rightText: {
    textAlign: "right",
  },
  // sr-only
  srOnly: {
    position: "absolute",
    width: "1px",
    height: "1px",
    padding: space.none,
    margin: "-1px",
    overflow: "hidden",
    clip: "rect(0, 0, 0, 0)",
    whiteSpace: "nowrap",
    borderWidth: "0",
  },
  // text-micro leading-relaxed text-muted-foreground
  microMutedRelaxed: {
    fontSize: text.sizeMicro,
    lineHeight: "1.625",
    color: colors.mutedForeground,
  },
  // border border-signal-yellow/50 bg-signal-yellow/10 px-2 py-1.5 text-micro leading-relaxed text-signal-yellow
  microBorderedRelaxed: {
    borderWidth: "1px",
    borderColor: "hsl(var(--signal-yellow) / 0.5)",
    backgroundColor: "hsl(var(--signal-yellow) / 0.1)",
    paddingLeft: space.md,
    paddingRight: space.md,
    paddingTop: space.sm,
    paddingBottom: space.sm,
    fontSize: text.sizeMicro,
    lineHeight: "1.625",
    color: "hsl(var(--signal-yellow) / 1)",
  },
  // grid grid-cols-[20px_minmax(0,1fr)_58px_42px] items-center border-b border-border px-1.5 py-1 last:border-b-0
  gridCenterRuleB: {
    display: "grid",
    gridTemplateColumns: "20px minmax(0, 1fr) 58px 42px",
    alignItems: "center",
    borderBottomWidth: {
      default: "1px",
      ":last-child": "0px",
    },
    borderColor: colors.border,
    paddingLeft: space.sm,
    paddingRight: space.sm,
    paddingTop: space.xs,
    paddingBottom: space.xs,
  },
  // grid place-items-center
  gridCentered: {
    display: "grid",
    placeItems: "center",
  },
  // size-3 text-muted-foreground/60
  size3TextMutedForeground60: {
    width: "0.75rem",
    height: "0.75rem",
    color: "hsl(var(--muted-foreground) / 0.6)",
  },
  // flex min-w-0 items-center gap-1.5
  flexCenterNarrowable: {
    display: "flex",
    minWidth: "0px",
    alignItems: "center",
    gap: space.sm,
  },
  // truncate text-meta text-foreground
  metaInkTruncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: text.sizeMeta,
    lineHeight: "1rem",
    color: colors.text,
  },
  // relative
  rel: {
    position: "relative",
  },
  // h-6 w-full pr-3 pl-1 text-right text-meta tabular-nums
  metaWideRightText: {
    height: "1.5rem",
    width: "100%",
    paddingLeft: space.xs,
    paddingRight: space.lg,
    textAlign: "right",
    fontSize: text.sizeMeta,
    lineHeight: "1rem",
    fontVariantNumeric: "tabular-nums",
  },
  // pointer-events-none absolute right-1 top-1/2 -translate-y-1/2 text-[8px] text-muted-foreground
  absMutedInert: {
    pointerEvents: "none",
    position: "absolute",
    right: space.xs,
    top: "50%",
    transform: "translate(0, -50%)",
    fontSize: "8px",
    color: colors.mutedForeground,
  },
  // flex justify-end
  flexEnd: {
    display: "flex",
    justifyContent: "flex-end",
  },
  // grid size-5 place-items-center text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-20
  gridCenteredMuted: {
    display: "grid",
    width: "1.25rem",
    height: "1.25rem",
    placeItems: "center",
    color: {
      default: colors.mutedForeground,
      ":hover": colors.text,
    },
    opacity: {
      default: null,
      ":disabled": "0.2",
    },
    backgroundColor: {
      default: null,
      ":hover": colors.muted,
    },
  },
  // size-3
  size3: {
    width: "0.75rem",
    height: "0.75rem",
  },

  // size-2.5 shrink-0 rounded-full
  phaseDot: {
    width: "0.625rem",
    height: "0.625rem",
    flexShrink: 0,
    borderRadius: "0",
  },
});
