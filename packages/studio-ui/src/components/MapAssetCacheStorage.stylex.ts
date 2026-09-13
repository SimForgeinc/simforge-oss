/**
 * StyleX for the map-cache storage block.
 *
 * The `control*` keys are the four `Button` overrides this surface passes
 * down. They travel as `xstyle`, not as a `className`: `Button` compiles its
 * own height, colour and font size with StyleX, and an atomic rule outranks a
 * plain Tailwind utility no matter which order they are concatenated in.
 *
 * `rounded-full` is dropped rather than translated — the global reset in
 * `styles.css` pins every element to `border-radius: 0`, and the app's
 * Tailwind config resolves the whole radius scale to `0` as well, so the
 * utility never painted anything here.
 */
import * as stylex from "@stylexjs/stylex";

export const styles = stylex.create({
  root: { borderTopWidth: 1, borderBottomWidth: 1, borderColor: "rgb(255 255 255 / 10%)", paddingBlock: "1rem", color: "white" },

  /**
   * `h-8 rounded-full border-white/15 bg-transparent px-3 text-[11px]
   * text-white/75 hover:bg-white/5 hover:text-white` — the two outline
   * controls that change or clear the cache location.
   */
  control: {
    height: "2rem",
    borderColor: "rgb(255 255 255 / 0.15)",
    backgroundColor: { default: "transparent", ":hover": "rgb(255 255 255 / 0.05)" },
    paddingInline: "0.75rem",
    fontSize: "11px",
    color: { default: "rgb(255 255 255 / 0.75)", ":hover": "rgb(255 255 255 / 1)" },
  },

  /**
   * `h-8 rounded-full bg-[#E8E044] px-3 text-[11px] text-black
   * hover:bg-[#f1ea55]` — the destructive confirmation.
   */
  controlConfirm: {
    height: "2rem",
    backgroundColor: { default: "#E8E044", ":hover": "#f1ea55" },
    paddingInline: "0.75rem",
    fontSize: "11px",
    color: "black",
  },

  /**
   * `h-8 rounded-full px-3 text-[11px] text-white/60 hover:bg-transparent
   * hover:text-white` — the quiet way out of the confirmation.
   */
  controlDismiss: {
    height: "2rem",
    backgroundColor: { default: null, ":hover": "transparent" },
    paddingInline: "0.75rem",
    fontSize: "11px",
    color: { default: "rgb(255 255 255 / 0.6)", ":hover": "rgb(255 255 255 / 1)" },
  },
});
