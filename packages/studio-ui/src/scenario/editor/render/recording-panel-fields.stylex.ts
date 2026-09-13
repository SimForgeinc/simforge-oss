import * as stylex from "@stylexjs/stylex";
import { colors, text, space } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // mt-3 border-t render-hairline pt-3
  ruleT: {
    marginTop: space.lg,
    borderTopWidth: "1px",
    paddingTop: space.lg,
    borderColor: "rgb(255 255 255 / 10%)",
  },
  // flex items-center gap-2
  flexCenterGap2: {
    display: "flex",
    alignItems: "center",
    gap: space.md,
  },
  // size-3.5 text-muted-foreground
  muted: {
    width: "0.875rem",
    height: "0.875rem",
    color: colors.mutedForeground,
  },
  // text-micro font-bold uppercase tracking-meta text-muted-foreground
  capsMicroMuted: {
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: colors.mutedForeground,
  },
  // mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 text-xs sm:grid-cols-4
  gridXsCols2: {
    marginTop: space.sm,
    display: "grid",
    gridTemplateColumns: {
      default: "repeat(2, minmax(0, 1fr))",
      "@media (min-width: 640px)": "repeat(4, minmax(0, 1fr))",
    },
    MozColumnGap: "0.75rem",
    columnGap: space.lg,
    rowGap: space.xs,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
  },
  // mt-1.5 text-micro text-muted-foreground
  microMuted: {
    marginTop: space.sm,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    color: colors.mutedForeground,
  },
  // text-muted-foreground
  muted2: {
    color: colors.mutedForeground,
  },
  // font-medium
  medium: {
    fontWeight: text.weightMedium,
  },
  /*
   * `space-y-*` is a `> * + *` rule with no StyleX form — StyleX styles only
   * the element they are applied to — so the margin it handed down now sits on
   * the child that received it, and only the first child goes without.
   */
  // text-xs
  xs: {
    fontSize: text.sizeXs,
    lineHeight: "1rem",
  },
  // (was the label's space-y-1)
  stackedXs: {
    marginTop: space.xs,
  },
  // h-9 w-full render-glass border px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
  smBorderedWide: {
    height: "2.25rem",
    width: "100%",
    borderWidth: "1px",
    paddingLeft: space.md,
    paddingRight: space.md,
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    backgroundColor: colors.glass,
    borderColor: "rgb(255 255 255 / 10%)",
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
  // h-9 w-full render-glass border px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
  xsBorderedWide: {
    height: "2.25rem",
    width: "100%",
    borderWidth: "1px",
    paddingLeft: space.md,
    paddingRight: space.md,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    backgroundColor: colors.glass,
    borderColor: "rgb(255 255 255 / 10%)",
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
});
