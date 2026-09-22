import * as stylex from "@stylexjs/stylex";
import { colors, shadows, space, stroke, text } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // min-w-0
  narrowable: {
    minWidth: "0px",
  },
  // flex min-w-0 items-center gap-1.5
  flexCenterNarrowable: {
    display: "flex",
    minWidth: "0px",
    alignItems: "center",
    gap: space.s1_5,
  },
  // motionStyles.editorMotion + shrink-0 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card
  tightMuted: {
    flexShrink: "0",
    color: {
      default: colors.mutedForeground,
      ":hover": colors.text,
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
      ":focus-visible": shadows.ringOffset,
    },
  },
  // size-3
  size3: {
    width: "0.75rem",
    height: "0.75rem",
  },
  // min-w-0 flex-1 truncate text-micro text-foreground
  fillMicroInk: {
    minWidth: "0px",
    flex: "1 1 0%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    color: colors.text,
  },
  // ml-1 text-muted-foreground
  muted: {
    marginLeft: space.s1,
    color: colors.mutedForeground,
  },
  // min-w-0 pl-4
  narrowable2: {
    minWidth: "0px",
    paddingLeft: space.s4,
  },
  // block truncate text-micro text-muted-foreground
  blockMicroMuted: {
    display: "block",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    color: colors.mutedForeground,
  },
  // relative h-4 min-w-0 bg-muted
  relNarrowable: {
    position: "relative",
    height: "1rem",
    minWidth: "0px",
    backgroundColor: colors.muted,
  },
  // motionStyles.editorMotion + absolute top-0 h-4 w-1.5 -translate-x-1/2 cursor-col-resize bg-foreground/40 hover:bg-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset
  abs: {
    position: "absolute",
    top: 0,
    height: "1rem",
    width: "0.375rem",
    transform: "translate(-50%, 0)",
    cursor: "col-resize",
    backgroundColor: {
      default: "hsl(var(--foreground) / 0.4)",
      ":hover": colors.primary,
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
      ":focus-visible": shadows.ringInset,
    },
  },
  // absolute top-0 flex h-4 items-center justify-center overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset
  absFlexCenter: {
    position: "absolute",
    top: 0,
    display: "flex",
    height: "1rem",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
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
      ":focus-visible": shadows.ringInset,
    },
  },
  // cursor-pointer
  pointer: {
    cursor: "pointer",
  },
  // cursor-default
  cursorDefault: {
    cursor: "default",
  },
  // border-y border-dashed border-border
  dashed: {
    borderTopWidth: stroke.hairline,
    borderBottomWidth: stroke.hairline,
    borderStyle: "dashed",
    borderColor: colors.border,
  },
});
