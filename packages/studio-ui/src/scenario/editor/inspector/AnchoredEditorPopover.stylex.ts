import * as stylex from "@stylexjs/stylex";
import { colors, motion, space, stroke, text } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // flex min-h-[52px] shrink-0 items-center gap-3 overflow-hidden rounded-t-[10px] border-b border-white/10 bg-[linear-gradient(180deg,#171717_0%,#111111_100%)] px-3 py-2
  flexCenterTight: {
    display: "flex",
    minHeight: "52px",
    flexShrink: "0",
    alignItems: "center",
    gap: space.s3,
    overflow: "hidden",
    borderTopLeftRadius: "10px",
    borderTopRightRadius: "10px",
    borderBottomWidth: stroke.hairline,
    borderColor: "rgb(255 255 255 / 0.1)",
    backgroundImage: "linear-gradient(180deg, #171717 0%, #111111 100%)",
    paddingLeft: space.s3,
    paddingRight: space.s3,
    paddingTop: space.s2,
    paddingBottom: space.s2,
  },
  // min-w-0 flex-1
  fillNarrowable: {
    minWidth: "0px",
    flex: "1 1 0%",
  },
  // text-[10px] font-bold uppercase leading-none tracking-[0.18em] text-[#E8E044]
  capsBoldLeadNone: {
    fontSize: "10px",
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    lineHeight: "1",
    letterSpacing: text.trackingMetaWider,
    color: colors.accent,
  },
  // mt-1 truncate text-sm font-semibold leading-none text-white
  smWhiteSemibold: {
    marginTop: space.s1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: text.sizeSm,
    lineHeight: "1",
    fontWeight: text.weightSemibold,
    color: colors.ink,
  },
  // flex size-6 shrink-0 items-center justify-center rounded text-white/50 transition-colors hover:bg-white/10 hover:text-white
  flexCenterMid: {
    display: "flex",
    width: "1.5rem",
    height: "1.5rem",
    flexShrink: "0",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "0",
    color: {
      default: colors.textSubtle,
      ":hover": colors.ink,
    },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: motion.easeStandard,
    transitionDuration: motion.durStandard,
    backgroundColor: {
      default: null,
      ":hover": colors.fillStrong,
    },
  },
  // size-3.5
  size35: {
    width: "0.875rem",
    height: "0.875rem",
  },
  // min-h-0 flex-1 overflow-y-auto rounded-b-[11px] bg-[#0d0d0d] p-4 [scrollbar-width:thin]
  fillScrollYShrinkable: {
    minHeight: "0px",
    flex: "1 1 0%",
    overflowY: "auto",
    borderBottomRightRadius: "11px",
    borderBottomLeftRadius: "11px",
    backgroundColor: "rgb(13 13 13 / 1)",
    padding: space.s4,
    scrollbarWidth: "thin",
  },

  // pointer-events-auto fixed z-[81] flex max-h-[560px] flex-col overflow-visible rounded-xl border border-[#E8E044]/80 bg-[linear-gradient(155deg,#111111_0%,#090909_58%,#0d0d0d_100%)] text-white shadow-[0_28px_90px_rgba(0,0,0,0.72),0_0_0_1px_rgba(232,224,68,0.12)]
  //
  // `81` is kept as a literal rather than folded into the `layers` scale: this
  // popover sits one step above `editorOverlay` (80) by design and the frozen
  // stacking order is what the migration preserves.
  popover: {
    pointerEvents: "auto",
    position: "fixed",
    zIndex: "81",
    display: "flex",
    maxHeight: "560px",
    flexDirection: "column",
    overflow: "visible",
    borderRadius: "0",
    borderWidth: stroke.hairline,
    borderColor: "rgb(232 224 68 / 0.8)",
    backgroundImage: "linear-gradient(155deg,#111111 0%,#090909 58%,#0d0d0d 100%)",
    color: colors.ink,
    boxShadow: "0 28px 90px rgba(0,0,0,0.72), 0 0 0 1px rgba(232,224,68,0.12)",
  },
  // pointer-events-none absolute z-20 size-5 rotate-45 bg-[#0d0d0d]
  pointer: {
    pointerEvents: "none",
    position: "absolute",
    zIndex: "20",
    width: "1.25rem",
    height: "1.25rem",
    transform: "rotate(45deg)",
    backgroundColor: "rgb(13 13 13 / 1)",
  },
  // hidden
  pointerHidden: {
    display: "none",
  },
});
