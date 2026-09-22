import * as stylex from "@stylexjs/stylex";
import { colors, layers, space, stroke, text } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // absolute top-1/2 z-10 flex size-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-red-300 bg-red-950 text-red-200 shadow-[0_0_8px_rgba(248,113,113,0.7)]
  absFlexCenter: {
    position: "absolute",
    top: "50%",
    zIndex: layers.raised,
    display: "flex",
    width: "1rem",
    height: "1rem",
    transform: "translate(-50%, -50%)",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: stroke.hairline,
    borderColor: colors.critical,
    backgroundColor: "rgb(69 10 10 / 1)",
    color: colors.critical,
    boxShadow: "0 0 8px rgba(248, 113, 113, 0.7)",
  },
  // size-2.5
  size25: {
    width: "0.625rem",
    height: "0.625rem",
  },
  // relative mb-1 h-5 select-none border-b border-white/10 bg-black/20
  relRuleB: {
    position: "relative",
    marginBottom: space.s1,
    height: "1.25rem",
    WebkitUserSelect: "none",
    MozUserSelect: "none",
    userSelect: "none",
    borderBottomWidth: stroke.hairline,
    borderColor: colors.hairline,
    backgroundColor: colors.scrimLight,
  },

  // absolute inset-y-0 w-px
  tick: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: "1px",
  },
  // bg-[#E8E044]/60
  tickOrigin: {
    backgroundColor: "rgb(232 224 68 / 0.6)",
  },
  // bg-white/10
  tickMinor: {
    backgroundColor: colors.fillStrong,
  },
  // absolute top-1/2 -translate-y-1/2 font-mono text-[0.5625rem] leading-none
  tickLabel: {
    position: "absolute",
    top: "50%",
    transform: "translate(0, -50%)",
    fontFamily: text.fontMono,
    fontSize: text.sizeTag,
    lineHeight: "1",
  },
  // text-white
  tickLabelOrigin: {
    color: colors.ink,
  },
  // text-white/35
  tickLabelMinor: {
    color: colors.inkFaint,
  },
  // left-0.5
  tickLabelStart: {
    left: "0.125rem",
  },
  // right-0.5
  tickLabelEnd: {
    right: "0.125rem",
  },
  // left-1/2 -translate-x-1/2 — composed with the base `-translate-y-1/2`,
  // exactly as Tailwind's two translate custom properties did.
  tickLabelCentered: {
    left: "50%",
    transform: "translate(-50%, -50%)",
  },
});
