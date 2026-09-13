import * as stylex from "@stylexjs/stylex";
import { space, layers } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // pointer-events-none absolute inset-0 z-0 overflow-hidden rounded-[inherit]
  absClipInert: {
    pointerEvents: "none",
    position: "absolute",
    inset: space.none,
    zIndex: layers.base,
    overflow: "hidden",
    borderRadius: "inherit",
  },
  // absolute inset-0 bg-gradient-to-br from-white/[0.12] via-white/[0.025] to-sky-400/[0.1]
  absInset0: {
    position: "absolute",
    inset: space.none,
    backgroundImage: "linear-gradient(to bottom right, rgb(255 255 255 / 0.12), rgb(255 255 255 / 0.025), rgb(56 189 248 / 0.1))",
  },
  // absolute -left-16 -top-24 h-52 w-52 rounded-full bg-[#E8E044]/12 blur-3xl
  absRound: {
    position: "absolute",
    left: "-4rem",
    top: "-6rem",
    height: "13rem",
    width: "13rem",
    borderRadius: "0",
    filter: "blur(64px)",
  },
  // absolute -bottom-28 right-[-3rem] h-56 w-56 rounded-full bg-sky-400/15 blur-3xl
  absRound2: {
    position: "absolute",
    bottom: "-7rem",
    right: "-3rem",
    height: "14rem",
    width: "14rem",
    borderRadius: "0",
    backgroundColor: "rgb(56 189 248 / 0.15)",
    filter: "blur(64px)",
  },
  // absolute inset-x-5 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent
  abs: {
    position: "absolute",
    left: "1.25rem",
    right: "1.25rem",
    top: space.none,
    height: "1px",
    backgroundImage: "linear-gradient(to right, transparent, rgb(255 255 255 / 0.6), transparent)",
  },

  // The timeline card's glass chrome, flattened from the two class lists that
  // `cn` used to merge: SCENARIO_FLOATING_CARD_CLASSNAME
  // (`overflow-hidden border border-white/20 bg-black/20 shadow-[0_24px_80px_-24px_rgba(0,0,0,0.85)]
  //  ring-1 ring-inset ring-white/[0.06] backdrop-blur-[48px] backdrop-saturate-[1.65] backdrop-contrast-[1.05]`)
  // then `relative isolate overflow-hidden rounded-t-[24px] rounded-b-none border-white/25 bg-black/15
  //  ring-1 ring-inset ring-white/[0.08] shadow-[0_24px_80px_-24px_rgba(0,0,0,0.85)]
  //  backdrop-blur-[72px] backdrop-saturate-[1.85] backdrop-contrast-[1.05]`.
  // twMerge resolved every conflicting pair in favour of the second list, so
  // the border, background, ring and backdrop values below are the timeline's,
  // not the shared card's.
  surface: {
    position: "relative",
    isolation: "isolate",
    overflow: "hidden",
    borderRadius: "0",
    borderWidth: "1px",
    borderColor: "rgb(255 255 255 / 0.25)",
    backgroundColor: "rgb(0 0 0 / 0.15)",
    boxShadow: "inset 0 0 0 1px rgb(255 255 255 / 0.08), 0 24px 80px -24px rgba(0,0,0,0.85)",
    backdropFilter: "blur(72px) contrast(1.05) saturate(1.85)",
  },
  // bg-[#E8E044]/12 — the accent bloom, previously the one Tailwind holdout
  // beside its already-migrated sky-blue twin `absRound2`.
  absRoundAccent: {
    backgroundColor: "rgb(232 224 68 / 0.12)",
  },
});
