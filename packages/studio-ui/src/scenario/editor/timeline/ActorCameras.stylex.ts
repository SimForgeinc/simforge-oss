import * as stylex from "@stylexjs/stylex";
import { colors, layout, shadows, space, stroke, text } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // w-editor-inspector shrink-0 overflow-y-auto border-l border-border bg-card p-3 text-foreground xl:w-editor-inspector-xl
  tightInkRuleL: {
    width: {
      default: space.inspectorWidth,
      [layout.bpXl]: space.inspectorWidthXl,
    },
    flexShrink: "0",
    overflowY: "auto",
    borderLeftWidth: stroke.hairline,
    borderColor: colors.border,
    backgroundColor: colors.card,
    padding: space.s3,
    color: colors.text,
  },
  // flex items-center text-micro font-semibold uppercase tracking-meta-wide text-muted-foreground
  flexCenterCaps: {
    display: "flex",
    alignItems: "center",
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    fontWeight: text.weightSemibold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaWide,
    color: colors.mutedForeground,
  },
  // mr-2 size-3
  mr2Size3: {
    marginRight: space.s2,
    width: "0.75rem",
    height: "0.75rem",
  },
  // mt-3 flex items-center text-xs
  flexCenterXs: {
    marginTop: space.s3,
    display: "flex",
    alignItems: "center",
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
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
    marginTop: space.s1,
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    borderWidth: stroke.hairline,
    borderColor: colors.border,
    backgroundColor: "hsl(var(--muted) / 0.3)",
    paddingLeft: space.s2,
    paddingRight: space.s2,
    paddingTop: space.s1_5,
    paddingBottom: space.s1_5,
    fontSize: text.sizeMeta,
    lineHeight: text.lineXs,
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
    marginLeft: space.s2,
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
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
      ":focus-visible": shadows.ring,
    },
  },
  // size-3
  size3: {
    width: "0.75rem",
    height: "0.75rem",
  },
  // mt-3 text-xs text-muted-foreground
  xsMuted: {
    marginTop: space.s3,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.mutedForeground,
  },
});
