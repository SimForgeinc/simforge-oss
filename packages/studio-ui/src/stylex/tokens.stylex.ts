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
 * the runtime theme bridge above possible at all. `layout` is the exception:
 * breakpoints are media-query keys, which must be known at compile time.
 *
 * Tokens are named by role. Where a role has steps (ink, hairline, fill,
 * scrim) the steps are a ladder: pick the step by how much the thing should
 * recede, never by the alpha you want. How to choose between them is in
 * docs/engineering/studio-style-guide.md. Names marked `@deprecated` are kept
 * only until their last caller moves to the name they point at.
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
  /** @deprecated Identical to `card`. */
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
  /** The shadcn input border: the same grey as `border` in the dark theme. */
  input: "hsl(var(--input))",
  ring: "hsl(var(--ring))",
  /**
   * The neutral hover/selected wash shadcn calls `--accent`. It is grey, not
   * the brand accent; the name says what it does so the two stop colliding.
   */
  hoverWash: "hsl(var(--accent))",
  hoverWashText: "hsl(var(--accent-foreground))",

  // The two list-chrome plates that sit *below* `bg` on purpose.
  surfaceDeep: "hsl(var(--surface-deep))",
  surfaceRaised: "hsl(var(--surface-raised))",

  // The editor's fixed plate. Identical in both themes: it is the frame around
  // a rendered world, and a light frame would wash the render out.
  panelSolid: "#0a0a0a",
  panel: "#111113",
  panel2: "#18181b",

  // Theme ink: body copy that follows the theme.
  text: "hsl(var(--foreground))",
  /** @deprecated Identical to `mutedForeground`. */
  textMuted: "hsl(var(--muted-foreground))",
  /** @deprecated Between two ink steps; use `inkMuted` or `inkSecondary`. */
  textSubtle: "rgba(255, 255, 255, 0.5)",
  /** @deprecated Use `inkFaint`. */
  textFaint: "rgba(255, 255, 255, 0.35)",

  /**
   * The ink ladder: white at five fixed alphas. Studio's chrome is always
   * dark, so every grey on it is white showing some of the plate through, and
   * a new grey is a new step nobody else uses. Pick by role:
   *  - `ink`: titles, values, the thing being read.
   *  - `inkSecondary`: body copy and labels that matter.
   *  - `inkMuted`: metadata, captions, idle controls.
   *  - `inkFaint`: placeholders, disabled text, separators in text.
   *  - `inkGhost`: watermark-level hints.
   */
  ink: "#ffffff",
  inkSecondary: "rgba(255, 255, 255, 0.7)",
  inkMuted: "rgba(255, 255, 255, 0.45)",
  inkFaint: "rgba(255, 255, 255, 0.35)",
  inkGhost: "rgba(255, 255, 255, 0.25)",
  /** @deprecated Use `ink`. */
  textOnPlate: "#ffffff",

  /**
   * Hairlines: white at low alpha so an edge reads as light catching it.
   * `hairline` is every border and divider; `hairlineSubtle` separates
   * things inside one surface; `hairlineStrong` is a hovered or raised edge.
   */
  hairlineSubtle: "rgba(255, 255, 255, 0.05)",
  hairline: "rgba(255, 255, 255, 0.08)",
  hairlineStrong: "rgba(255, 255, 255, 0.14)",
  /** @deprecated Use `hairline`. */
  line: "rgba(255, 255, 255, 0.08)",
  /** @deprecated Use `hairlineStrong`. */
  lineStrong: "rgba(255, 255, 255, 0.14)",

  /**
   * Fills: white plates over the near-black background, lightening what is
   * behind them rather than punching an opaque hole in a live world view.
   * `fillFaint` is a resting card, `fillSubtle` a hovered row or glass pane,
   * `fill` a pressed or hovered control, `fillStrong` a chip, `fillStronger`
   * a selected chip.
   */
  fillFaint: "rgba(255, 255, 255, 0.02)",
  fillSubtle: "rgba(255, 255, 255, 0.04)",
  fill: "rgba(255, 255, 255, 0.06)",
  fillStrong: "rgba(255, 255, 255, 0.1)",
  fillStronger: "rgba(255, 255, 255, 0.15)",

  // Glass. These are the `.render-glass*` values: a pane over the live world.
  /** @deprecated Use `fillSubtle`. */
  glass: "rgba(255, 255, 255, 0.04)",
  glassRaised: "rgba(255, 255, 255, 0.07)",
  /** @deprecated Use `fillStronger`. */
  glassHover: "rgba(255, 255, 255, 0.15)",
  /** @deprecated Use `fillStrong`. */
  chip: "rgba(255, 255, 255, 0.1)",
  /** @deprecated Use `fillStronger`. */
  chipStrong: "rgba(255, 255, 255, 0.15)",

  /**
   * Dark scrims, for controls and captions that must hold contrast over an
   * arbitrary bright frame, and behind modal surfaces.
   */
  scrimLight: "rgba(0, 0, 0, 0.25)",
  scrim: "rgba(0, 0, 0, 0.45)",
  scrimHeavy: "rgba(0, 0, 0, 0.75)",
  /** @deprecated Use `scrim`. */
  overlayScrim: "rgba(0, 0, 0, 0.45)",
  /** @deprecated Use `scrimLight`. */
  overlayMat: "rgba(0, 0, 0, 0.25)",

  // Brand accent. Fixed, not themed: it is the one saturated colour in the
  // product and it identifies the product. Signal, not decoration: the
  // current item, the primary action, a focus ring. About 5% of a surface.
  accent: "#E8E044",
  accentHover: "#f1ea55",
  accentText: "#0a0a0a",
  /** Behind the current item: a warm plate, never a solid block. */
  accentWash: "rgba(232, 224, 68, 0.1)",
  /** The edge of a current or selected item. */
  accentLine: "rgba(232, 224, 68, 0.6)",
  /** A quieter accent edge, for a large selected surface. */
  accentLineSubtle: "rgba(232, 224, 68, 0.3)",
  /** @deprecated Use `accentWash`. */
  accentSoft: "rgba(232, 224, 68, 0.12)",

  danger: "hsl(var(--destructive))",
  dangerText: "hsl(var(--destructive-foreground))",

  /**
   * Status ink and washes, backing the `Tone` type. Light tints because they
   * are read on the near-black plate; the washes sit behind a status chip.
   */
  positive: "#34d399",
  positiveWash: "rgba(52, 211, 153, 0.1)",
  warning: "#fcd34d",
  warningWash: "rgba(252, 211, 77, 0.1)",
  critical: "#fca5a5",
  criticalWash: "rgba(252, 165, 165, 0.1)",
  info: "#7dd3fc",
  infoWash: "rgba(125, 211, 252, 0.1)",

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

  /** 8px: axis ticks and badge counts only. */
  sizeNano: "0.5rem",
  /** 9px: status tags on dense rows. */
  sizeTag: "0.5625rem",
  /** 10px: the instrument label size (eyebrows, meta labels, counters). */
  sizeMicro: "0.625rem",
  /** 11px: secondary meta text. */
  sizeMeta: "0.6875rem",
  sizeXs: "0.75rem",
  sizeSm: "0.875rem",
  sizeBase: "1rem",
  sizeLg: "1.125rem",
  sizeXl: "1.25rem",
  size2xl: "1.5rem",

  /**
   * Line heights. The `line<Size>` steps pair with the size of the same name
   * (`sizeXs` + `lineXs`), which is the rhythm the product was built on.
   */
  lineMicro: "0.875rem",
  lineXs: "1rem",
  lineSm: "1.25rem",
  lineBase: "1.5rem",
  lineLg: "1.75rem",
  lineXl: "2rem",
  /** @deprecated Identical to `lineXs`. */
  lineMeta: "1rem",
  /** Unitless ratios for prose, which scale with whatever size they meet. */
  lineTight: "1.25",
  lineSnug: "1.375",
  lineNormal: "1.5",
  lineRelaxed: "1.625",

  weightNormal: "400",
  weightMedium: "500",
  weightSemibold: "600",
  weightBold: "700",

  /** Tracking for display and body faces. */
  trackingTight: "-0.025em",
  trackingWide: "0.025em",
  trackingWider: "0.05em",
  /** Tracking for the meta face, which is only legible uppercase tracked out. */
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
  /**
   * The spacing scale, named by its step on the 0.25rem grid (`s3` is
   * 0.75rem, 12px at the default root size, Tailwind's `3`). Every gap and
   * padding is one of these.
   */
  s0_5: "0.125rem",
  s1: "0.25rem",
  s1_5: "0.375rem",
  s2: "0.5rem",
  s2_5: "0.625rem",
  s3: "0.75rem",
  s3_5: "0.875rem",
  s4: "1rem",
  s5: "1.25rem",
  s6: "1.5rem",
  s7: "1.75rem",
  s8: "2rem",
  s10: "2.5rem",
  s12: "3rem",

  /** @deprecated Write `0`. */
  none: "0",
  /** @deprecated Use `s0_5`. */
  xxs: "0.125rem",
  /** @deprecated Use `s1`. */
  xs: "0.25rem",
  /** @deprecated Use `s1_5`. */
  sm: "0.375rem",
  /** @deprecated Use `s2`. */
  md: "0.5rem",
  /** @deprecated Use `s3`. */
  lg: "0.75rem",
  /** @deprecated Use `s4`. */
  xl: "1rem",
  /** @deprecated Use `s6`. */
  xxl: "1.5rem",
  /** @deprecated Use `s8`. */
  xxxl: "2rem",

  datasetStripWidth: "3.5rem",
  railWidth: "13.75rem",
  railWidthXl: "18.25rem",
  inspectorWidth: "16.25rem",
  inspectorWidthXl: "20rem",
  detailWidth: "26.25rem",
  shellWidth: "38.75rem",
});

/** Compile-time geometry: media queries cannot reference CSS custom properties. */
export const layout = stylex.defineConsts({
  gutterNarrow: "16px",
  gutter: "24px",
  gutterWide: "32px",
  utilityFrame: "940px",
  formMeasure: "32rem",
  /**
   * Breakpoints, as media-query keys: `{ default: …, [layout.bpSm]: … }`.
   * The Tailwind steps the product was laid out on.
   */
  bpSm: "@media (min-width: 640px)",
  bpMd: "@media (min-width: 768px)",
  bpLg: "@media (min-width: 1024px)",
  bpXl: "@media (min-width: 1280px)",
  bp2xl: "@media (min-width: 1536px)",
  /** The reduced-motion condition every animation and transition answers. */
  reducedMotion: "@media (prefers-reduced-motion: reduce)",
  /** @deprecated Identical to `bpLg`. */
  workspaceBreakpoint: "@media (min-width: 1024px)",
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
  /** @deprecated Every step but `full` is 0; delete the declaration instead. */
  sm: "0",
  /** @deprecated Every step but `full` is 0; delete the declaration instead. */
  md: "0",
  /** @deprecated Every step but `full` is 0; delete the declaration instead. */
  lg: "0",
  /** @deprecated Every step but `full` is 0; delete the declaration instead. */
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
  /** Controls floating over content inside one surface (a close button, a toolbar). */
  float: 20,
  sticky: 30,
  /** An overlay inside one surface: a drawer or a busy veil over a panel. */
  overlay: 40,
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
  /** A modal dialog's scrim; its content sits at `dialogTop`. */
  dialog: 200,
  dialogTop: 210,
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
  /** The default for colour and opacity transitions on controls. */
  durStandard: "150ms",
  durBase: "180ms",
  durSlow: "260ms",
  /** One turn of a spinner. */
  durSpin: "1s",
  /** One breath of a pulsing status dot. */
  durPulse: "2s",

  easeStandard: "cubic-bezier(0.4, 0, 0.2, 1)",
  easeExpressive: "cubic-bezier(0.16, 1, 0.3, 1)",
  easeSnappy: "cubic-bezier(0.2, 0.8, 0.2, 1)",
  /** Decelerating entrance (Tailwind's `ease-out` curve). */
  easeDecelerate: "cubic-bezier(0, 0, 0.2, 1)",
  /** The pulse curve: slow in, slow out. */
  easePulse: "cubic-bezier(0.4, 0, 0.6, 1)",
  easeLinear: "linear",
  easeIn: "ease-in",
  easeOut: "ease-out",
  easeInOut: "ease-in-out",

  blurSm: "blur(4px)",
  blurMd: "blur(8px)",
  blurGlass: "blur(12px)",
  blurPane: "blur(24px)",
  blurLg: "blur(40px)",
});

/**
 * Stroke widths. `hairline` is every border; `thick` is an emphasis rule
 * (a current-tab underline, a spinner's ring).
 */
export const stroke = stylex.defineVars({
  hairline: "1px",
  thick: "2px",
});

/**
 * Shadows. Studio's chrome is flat: depth comes from fills and hairlines, so
 * the `elevation*` steps are for things that genuinely float over content
 * (menus, dialogs, popovers). The `ring*` values are focus rings drawn as a
 * shadow; use the `focus` recipe rather than these directly.
 */
export const shadows = stylex.defineVars({
  /** The focus ring: 2px of brand accent, the one ring every control shows. */
  ring: "0 0 0 2px #E8E044",
  ringInset: "inset 0 0 0 2px #E8E044",
  /** @deprecated Use `ring`: it is the accent ring. */
  ringAccent: "0 0 0 2px #E8E044",
  /** @deprecated Use `ringInset`. */
  ringAccentInset: "inset 0 0 0 2px #E8E044",
  /** @deprecated Use `ring`. */
  ringOffset: "0 0 0 2px #E8E044",
  elevationSm: "0 1px 2px 0 rgb(0 0 0 / 0.05)",
  elevationLg: "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)",
  elevationXl: "0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)",
  elevation2xl: "0 25px 50px -12px rgb(0 0 0 / 0.25)",
});
