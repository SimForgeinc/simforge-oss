import * as stylex from "@stylexjs/stylex";
import { colors, text, space } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // grid gap-5
  gridGap5: {
    display: "grid",
    gap: "1.25rem",
  },
  // mb-2
  mb2: {
    marginBottom: space.md,
  },
  // text-micro font-semibold uppercase tracking-meta text-foreground/80
  capsMicroSemibold: {
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    fontWeight: text.weightSemibold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: "hsl(var(--foreground) / 0.8)",
  },
  // mt-0.5 text-xs text-muted-foreground
  xsMuted: {
    marginTop: space.xxs,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.mutedForeground,
  },
  // flex max-w-xs flex-col gap-1 text-xs
  flexColXs: {
    display: "flex",
    maxWidth: space.inspectorWidthXl,
    flexDirection: "column",
    gap: space.xs,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
  },
  // text-micro uppercase tracking-meta text-muted-foreground
  capsMicroMuted: {
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: colors.mutedForeground,
  },
  // render-glass border px-2 py-1.5 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
  inkBordered: {
    borderWidth: "1px",
    paddingLeft: space.md,
    paddingRight: space.md,
    paddingTop: space.sm,
    paddingBottom: space.sm,
    color: colors.text,
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
  // grid gap-2 text-xs sm:grid-cols-2
  gridXsGap2: {
    display: "grid",
    gap: space.md,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    gridTemplateColumns: {
      default: null,
      "@media (min-width: 640px)": "repeat(2, minmax(0, 1fr))",
    },
  },
  // flex flex-col gap-1
  flexColGap1: {
    display: "flex",
    flexDirection: "column",
    gap: space.xs,
  },
  // render-glass border px-2 py-1.5 capitalize text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
  capsInkBordered: {
    borderWidth: "1px",
    paddingLeft: space.md,
    paddingRight: space.md,
    paddingTop: space.sm,
    paddingBottom: space.sm,
    textTransform: "capitalize",
    color: colors.text,
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
  // capitalize
  caps: {
    textTransform: "capitalize",
  },
});
