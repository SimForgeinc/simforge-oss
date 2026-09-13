import * as stylex from "@stylexjs/stylex";

export const styles = stylex.create({
  // pointer-events-none inline-flex size-3.5 shrink-0 items-center justify-center
  inlineFlexCenterMid: {
    pointerEvents: "none",
    display: "inline-flex",
    width: "0.875rem",
    height: "0.875rem",
    flexShrink: "0",
    alignItems: "center",
    justifyContent: "center",
  },
  // size-3.5
  size35: {
    width: "0.875rem",
    height: "0.875rem",
  },
  // size-1.5 rounded-full ring-1 ring-black/40 — the radius resolves to 0 under
  // the universal sharp-corner reset in styles.css; only spinners are exempt.
  round: {
    width: "0.375rem",
    height: "0.375rem",
    borderRadius: "0",
    boxShadow: "0 0 0 1px rgb(0 0 0 / 0.4)",
  },

  // bg-amber-300
  dotGeneratedPack: {
    backgroundColor: "rgb(252 211 77 / 1)",
  },
  // bg-slate-400
  dotBrowserOnly: {
    backgroundColor: "rgb(148 163 184 / 1)",
  },
});
