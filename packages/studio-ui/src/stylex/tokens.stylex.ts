/**
 * StyleX design tokens for the studio surfaces.
 *
 * These are the existing visual language written down, not a new one. Every
 * colour either bridges a runtime custom property that `styles.css` already
 * defines (`hsl(var(--foreground))`) or repeats a literal that the product
 * already ships (`#E8E044`, `rgba(255,255,255,0.08)`). Nothing here changes
 * what a pixel looks like; it changes where the value is written once.
 *
 * Why bridge instead of inline the resolved colour: light/dark is switched by
 * the `.dark` class toggling those custom properties. A StyleX variable whose
 * value is `hsl(var(--foreground))` keeps following that switch, so themes
 * continue to work with no `stylex.createTheme` and no second source of truth.
 * Values that are theme-independent by design — traffic-signal lamps, the
 * brand accent, the translucent white/black scales used over live 3D — are
 * written as literals for the same reason they are literals today.
 *
 * `defineVars` (not `defineConsts`) throughout: these compile to real CSS
 * custom properties, so a token can be overridden per subtree and shows up in
 * devtools by name. The cost is one variable indirection, which is what makes
 * the runtime theme bridge above possible at all.
 */
import * as stylex from "@stylexjs/stylex";

/**
 * Surfaces, ink, lines and status colour.
 *
 * Three families live here deliberately:
 *  - shadcn semantic bridges (`bg`, `text`, `muted`, `primary`, …) for chrome
 *    that must follow the theme,
 *  - the editor's fixed dark plate (`panel`, `panel2`, `panelSolid`) which is
 *    the same in both themes because it frames a 3D scene, not a document,
 *  - translucent glass/chip/scrim values, which are white or black at low
 *    alpha so they lighten or darken whatever is behind them rather than
 *    punching an opaque hole in a live world view.
 */
export const colors = stylex.defineVars({
  // Theme-following semantic surfaces.
  bg: "hsl(var(--background))",
  bgElevated: "hsl(var(--card))",
  card: "hsl(var(--card))",
  popover: "hsl(var(--popover))",
  muted: "hsl(var(--muted))",
  mutedForeground: "hsl(var(--muted-foreground))",
  secondary: "hsl(var(--secondary))",
  secondaryForeground: "hsl(var(--secondary-foreground))",
  primary: "hsl(var(--primary))",
  primaryForeground: "hsl(var(--primary-foreground))",
  border: "hsl(var(--border))",
  ring: "hsl(var(--ring))",

  // The two list-chrome plates that sit *below* `bg` on purpose.
  surfaceDeep: "hsl(var(--surface-deep))",
  surfaceRaised: "hsl(var(--surface-raised))",

  // The editor's fixed plate. Identical in both themes: it is the frame around
  // a rendered world, and a light frame would wash the render out.
  panelSolid: "#0a0a0a",
  panel: "#111113",
  panel2: "#18181b",

  // Ink.
  text: "hsl(var(--foreground))",
  textMuted: "hsl(var(--muted-foreground))",
  textSubtle: "rgba(255, 255, 255, 0.5)",
  textFaint: "rgba(255, 255, 255, 0.35)",

  // Structural hairlines. `line` is the editor's; `lineStrong` is the raised
  // glass edge. Both are white-on-dark so they read as light catching an edge.
  line: "rgba(255, 255, 255, 0.08)",
  hairline: "rgba(255, 255, 255, 0.08)",
  lineStrong: "rgba(255, 255, 255, 0.14)",

  // Glass. These are the `.render-glass*` values: a pane over the live world.
  glass: "rgba(255, 255, 255, 0.04)",
  glassRaised: "rgba(255, 255, 255, 0.07)",
  glassHover: "rgba(255, 255, 255, 0.15)",
  chip: "rgba(255, 255, 255, 0.1)",
  chipStrong: "rgba(255, 255, 255, 0.15)",

  // Dark scrims, for controls and captions that must hold contrast over an
  // arbitrary bright frame rather than over the product's own background.
  overlayScrim: "rgba(0, 0, 0, 0.45)",
  overlayMat: "rgba(0, 0, 0, 0.25)",

  // Brand accent. Fixed, not themed: it is the one saturated colour in the
  // product and it identifies the product.
  accent: "#E8E044",
  accentHover: "#f1ea55",
  accentText: "#0a0a0a",
  accentSoft: "rgba(232, 224, 68, 0.12)",

  danger: "hsl(var(--destructive))",
  dangerText: "hsl(var(--destructive-foreground))",

  // Traffic-signal indications: the physical colour of a lamp. Theme-invariant
  // and never remapped onto `danger`/`accent` — a red light is not an error.
  signalGreen: "hsl(var(--signal-green))",
  signalYellow: "hsl(var(--signal-yellow))",
  signalRed: "hsl(var(--signal-red))",
  signalOff: "hsl(var(--signal-off))",
  signalUnknown: "hsl(var(--signal-unknown))",
});

/**
 * Type. `fontMeta` is the instrument-panel face used for uppercase, wide-
 * tracked labels and counters; it is deliberately distinct from `fontMono`,
 * which is the code face. The tracking scale exists because that face is only
 * legible uppercase when tracked out well past the usual 0.1em ceiling.
 */
export const text = stylex.defineVars({
  fontDisplay: "var(--font-display), system-ui, sans-serif",
  fontBody: "var(--font-body), system-ui, sans-serif",
  fontHeavy: "var(--font-heavy), system-ui, sans-serif",
  fontMono: "var(--font-mono), ui-monospace, monospace",
  fontMeta: "var(--font-meta), ui-monospace, monospace",

  sizeMicro: "0.625rem",
  sizeMeta: "0.6875rem",
  sizeXs: "0.75rem",
  sizeSm: "0.875rem",
  sizeBase: "1rem",
  sizeLg: "1.125rem",
  sizeXl: "1.25rem",
  size2xl: "1.5rem",

  lineMicro: "0.875rem",
  lineMeta: "1rem",
  lineTight: "1.25",
  lineNormal: "1.5",

  weightNormal: "400",
  weightMedium: "500",
  weightSemibold: "600",
  weightBold: "700",

  trackingMetaNarrow: "0.1em",
  trackingMetaTight: "0.12em",
  trackingMeta: "0.14em",
  trackingMetaWide: "0.16em",
  trackingMetaWider: "0.18em",
  trackingMetaWidest: "0.22em",
});

/**
 * Spacing, plus the shell geometry. The rail/inspector widths are fixed by
 * design — the canvas takes the remainder — and naming them keeps the rails
 * and the timeline dock on one measure instead of repeated `w-[220px]`.
 *
 * The scale steps are `rem`, not `px`, because that is what they came from:
 * every one is a Tailwind spacing step (`gap-1.5`, `p-3`, `mt-4`) and
 * Tailwind's scale is `0.25rem`-based. `styles.css` sets `html { font-size:
 * 100% }`, so a `rem` tracks the reader's browser default and a `px` does
 * not — writing these in `px` would freeze the padding of a surface whose
 * type still scales, which is a density change at any base size other than
 * 16px. A value that came from an arbitrary pixel utility (`text-[11px]`,
 * `w-[42px]`) is not a step on this scale and is written as a `px` literal
 * at its callsite instead.
 */
export const space = stylex.defineVars({
  none: "0",
  xxs: "0.125rem",
  xs: "0.25rem",
  sm: "0.375rem",
  md: "0.5rem",
  lg: "0.75rem",
  xl: "1rem",
  xxl: "1.5rem",
  xxxl: "2rem",

  railWidth: "13.75rem",
  railWidthXl: "18.25rem",
  inspectorWidth: "16.25rem",
  inspectorWidthXl: "20rem",
  detailWidth: "26.25rem",
  shellWidth: "38.75rem",
});

/**
 * Radii. The product is strictly rectangular and the global stylesheet
 * enforces `border-radius: 0 !important` on every element, so these exist to
 * be referenced, not to introduce rounding: every step is `0`. `full` is the
 * one sanctioned exception the reset itself carves out — a CSS border spinner,
 * which reads as a tumbling square if it is not round.
 */
export const radii = stylex.defineVars({
  none: "0",
  sm: "0",
  md: "0",
  lg: "0",
  xl: "0",
  full: "9999px",
});

/**
 * Stacking order.
 *
 * These are the values the tree already uses, named — not a new scale. They
 * are kept as the existing numbers rather than renumbered to 1..n so a StyleX
 * surface and the Tailwind `z-[200]` sibling it sits beside during the
 * migration continue to stack exactly as they do today. They are numbers, as
 * `z-index` is: a string token widens to `string`, which the value-checked
 * `StyleXStyles` prop type on the primitives then rejects.
 */
export const layers = stylex.defineVars({
  base: 0,
  raised: 10,
  sticky: 30,
  // Tailwind's `z-50`, which the shadcn portals (dropdown menus, tooltips,
  // sheets and their scrims) are written against. It sits below the editor
  // chrome on purpose: that is where those portals stacked before the
  // migration, and the editor's own overlays are meant to cover them.
  popover: 50,
  editorChrome: 60,
  editorOverlay: 80,
  editorTop: 90,
  dropdown: 100,
  tutorial: 140,
  tutorialTop: 150,
  dialog: 200,
  dialogTop: 220,
  loading: 240,
  loadingTop: 250,
  topbar: 260,
  appSwitcher: 300,
  appSwitcherTop: 310,
  mapTooltip: 1000,
});

/**
 * Motion. `expressive` is the long-tail entrance curve the editor surfaces
 * established; `snappy` is the shorter one the render pane uses. Both are
 * carried over unchanged so a migrated surface enters on the same curve as the
 * unmigrated one next to it.
 *
 * Blur values are here because the glass surfaces are defined by their blur as
 * much as by their fill, and the two must not drift apart.
 */
export const motion = stylex.defineVars({
  durInstant: "80ms",
  durFast: "120ms",
  durBase: "180ms",
  durSlow: "260ms",

  easeStandard: "cubic-bezier(0.4, 0, 0.2, 1)",
  easeExpressive: "cubic-bezier(0.16, 1, 0.3, 1)",
  easeSnappy: "cubic-bezier(0.2, 0.8, 0.2, 1)",
  easeOut: "ease-out",

  blurGlass: "blur(12px)",
  blurPane: "blur(24px)",
});
