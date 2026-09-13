import * as stylex from "@stylexjs/stylex";
import { colors, text, space } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // pointer-events-auto fixed bottom-0 right-0 top-14 z-[82] flex w-[420px] max-w-[92vw] flex-col border-l border-white/10 bg-[#0d0d0d] text-white shadow-2xl
  fixedFlexCol: {
    pointerEvents: "auto",
    position: "fixed",
    bottom: space.none,
    right: space.none,
    top: "3.5rem",
    zIndex: "82",
    display: "flex",
    width: "420px",
    maxWidth: "92vw",
    flexDirection: "column",
    borderLeftWidth: "1px",
    borderColor: "rgb(255 255 255 / 0.1)",
    backgroundColor: "rgb(13 13 13 / 1)",
    color: "rgb(255 255 255 / 1)",
    boxShadow: "0 25px 50px -12px rgb(0 0 0 / 0.25)",
  },
  // flex h-14 shrink-0 items-center border-b border-white/10 px-4
  flexCenterTight: {
    display: "flex",
    height: "3.5rem",
    flexShrink: "0",
    alignItems: "center",
    borderBottomWidth: "1px",
    borderColor: "rgb(255 255 255 / 0.1)",
    paddingLeft: space.xl,
    paddingRight: space.xl,
  },
  // text-[10px] font-bold uppercase tracking-[0.18em] text-[#E8E044]
  capsBold: {
    fontSize: "10px",
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaWider,
    color: colors.accent,
  },
  // text-xs text-white/50
  xs: {
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.textSubtle,
  },
  // ml-auto grid size-8 place-items-center text-white/60 hover:bg-white/10 hover:text-white
  gridCenteredPushRight: {
    marginLeft: "auto",
    display: "grid",
    width: "2rem",
    height: "2rem",
    placeItems: "center",
    color: {
      default: "rgb(255 255 255 / 0.6)",
      ":hover": "rgb(255 255 255 / 1)",
    },
    backgroundColor: {
      default: null,
      ":hover": colors.chip,
    },
  },
  // size-4
  size4: {
    width: "1rem",
    height: "1rem",
  },
  // min-h-0 flex-1 overflow-y-auto p-4
  fillScrollYShrinkable: {
    minHeight: "0px",
    flex: "1 1 0%",
    overflowY: "auto",
    padding: space.xl,
  },
  /*
   * The old `space-y-5`. `space-y` is a `> * + *` rule with no StyleX
   * form; every child here is a block-level section with no vertical margin of
   * its own, so a flex column with the same gap places them identically.
   */
  // text-xs
  xs2: {
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    display: "flex",
    flexDirection: "column",
    gap: "1.25rem",
  },
});
