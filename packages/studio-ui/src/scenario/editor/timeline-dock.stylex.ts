import * as stylex from "@stylexjs/stylex";

/**
 * Highlight published by a hovered or keyboard-focused resize handle for the
 * grab marker inside it.
 *
 * A StyleX rule compiles to an atomic class on the one element it is applied
 * to, so the marker cannot select its handle's `:hover` the way the original
 * `group-hover:*`/`group-focus-visible:*` utilities did. The handle therefore
 * publishes the highlight as a custom property and the marker reads it, which
 * keeps the transition on the marker — exactly where the Tailwind rule had it.
 *
 * Declaration order matches Tailwind's variant order: `:focus-visible` is
 * written last so a focused-and-hovered handle shows the solid accent, as it
 * did when `group-focus-visible:bg-[#E8E044]` followed `group-hover:` in the
 * generated sheet.
 */
export const handleState = stylex.defineVars({
  /** `bg-white/30` at rest; `group-hover:bg-[#E8E044]/80`, `group-focus-visible:bg-[#E8E044]`. */
  markerColor: "rgba(255,255,255,0.3)",
});

export const styles = stylex.create({
  dock: { position: "relative", minWidth: 0 },
  /**
   * group absolute inset-y-0 z-50 w-3 cursor-ew-resize touch-none
   *
   * `z-50` is kept as the literal the surface shipped with rather than mapped
   * onto a layer token: no token carries that value, and this tree is
   * appearance-frozen.
   */
  handle: {
    position: "absolute",
    top: 0,
    bottom: 0,
    zIndex: 50,
    width: "0.75rem",
    cursor: "ew-resize",
    touchAction: "none",
    [handleState.markerColor]: {
      default: "rgba(255,255,255,0.3)",
      ":hover": "rgba(232,224,68,0.8)",
      ":focus-visible": "#E8E044",
    },
  },
  left: { left: "-0.375rem" },
  right: { right: "-0.375rem" },
  /**
   * pointer-events-none absolute inset-y-5 left-1/2 w-px -translate-x-1/2
   * rounded-full bg-white/30 shadow-[0_0_10px_rgba(255,255,255,0.12)]
   * transition-colors
   */
  marker: {
    pointerEvents: "none",
    position: "absolute",
    top: "1.25rem",
    bottom: "1.25rem",
    left: "50%",
    width: "1px",
    transform: "translateX(-50%)",
    borderRadius: "9999px",
    backgroundColor: handleState.markerColor,
    boxShadow: "0 0 10px rgba(255,255,255,0.12)",
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
  },
});
