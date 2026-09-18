import type { ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { HeroBackdrop } from "./HeroBackdrop";
import { flow } from "./onboarding.stylex";

/**
 * The one shell of the hero flow: the backdrop and the single centred column
 * that welcome, sign-in, map setup, native render and the map library all
 * render into.
 *
 * It exists so those surfaces cannot drift apart. The flow is the first thing
 * anyone sees of Studio and it is one continuous scene — pressing "Continue
 * locally", finishing a download, or opening the map library from the app
 * switcher swaps the copy and the controls in this column over the same
 * backdrop, rather than landing on a page with a backdrop and a measure of
 * its own.
 */
export function HeroFlowShell({
  children,
  /**
   * `main` for the onboarding route, which has no chrome around it and needs
   * the landmark; `section` for the map library, which renders inside the
   * dashboard's own `main`.
   */
  as: Element = "main",
  /**
   * Take the height of the container instead of the viewport: what a surface
   * inside the dashboard's main area (already the viewport minus the top bar)
   * must do, or the page would scroll by exactly the height of that bar.
   */
  fill = false,
}: {
  children: ReactNode;
  as?: "main" | "section";
  fill?: boolean;
}) {
  return (
    <Element {...stylex.props(flow.shell, fill ? flow.shellFill : flow.shellViewport)}>
      <HeroBackdrop />
      <div {...stylex.props(flow.column)}>{children}</div>
    </Element>
  );
}
