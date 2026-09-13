import * as stylex from "@stylexjs/stylex";
import { colors, text, space, layers } from "../../stylex/tokens.stylex";

export const styles = stylex.create({
  // pointer-events-auto absolute inset-0 z-[80] grid place-items-center bg-black/65 p-6 backdrop-blur-sm
  absGridCentered: {
    pointerEvents: "auto",
    position: "absolute",
    inset: space.none,
    zIndex: layers.editorOverlay,
    display: "grid",
    placeItems: "center",
    backgroundColor: "rgb(0 0 0 / 0.65)",
    padding: space.xxl,
    backdropFilter: "blur(4px)",
  },
  // w-full max-w-xl rounded-2xl border border-white/15 bg-[#111317] p-6 shadow-2xl
  borderedWidePad6: {
    width: "100%",
    maxWidth: "36rem",
    borderRadius: "0",
    borderWidth: "1px",
    borderColor: "rgb(255 255 255 / 0.15)",
    backgroundColor: "rgb(17 19 23 / 1)",
    padding: space.xxl,
    boxShadow: "0 25px 50px -12px rgb(0 0 0 / 0.25)",
  },
  // text-xl font-semibold text-white
  xlWhiteSemibold: {
    fontSize: text.sizeXl,
    lineHeight: "1.75rem",
    fontWeight: text.weightSemibold,
    color: "rgb(255 255 255 / 1)",
  },
  // mt-2 text-sm text-white/55
  sm: {
    marginTop: space.md,
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    color: "rgb(255 255 255 / 0.55)",
  },
  // mt-5 grid gap-3 sm:grid-cols-2
  gridGap3: {
    marginTop: "1.25rem",
    display: "grid",
    gap: space.lg,
    gridTemplateColumns: {
      default: null,
      "@media (min-width: 640px)": "repeat(2, minmax(0, 1fr))",
    },
  },
  // rounded-xl border border-[#E8E044]/50 bg-[#E8E044]/8 p-4 text-left hover:bg-[#E8E044]/12
  borderedPad4LeftText: {
    borderRadius: "0",
    borderWidth: "1px",
    borderColor: "rgb(232 224 68 / 0.5)",
    backgroundColor: {
      default: "rgb(232 224 68 / 0.08)",
      ":hover": "rgb(232 224 68 / 0.12)",
    },
    padding: space.xl,
    textAlign: "left",
  },
  // size-6 text-[#E8E044]
  size6Text: {
    width: "1.5rem",
    height: "1.5rem",
    color: colors.accent,
  },
  // mt-3 block text-sm text-white
  blockSmWhite: {
    marginTop: space.lg,
    display: "block",
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    color: "rgb(255 255 255 / 1)",
  },
  // mt-1 block text-xs leading-5 text-white/55
  blockXs: {
    marginTop: space.xs,
    display: "block",
    fontSize: text.sizeXs,
    lineHeight: "1.25rem",
    color: "rgb(255 255 255 / 0.55)",
  },
  // rounded-xl border border-white/15 bg-white/[0.03] p-4 text-left hover:bg-white/[0.06]
  borderedPad4LeftText2: {
    borderRadius: "0",
    borderWidth: "1px",
    borderColor: "rgb(255 255 255 / 0.15)",
    backgroundColor: {
      default: "rgb(255 255 255 / 0.03)",
      ":hover": "rgb(255 255 255 / 0.06)",
    },
    padding: space.xl,
    textAlign: "left",
  },
  // size-6 text-white/70
  size6TextWhite70: {
    width: "1.5rem",
    height: "1.5rem",
    color: "rgb(255 255 255 / 0.7)",
  },
});
