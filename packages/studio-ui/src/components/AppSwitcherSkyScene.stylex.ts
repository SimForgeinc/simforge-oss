import * as stylex from "@stylexjs/stylex";

export const styles = stylex.create({
  // pointer-events-none absolute inset-0 size-full
  canvas: {
    pointerEvents: "none",
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
  },
});
