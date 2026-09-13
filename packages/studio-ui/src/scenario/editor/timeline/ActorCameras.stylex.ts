import * as stylex from "@stylexjs/stylex";
import { colors, text, space } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // w-editor-inspector shrink-0 overflow-y-auto border-l border-border bg-card p-3 text-foreground xl:w-editor-inspector-xl
  tightInkRuleL: {
    width: {
      default: space.inspectorWidth,
      "@media (min-width: 1280px)": space.inspectorWidthXl,
    },
    flexShrink: "0",
    overflowY: "auto",
    borderLeftWidth: "1px",
    borderColor: colors.border,
    backgroundColor: colors.card,
    padding: space.lg,
    color: colors.text,
  },
  // flex items-center text-micro font-semibold uppercase tracking-meta-wide text-muted-foreground
  flexCenterCaps: {
    display: "flex",
    alignItems: "center",
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    fontWeight: text.weightSemibold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaWide,
    color: colors.mutedForeground,
  },
  // mr-2 size-3
  mr2Size3: {
    marginRight: space.md,
    width: "0.75rem",
    height: "0.75rem",
  },
  // mt-3 flex items-center text-xs
  flexCenterXs: {
    marginTop: space.lg,
    display: "flex",
    alignItems: "center",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
  },
  // ml-auto h-7 text-primary hover:text-primary
  accentPushRight: {
    marginLeft: "auto",
    height: "1.75rem",
    color: {
      default: colors.primary,
      ":hover": colors.primary,
    },
  },
  // mt-1 flex items-center gap-2 border border-border bg-muted/30 px-2 py-1.5 text-meta
  flexCenterMeta: {
    marginTop: space.xs,
    display: "flex",
    alignItems: "center",
    gap: space.md,
    borderWidth: "1px",
    borderColor: colors.border,
    backgroundColor: "hsl(var(--muted) / 0.3)",
    paddingLeft: space.md,
    paddingRight: space.md,
    paddingTop: space.sm,
    paddingBottom: space.sm,
    fontSize: text.sizeMeta,
    lineHeight: "1rem",
  },
  // min-w-0 flex-1 truncate
  fillTruncateNarrowable: {
    minWidth: "0px",
    flex: "1 1 0%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  // ml-2 text-micro text-muted-foreground
  microMuted: {
    marginLeft: space.md,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    color: colors.mutedForeground,
  },
  // motionStyles.editorMotion + text-muted-foreground hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
  muted: {
    color: {
      default: colors.mutedForeground,
      ":hover": colors.danger,
    },
    outline: {
      default: null,
      ":focus-visible": "2px solid transparent",
    },
    outlineOffset: {
      default: null,
      ":focus-visible": "2px",
    },
    boxShadow: {
      default: null,
      ":focus-visible": "0 0 0 2px hsl(var(--ring))",
    },
  },
  // size-3
  size3: {
    width: "0.75rem",
    height: "0.75rem",
  },
  // mt-3 text-xs text-muted-foreground
  xsMuted: {
    marginTop: space.lg,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.mutedForeground,
  },
});
