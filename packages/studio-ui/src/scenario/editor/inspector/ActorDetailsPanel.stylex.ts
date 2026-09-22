import * as stylex from "@stylexjs/stylex";
import { colors, motion, shadows, space, stroke, text } from "../../../stylex/tokens.stylex";

/**
 * Opacity the hovered driver-profile button publishes for its artwork.
 *
 * A StyleX rule only ever selects the element it is applied to, so the artwork
 * cannot read the button's `:hover` itself — and a Tailwind `group-hover:*`
 * beside it would lose to the compiled `opacity` rule, which carries StyleX's
 * `:not(#\#)` specificity guards. The button publishes the value instead; the
 * artwork's own transition still animates it.
 */
export const profileArtVars = stylex.defineVars({ opacity: "0.55" });

export const styles = stylex.create({
  // border-t border-white/[0.07] bg-black/15 px-3 py-2
  ruleT: {
    minWidth: 0,
    borderTopWidth: stroke.hairline,
    borderColor: colors.hairline,
    backgroundColor: "rgb(0 0 0 / 0.15)",
    paddingLeft: space.s3,
    paddingRight: space.s3,
    paddingTop: space.s2,
    paddingBottom: space.s2,
  },
  // flex items-center justify-between gap-1
  flexCenterBetween: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.s1,
  },
  // grid h-14 w-full place-items-center
  gridCenteredWide: {
    display: "grid",
    height: "3.5rem",
    width: "100%",
    placeItems: "center",
  },
  // flex items-center gap-2 rounded-xl border border-[#E8E044]/45 bg-[#E8E044]/[0.08] px-2.5 py-2
  flexCenterBordered: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    borderWidth: stroke.hairline,
    borderColor: colors.accentLineSubtle,
    backgroundColor: colors.accentWash,
    paddingLeft: space.s2_5,
    paddingRight: space.s2_5,
    paddingTop: space.s2,
    paddingBottom: space.s2,
  },
  // grid size-7 shrink-0 place-items-center rounded-lg border border-[#E8E044]/25 bg-[#E8E044]/10 text-[#E8E044]
  gridCenteredTight: {
    display: "grid",
    width: "1.75rem",
    height: "1.75rem",
    flexShrink: "0",
    placeItems: "center",
    borderWidth: stroke.hairline,
    borderColor: colors.accentLineSubtle,
    backgroundColor: colors.accentWash,
    color: colors.accent,
  },
  // size-4
  size4: {
    width: "1rem",
    height: "1rem",
  },
  // min-w-0
  narrowable: {
    minWidth: "0px",
  },
  // block text-[10px] font-semibold text-white
  blockWhiteSemibold: {
    display: "block",
    fontSize: text.sizeMicro,
    fontWeight: text.weightSemibold,
    color: colors.ink,
  },
  // block text-[8px] leading-3 text-white/40
  block: {
    display: "block",
    fontSize: text.sizeNano,
    lineHeight: "0.75rem",
    color: colors.inkMuted,
  },
  // block
  block2: {
    display: "block",
  },
  // text-[9px] uppercase tracking-[0.12em] text-white/40
  caps: {
    color: colors.inkMuted,
  },
  // mt-1 h-8 border-white/10 bg-white/[0.04] text-xs text-white
  xsWhite: {
    marginTop: space.s1,
  },
  // text-[9px] leading-3 text-white/35
  textLeading3TextWhite35: {
    fontSize: text.sizeTag,
    lineHeight: "0.75rem",
    color: colors.inkFaint,
  },
  // relative mt-1
  rel: {
    position: "relative",
    marginTop: space.s1,
  },
  // h-8 border-white/10 bg-white/[0.04] pr-8 text-xs text-white
  xsWhite2: {
    paddingRight: space.s8,
  },
  // pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-white/35
  absInert: {
    pointerEvents: "none",
    position: "absolute",
    right: space.s2,
    top: "50%",
    transform: "translate(0, -50%)",
    fontSize: text.sizeMicro,
    color: colors.inkFaint,
  },
  // flex items-baseline justify-between gap-2
  flexBetweenBaseline: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: space.s2,
  },
  // font-mono text-[10px] tabular-nums text-[#E8E044]
  monoNums: {
    fontFamily: text.fontMono,
    fontSize: text.sizeMicro,
    fontVariantNumeric: "tabular-nums",
    color: colors.accent,
  },
  // text-[8px] text-white/35
  textTextWhite35: {
    fontSize: text.sizeNano,
    color: colors.inkFaint,
  },
  // mt-2 flex items-center gap-2
  flexCenterGap2: {
    marginTop: space.s2,
    display: "flex",
    alignItems: "center",
    gap: space.s2,
  },
  // text-[8px] tabular-nums text-white/30
  nums: {
    fontSize: text.sizeNano,
    fontVariantNumeric: "tabular-nums",
    color: colors.inkFaint,
  },
  // h-1.5 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-white/10 accent-[#E8E044] [&::-moz-range-progress]:h-1.5 [&::-moz-range-progress]:rounded-full [&::-moz-range-progress]:bg-[#E8E044] [&::-moz-range-thumb]:size-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-neutral-950 [&::-moz-range-thumb]:bg-[#E8E044] [&::-webkit-slider-thumb]:mt-[-4px] [&::-webkit-slider-thumb]:size-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-neutral-950 [&::-webkit-slider-thumb]:bg-[#E8E044] [&::-webkit-slider-runnable-track]:h-1.5 [&::-webkit-slider-runnable-track]:rounded-full
  fillRoundNarrowable: {
    height: "0.375rem",
    minWidth: "0px",
    flex: "1 1 0%",
    cursor: "pointer",
    WebkitAppearance: "none",
    MozAppearance: "none",
    appearance: "none",
    backgroundColor: colors.fillStrong,
    accentColor: colors.accent,
    "::-moz-range-progress": {
      height: "0.375rem",
      borderRadius: "0",
      backgroundColor: colors.accent,
    },
    "::-moz-range-thumb": {
      width: "0.875rem",
      height: "0.875rem",
      borderRadius: "0",
      borderWidth: stroke.thick,
      borderColor: "rgb(10 10 10 / 1)",
      backgroundColor: colors.accent,
    },
    "::-webkit-slider-runnable-track": {
      height: "0.375rem",
      borderRadius: "0",
    },
    "::-webkit-slider-thumb": {
      marginTop: "-4px",
      width: "0.875rem",
      height: "0.875rem",
      WebkitAppearance: "none",
      appearance: "none",
      borderRadius: "0",
      borderWidth: stroke.thick,
      borderColor: "rgb(10 10 10 / 1)",
      backgroundColor: colors.accent,
    },
  },
  // mt-1.5 grid grid-cols-1 gap-1.5
  gridCols1Gap15: {
    marginTop: space.s1_5,
    display: "grid",
    gridTemplateColumns: "repeat(1, minmax(0, 1fr))",
    gap: space.s1_5,
  },
  // truncate text-[9px] font-medium
  mediumTruncate: {
    fontSize: text.sizeTag,
    fontWeight: text.weightMedium,
  },
  // mt-1.5 block text-[9px] leading-3.5 text-white/35
  block3: {
    marginTop: space.s1_5,
    display: "block",
    fontSize: text.sizeTag,
    lineHeight: text.lineMicro,
    color: colors.inkFaint,
  },
  // h-14 w-14
  h14W14: {
    height: "3.5rem",
    width: "3.5rem",
  },
  // size-10
  size10: {
    width: "2.5rem",
    height: "2.5rem",
  },
  /*
   * The CARLA block's old `space-y-1`. `space-y` is a `> * + *` rule with no
   * StyleX form, and these two stacks lead with an inline-level box — the
   * section caption, the compatibility pill — so they keep block layout and
   * the 4px margin sits on the child that used to be handed it.
   */
  stackedXs: {
    marginTop: space.s1,
  },

  // size-[18px] shrink-0 rounded-full border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044]
  paintSwatch: {
    width: "18px",
    height: "18px",
    flexShrink: 0,
    borderWidth: stroke.hairline,
  },
  // border-[#E8E044] ring-1 ring-[#E8E044]
  paintSwatchActive: {
    borderColor: colors.accent,
    boxShadow: {
      default: "0 0 0 1px rgb(232 224 68 / 1)",
      ":focus-visible": shadows.ring,
    },
  },
  // border-white/20
  paintSwatchIdle: {
    borderColor: colors.hairlineStrong,
  },
  // flex min-w-0 items-center gap-1.5 rounded-lg border px-1.5 py-1 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044]
  // The `group` marker is gone with the artwork's `group-hover:opacity-90`:
  // the idle variant below publishes `profileArtVars.opacity` instead.
  profileOption: {
    display: "flex",
    minWidth: "0px",
    alignItems: "center",
    gap: space.s1_5,
    borderWidth: stroke.hairline,
    paddingLeft: space.s1_5,
    paddingRight: space.s1_5,
    paddingTop: space.s1,
    paddingBottom: space.s1,
    textAlign: "left",
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, filter, backdrop-filter",
    transitionTimingFunction: motion.easeStandard,
    transitionDuration: motion.durStandard,
  },
  // border-[#E8E044]/70 bg-[#E8E044]/10 text-[#E8E044]
  profileOptionActive: {
    borderColor: colors.accentLine,
    backgroundColor: colors.accentWash,
    color: colors.accent,
  },
  // border-white/10 bg-white/[0.025] text-white/55 hover:border-white/25 hover:bg-white/[0.06] hover:text-white/85
  // Publishes the artwork's `group-hover:opacity-90` for `profileArtIdle`; the
  // active option never dimmed its artwork, so it publishes nothing.
  profileOptionIdle: {
    borderColor: {
      default: colors.fillStrong,
      ":hover": colors.hairlineStrong,
    },
    backgroundColor: {
      default: colors.fillFaint,
      ":hover": colors.fill,
    },
    color: {
      default: colors.inkMuted,
      ":hover": colors.ink,
    },
    [profileArtVars.opacity]: "0.55",
    ":hover": {
      [profileArtVars.opacity]: "0.9",
    },
  },
  // size-8 shrink-0 object-contain transition
  profileArt: {
    width: space.s8,
    height: space.s8,
    flexShrink: 0,
    objectFit: "contain",
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, filter, backdrop-filter",
    transitionTimingFunction: motion.easeStandard,
    transitionDuration: motion.durStandard,
  },
  // opacity-100
  profileArtActive: {
    opacity: 1,
  },
  // opacity-55 group-hover:opacity-90 — both read from the ancestor's variable.
  profileArtIdle: {
    opacity: profileArtVars.opacity,
  },
  // h-20 px-8 py-2.5 — this panel's preview frame.
  preview: {
    height: "5rem",
    paddingLeft: space.s8,
    paddingRight: space.s8,
    paddingTop: space.s2_5,
    paddingBottom: space.s2_5,
  },
});
