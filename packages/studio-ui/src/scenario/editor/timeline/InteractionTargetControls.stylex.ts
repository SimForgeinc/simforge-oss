import * as stylex from "@stylexjs/stylex";
import { colors, text, space } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // grid grid-cols-2 gap-2
  gridCols2Gap2: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: space.md,
  },
  // h-8 text-xs
  xs: {
    height: "2rem",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
  },
  // col-span-2
  colSpan2: {
    gridColumn: "span 2 / span 2",
  },
  // text-micro text-white/45
  micro: {
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    color: "rgb(255 255 255 / 0.45)",
  },
  // border border-white/10 p-2
  borderedPad2: {
    borderWidth: "1px",
    borderColor: "rgb(255 255 255 / 0.1)",
    padding: space.md,
  },
  // mt-2 text-micro text-red-300
  micro2: {
    marginTop: space.md,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    color: "rgb(252 165 165 / 1)",
  },
  // text-micro text-[#E8E044]
  micro3: {
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    color: colors.accent,
  },
  // grid grid-cols-2 gap-2 border border-white/10 p-2
  gridBorderedCols2: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: space.md,
    borderWidth: "1px",
    borderColor: "rgb(255 255 255 / 0.1)",
    padding: space.md,
  },
  // col-span-2 text-left text-micro text-red-300
  microLeftText: {
    gridColumn: "span 2 / span 2",
    textAlign: "left",
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    color: "rgb(252 165 165 / 1)",
  },
  // grid grid-cols-3 gap-2 border border-white/10 p-2
  gridBorderedCols3: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: space.md,
    borderWidth: "1px",
    borderColor: "rgb(255 255 255 / 0.1)",
    padding: space.md,
  },
  // col-span-3 text-micro text-white/35
  micro4: {
    gridColumn: "span 3 / span 3",
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    color: colors.textFaint,
  },
  // col-span-3 text-left text-micro text-red-300
  microLeftText2: {
    gridColumn: "span 3 / span 3",
    textAlign: "left",
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    color: "rgb(252 165 165 / 1)",
  },
  // block text-micro text-white/45
  blockMicro: {
    display: "block",
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    color: "rgb(255 255 255 / 0.45)",
  },
  // mt-1 h-8 border-white/15 bg-white/5 text-xs text-white
  xsWhite: {
    marginTop: space.xs,
    height: "2rem",
    borderColor: "rgb(255 255 255 / 0.15)",
    backgroundColor: "rgb(255 255 255 / 0.05)",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: "rgb(255 255 255 / 1)",
  },
  // block text-micro text-white/35
  blockMicro2: {
    display: "block",
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    color: colors.textFaint,
  },
  // mt-1 h-8 border-white/10 bg-white/[0.02] text-xs text-white/50
  xs2: {
    marginTop: space.xs,
    height: "2rem",
    borderColor: "rgb(255 255 255 / 0.1)",
    backgroundColor: "rgb(255 255 255 / 0.02)",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.textSubtle,
  },
  // text-micro text-white/40
  micro5: {
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    color: "rgb(255 255 255 / 0.4)",
  },
  // text-white/65
  textWhite65: {
    color: "rgb(255 255 255 / 0.65)",
  },
  /*
   * `space-y-2` was a `> * + *` rule, which StyleX cannot express from the
   * parent. Two shapes replace it.
   *
   * The three target stacks become `stackMd` — a flex column with the same 8px
   * gap. Every child is already a block-level box with no vertical margin, so
   * the boxes and the distances are unchanged.
   *
   * The three point lists stay `<fieldset>`s in block layout: a rendered
   * legend is not a flex item, so a gap would drop the space under it that the
   * margin rule did apply. There `stackedMd` carries the margin from the child
   * and `:first-child` cancels it on the legend — exactly what
   * `> :not([hidden]) ~ :not([hidden])` selected.
   */
  stackMd: {
    display: "flex",
    flexDirection: "column",
    gap: space.md,
  },
  stackedMd: {
    marginTop: {
      default: space.md,
      ":first-child": space.none,
    },
  },
});
