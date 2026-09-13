import * as stylex from "@stylexjs/stylex";
import { space } from "../../../stylex/tokens.stylex";

/**
 * The editor shell's geometry, migrated verbatim from
 * `ScenarioEditorShell.module.css`.
 *
 * The CSS Module expressed pass-through mode with descendant selectors —
 * `.shell[data-canvas-mode="passthrough"] .viewport { … }` — because the class
 * names were all it had to reach the inner regions with. The component already
 * knows `canvasMode` and whether a header was supplied, so those selectors
 * become ordinary conditional composition here and the `data-canvas-mode` /
 * `data-has-header` attributes stay exactly as they were for consumers and
 * tests that read them.
 *
 * The one rule that did not survive as a selector is `.canvas > *`
 * (`width: 100%; height: 100%`), which sized whatever a caller put inside the
 * canvas slot. StyleX styles only the element they are applied to, so that
 * sizing now lives on the canvas region's own root in
 * `EditorCanvasRegion.stylex.ts`, next to the rest of its geometry.
 */
export const styles = stylex.create({
  shell: {
    containerType: "inline-size",
    isolation: "isolate",
    display: "grid",
    gridTemplateRows: "var(--scenario-header-height) minmax(0, 1fr)",
    minWidth: "0",
    minHeight: "0",
    overflow: "hidden",
    backgroundColor: "var(--scenario-chrome-workspace)",
    color: "var(--scenario-chrome-text)",
  },
  // .shell[data-has-header="false"]
  shellHeaderless: {
    gridTemplateRows: "minmax(0, 1fr)",
  },
  // .shell[data-canvas-mode="passthrough"] — transparent so the persistent
  // CityView behind the shell stays visible, and `isolation: auto` so
  // `backdrop-filter` on the overlaid panes can sample it.
  shellPassthrough: {
    isolation: "auto",
    backgroundColor: "transparent",
  },
  body: {
    pointerEvents: "auto",
    position: "relative",
    display: "flex",
    minWidth: "0",
    minHeight: "0",
    overflow: "hidden",
  },
  header: {
    pointerEvents: "auto",
    minWidth: "0",
    minHeight: "0",
  },
  leftSidebar: {
    pointerEvents: "auto",
    position: "absolute",
    top: space.none,
    right: "auto",
    bottom: space.none,
    left: space.none,
    zIndex: "20",
    minWidth: "0",
    minHeight: "0",
    overflow: "visible",
    borderWidth: "0",
    backgroundColor: "transparent",
  },
  viewport: {
    pointerEvents: "auto",
    flex: "1 1 auto",
    position: "relative",
    zIndex: "0",
    minWidth: "0",
    minHeight: "0",
    overflow: "hidden",
    backgroundColor: "var(--scenario-chrome-viewport)",
  },
  // .shell[data-canvas-mode="passthrough"] .viewport
  viewportPassthrough: {
    backgroundColor: "transparent",
  },
  canvas: {
    pointerEvents: "auto",
    position: "absolute",
    inset: space.none,
    minWidth: "0",
    minHeight: "0",
    overflow: "hidden",
  },
  // .passthrough — and the matching
  // `.shell[data-canvas-mode="passthrough"] .body/.viewport/.canvas` rules,
  // which set the same `pointer-events: none` one level up.
  passthrough: {
    pointerEvents: "none",
    backgroundColor: "transparent",
  },
  inert: {
    pointerEvents: "none",
  },
  statusLayer: {
    pointerEvents: "none",
    position: "absolute",
    inset: space.none,
    zIndex: "35",
    minWidth: "0",
    minHeight: "0",
  },
  floatingLayer: {
    pointerEvents: "none",
    position: "absolute",
    inset: space.none,
    zIndex: "34",
    minWidth: "0",
    minHeight: "0",
  },
  disabledChrome: {
    pointerEvents: "none",
    filter: "saturate(0.55)",
    opacity: 0.55,
  },
});
