import * as stylex from "@stylexjs/stylex";
import { colors, text, space } from "../../../stylex/tokens.stylex";

/**
 * `space-y-*` has no StyleX form: it is a `> * + *` sibling rule and StyleX
 * addresses only the element it is applied to. Two shapes replace it here.
 *
 * A column whose children are all block-level and carry no vertical margin of
 * their own becomes `flex`/`column`/`gap` — same boxes, same order, same
 * distance, and nothing to blockify. Where a child is inline-level (the asset
 * gallery link) that swap would stretch it across the panel, so those stacks
 * keep block layout and the margin moves onto the child that used to receive
 * it from the parent — which is what `space-y` was doing anyway.
 */
export const styles = stylex.create({
  // inline-flex text-micro font-medium text-primary underline-offset-4 hover:underline
  inlineFlexMicroAccent: {
    display: "inline-flex",
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    fontWeight: text.weightMedium,
    color: colors.primary,
    textUnderlineOffset: "4px",
    textDecorationLine: {
      default: null,
      ":hover": "underline",
    },
  },
  // h-8 text-xs
  xs: {
    height: "2rem",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
  },
  // text-micro leading-relaxed text-muted-foreground
  microMutedRelaxed: {
    fontSize: text.sizeMicro,
    lineHeight: "1.625",
    color: colors.mutedForeground,
  },
  // text-muted-foreground
  muted: {
    color: colors.mutedForeground,
  },
  // mt-1 flex flex-wrap gap-1
  flexWrapGap1: {
    marginTop: space.xs,
    display: "flex",
    flexWrap: "wrap",
    gap: space.xs,
  },
  // flex items-center justify-between gap-3 border border-border px-2 py-2 text-foreground
  flexCenterBetween: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.lg,
    borderWidth: "1px",
    borderColor: colors.border,
    paddingLeft: space.md,
    paddingRight: space.md,
    paddingTop: space.md,
    paddingBottom: space.md,
    color: colors.text,
  },
  // block font-medium
  blockMedium: {
    display: "block",
    fontWeight: text.weightMedium,
  },
  // block text-micro text-muted-foreground
  blockMicroMuted: {
    display: "block",
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    color: colors.mutedForeground,
  },
  // grid grid-cols-3 gap-2
  gridCols3Gap2: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: space.md,
  },
  // (was the parent's space-y-3)
  stackLg: {
    display: "flex",
    flexDirection: "column",
    gap: space.lg,
  },
  // (was the parent's space-y-2, on a stack that keeps block layout)
  stackedMd: {
    marginTop: space.md,
  },
  // (was the parent's space-y-1.5, on a stack that keeps block layout)
  stackedSm: {
    marginTop: space.sm,
  },
  /*
   * The paint swatch. `focus-visible:ring-2 focus-visible:ring-ring
   * focus-visible:ring-offset-1 focus-visible:ring-offset-card` is Tailwind's
   * two-shadow ring: the offset ring in the card colour first, then the ring
   * itself at offset + width. The selected state's `ring-1 ring-primary` has
   * no offset class, so its offset ring is zero-width and only the 1px primary
   * ring paints, and a focused selected swatch shows the focus ring instead —
   * `:focus-visible` outranked the unconditional utility.
   *
   * The shadow therefore lives in the two state styles rather than the base:
   * `stylex.props()` resolves a property to one argument, so a selected style
   * declaring only the default shadow would drop the base style's
   * `:focus-visible` shadow with it and a selected swatch would lose its focus
   * ring.
   */
  // motionStyles.editorMotion + size-6 border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card
  swatch: {
    width: "1.5rem",
    height: "1.5rem",
    borderWidth: "1px",
    outline: {
      default: null,
      ":focus-visible": "2px solid transparent",
    },
    outlineOffset: {
      default: null,
      ":focus-visible": "2px",
    },
  },
  // border-primary ring-1 ring-primary
  swatchActive: {
    borderColor: colors.primary,
    boxShadow: {
      default: "0 0 0 1px hsl(var(--primary))",
      ":focus-visible": "0 0 0 1px hsl(var(--card)), 0 0 0 3px hsl(var(--ring))",
    },
  },
  // border-border
  swatchIdle: {
    borderColor: colors.border,
    boxShadow: {
      default: null,
      ":focus-visible": "0 0 0 1px hsl(var(--card)), 0 0 0 3px hsl(var(--ring))",
    },
  },
});
