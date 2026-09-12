import * as stylex from "@stylexjs/stylex";

/**
 * The onboarding route shell. `#050607` is the onboarding canvas — the screens
 * in `@simforge-oss/studio-ui/onboarding` paint the same colour, and this layer
 * exists so the area outside a short screen matches rather than falling back to
 * the dashboard background.
 */
export const layout = stylex.create({
  shell: {
    minHeight: "100svh",
    backgroundColor: "#050607",
    color: "#ffffff",
  },
});
