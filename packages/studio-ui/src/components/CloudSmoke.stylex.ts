import * as stylex from "@stylexjs/stylex";

export const styles = stylex.create({
  // pointer-events-none absolute inset-0 size-full
  layer: {
    pointerEvents: "none",
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    objectFit: "cover",
  },
  hidden: { opacity: 0 },
});
