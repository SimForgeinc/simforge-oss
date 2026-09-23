/**
 * StyleX styles for the first-run onboarding screens.
 *
 * Onboarding is the one place in Studio that is not instrument chrome: it is a
 * marketing-adjacent surface over the animated hero the download page
 * promised, on a near-black canvas (`#050607`, painted by the host's route
 * layout). The white-alpha glass and the teal hero palette are the screen's
 * own art direction rather than product tokens, so they stay literal here;
 * everything that belongs to the product — the accent, the type scale, the
 * spacing rhythm, the destructive colour — comes from the shared tokens.
 *
 * Both steps render into one column: the welcome copy and the map setup are
 * the same type, the same actions row and the same footnote, so moving from
 * one to the other swaps content in place rather than changing layouts.
 *
 * Radii are deliberately `radii.none` throughout: the product's radius scale
 * resolves every step to `0`, so the `rounded-2xl`/`rounded-full` utilities
 * these screens were written with never rounded anything. Naming the zero is
 * how that stays true when someone reads the style object instead of the
 * Tailwind config.
 */

import * as stylex from "@stylexjs/stylex";

import { colors, radii, space, text } from "../stylex/tokens.stylex";

/**
 * Custom property carrying a single install row's completed fraction as a
 * percentage string. One static class paints every row; only this variable
 * changes per render.
 */
export const PROGRESS_VAR = "--onboarding-progress";

const spin = stylex.keyframes({
  from: { transform: "rotate(0deg)" },
  to: { transform: "rotate(360deg)" },
});

export const onboarding = stylex.create({
  /* ── Step frame ────────────────────────────────────────────────── */
  /**
   * A step that fills the column: a heading that keeps its size, one
   * flexible region in the middle, and the controls that end the step. The
   * column's height is definite (see the host's route layout), so the middle
   * region is exactly what the viewport has left — no step can push its
   * primary action off screen, and nothing has to be measured to know that.
   */
  stepSection: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
  },
  stepHeader: {
    flexShrink: 0,
  },
  stepFooter: {
    flexShrink: 0,
  },

  /* ── Type ──────────────────────────────────────────────────────── */
  eyebrow: {
    fontFamily: text.fontMeta,
    fontSize: "10px",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaWidest,
    color: colors.accent,
  },
  /**
   * The step title. Two sizes rather than the marketing site's three: the
   * whole step has to fit one viewport alongside its controls, so the
   * headline takes the space a headline needs and no more.
   */
  welcomeTitle: {
    marginTop: space.sm,
    fontSize: { default: "1.75rem", "@media (min-width: 640px)": "2.25rem" },
    lineHeight: 1.1,
    fontWeight: 600,
    letterSpacing: "-0.025em",
  },
  welcomeLede: {
    marginTop: space.lg,
    maxWidth: "40rem",
    fontSize: "0.9375rem",
    lineHeight: "1.5rem",
    color: "rgba(255, 255, 255, 0.75)",
  },
  accountNote: {
    marginTop: space.xxl,
    fontSize: "0.875rem",
    lineHeight: "1.25rem",
    color: colors.accent,
  },
  /** Advisory, not fatal: a warning hue rather than the destructive one. */
  cautionNote: {
    marginTop: space.xxl,
    maxWidth: "36rem",
    fontSize: "0.875rem",
    lineHeight: "1.5rem",
    color: "rgba(252, 211, 77, 0.9)",
  },
  blockedNote: {
    marginTop: space.lg,
    fontSize: "0.75rem",
    lineHeight: "1.25rem",
    color: "rgba(252, 211, 77, 0.9)",
  },
  footnote: {
    marginTop: space.lg,
    fontSize: "0.75rem",
    lineHeight: "1rem",
    color: colors.textSubtle,
  },

  /* ── Actions ───────────────────────────────────────────────────── */
  primaryAction: {
    flex: 1,
    height: "3rem",
    borderRadius: radii.full,
    backgroundColor: colors.accent,
    color: colors.accentText,
    ":hover": { backgroundColor: colors.accentHover },
  },
  secondaryAction: {
    flex: 1,
    height: "3rem",
    borderRadius: radii.full,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "rgba(255, 255, 255, 0.3)",
    backgroundColor: "rgba(255, 255, 255, 0.04)",
    color: "white",
    ":hover": { backgroundColor: "rgba(255, 255, 255, 0.1)" },
  },
  welcomeActions: {
    display: "flex",
    flexDirection: { default: "column", "@media (min-width: 640px)": "row" },
    gap: space.lg,
    marginTop: space.xl,
  },
  rowActions: {
    display: "flex",
    flexShrink: 0,
    gap: space.md,
  },
  /**
   * The host's inline sign-in flow, in the column's own rhythm. The form
   * brings its own internal spacing and runs the column's measure, so this
   * only places it: the same gap the actions row uses, and no card around
   * it, because the flow is part of the page rather than a panel over it.
   */
  signInSlot: {
    display: "flex",
    flexDirection: "column",
    marginTop: space.xl,
  },
  /**
   * The way out of the revealed sign-in flow, back to the two choices. Sized
   * to its label rather than stretched like the actions row: it is the
   * smaller of the decisions on offer here, and the form's own submit is
   * what the column should lead the eye to.
   */
  signInDismiss: {
    alignSelf: "flex-start",
    marginTop: space.xl,
    borderRadius: radii.full,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "rgba(255, 255, 255, 0.3)",
    backgroundColor: "rgba(255, 255, 255, 0.04)",
    color: "white",
    ":hover": { backgroundColor: "rgba(255, 255, 255, 0.1)" },
  },

  /* ── Catalog ───────────────────────────────────────────────────── */
  catalogLoading: {
    display: "flex",
    alignItems: "center",
    gap: space.md,
    marginTop: space.xl,
    fontSize: "0.875rem",
    lineHeight: "1.25rem",
    color: "rgba(255, 255, 255, 0.45)",
  },
  /**
   * The step's flexible middle: whichever of the map grid, the install
   * progress or a catalog message the step is showing. It takes the height
   * the heading and the controls leave and never more, so the step's primary
   * action cannot be pushed out of the viewport.
   */
  mapRegion: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    minHeight: 0,
    marginTop: space.lg,
  },
  /**
   * Ten maps as a three-column contact sheet rather than ten full-width
   * rows: four rows instead of ten is most of what makes the step fit one
   * viewport, and a map is something you recognise by looking at it, so the
   * thumbnail is the card rather than a chip beside a filename.
   *
   * Rows share the region's leftover height (`1fr`), which makes every
   * card's height definite before a single thumbnail has arrived — the
   * images fill a box the layout already sized, so none of them reflows the
   * grid as it decodes. `minmax` keeps a floor under that: where the
   * viewport cannot pay for four legible rows the region scrolls itself
   * rather than letting the page scroll.
   */
  mapList: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gridAutoRows: "minmax(4.5rem, 1fr)",
    gap: space.md,
    height: "100%",
    margin: 0,
    padding: 0,
    overflowY: "auto",
    listStyle: "none",
  },
  mapListItem: {
    display: "flex",
    minWidth: 0,
    minHeight: 0,
  },
  /**
   * One card, thumbnail-first: the image fills it and the name, the locality
   * and the download size sit on a scrim over the bottom of the image, so
   * nothing competes with the picture for the card's height.
   */
  mapCard: {
    position: "relative",
    display: "block",
    flexGrow: 1,
    minWidth: 0,
    overflow: "hidden",
    borderWidth: 1,
    borderStyle: "solid",
    borderRadius: radii.none,
    backgroundColor: "rgba(0, 0, 0, 0.45)",
    transitionProperty: "color, background-color, border-color, box-shadow",
    transitionDuration: "150ms",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    ":focus-within": { outline: `2px solid ${colors.accent}`, outlineOffset: "2px" },
  },
  mapCardIdle: {
    cursor: "pointer",
    borderColor: {
      default: "rgba(255, 255, 255, 0.14)",
      ":hover": "rgba(255, 255, 255, 0.45)",
    },
  },
  /**
   * Selected and included read the same because they mean the same thing to
   * the download that follows; only the corner control says which of them is
   * a choice.
   */
  mapCardSelected: {
    cursor: "pointer",
    borderColor: "rgba(232, 224, 68, 0.85)",
    boxShadow: "inset 0 0 0 1px rgba(232, 224, 68, 0.45)",
  },
  /** The public map: not a choice, so no pointer affordance. */
  mapCardIncluded: {
    borderColor: "rgba(232, 224, 68, 0.85)",
    boxShadow: "inset 0 0 0 1px rgba(232, 224, 68, 0.45)",
  },
  mapCardLocked: {
    cursor: "not-allowed",
    borderColor: "rgba(255, 255, 255, 0.08)",
    opacity: 0.55,
  },
  /** The picture layer: the whole card, behind everything else on it. */
  mapCardThumbnail: {
    position: "absolute",
    inset: 0,
    overflow: "hidden",
    backgroundColor: "rgba(0, 0, 0, 0.4)",
  },
  thumbnailImage: {
    display: "block",
    width: "100%",
    height: "100%",
    objectFit: "cover",
  },
  /** Holds the caption legible over whatever the thumbnail happens to be. */
  mapCardScrim: {
    position: "absolute",
    insetInline: 0,
    bottom: 0,
    height: "70%",
    backgroundImage:
      "linear-gradient(180deg, rgba(5,6,7,0) 0%, rgba(5,6,7,0.55) 45%, rgba(5,6,7,0.92) 100%)",
  },
  mapCardControl: {
    position: "absolute",
    top: space.xs,
    left: space.xs,
    zIndex: 1,
    display: "grid",
    placeItems: "center",
    width: "1.25rem",
    height: "1.25rem",
    backgroundColor: "rgba(5, 6, 7, 0.65)",
  },
  mapCardTag: {
    position: "absolute",
    top: space.xs,
    right: space.xs,
    zIndex: 1,
    paddingInline: space.xs,
    paddingBlock: "1px",
    backgroundColor: "rgba(5, 6, 7, 0.65)",
    fontFamily: text.fontMeta,
    fontSize: "9px",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
  },
  includedTag: {
    color: colors.accent,
  },
  lockedTag: {
    color: "rgba(255, 255, 255, 0.7)",
  },
  checkbox: {
    width: "0.875rem",
    height: "0.875rem",
    margin: 0,
    accentColor: colors.accent,
  },
  mapCardText: {
    position: "absolute",
    insetInline: 0,
    bottom: 0,
    zIndex: 1,
    minWidth: 0,
    paddingInline: space.md,
    paddingBlock: space.xs,
  },
  mapCardLabel: {
    display: "block",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "0.8125rem",
    lineHeight: "1.125rem",
    fontWeight: 600,
    color: "rgba(255, 255, 255, 0.95)",
  },
  mapCardFooter: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: space.xs,
  },
  mapCardLocality: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "0.6875rem",
    lineHeight: "1rem",
    color: "rgba(255, 255, 255, 0.55)",
  },
  mapCardSize: {
    flexShrink: 0,
    fontFamily: text.fontMono,
    fontSize: "10px",
    color: "rgba(255, 255, 255, 0.7)",
  },

  /* ── Graphics level ────────────────────────────────────────────── */
  qualityField: {
    marginTop: space.lg,
    minWidth: 0,
    padding: 0,
    borderWidth: 0,
  },
  legend: {
    fontFamily: text.fontMeta,
    fontSize: "9px",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaWider,
    color: "rgba(255, 255, 255, 0.45)",
  },
  /** One segmented control; the selected segment reads as the accent chip. */
  qualitySegments: {
    display: "grid",
    gridTemplateColumns: { default: "repeat(2, minmax(0, 1fr))", "@media (min-width: 640px)": "repeat(3, minmax(0, 1fr))" },
    gap: space.sm,
    marginTop: space.md,
  },
  qualitySegment: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: space.xxs,
    minHeight: "2.5rem",
    paddingInline: space.md,
    paddingBlock: space.sm,
    cursor: "pointer",
    borderWidth: 1,
    borderStyle: "solid",
    borderRadius: radii.none,
    fontSize: "0.8125rem",
    lineHeight: "1rem",
    fontWeight: 500,
    textAlign: "center",
    transitionProperty: "color, background-color, border-color",
    transitionDuration: "150ms",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    ":focus-within": { outline: `2px solid ${colors.accent}`, outlineOffset: "2px" },
  },
  qualitySegmentIdle: {
    borderColor: {
      default: "rgba(255, 255, 255, 0.14)",
      ":hover": "rgba(255, 255, 255, 0.3)",
    },
    backgroundColor: "rgba(255, 255, 255, 0.04)",
    color: "rgba(255, 255, 255, 0.75)",
  },
  qualitySegmentSelected: {
    borderColor: colors.accent,
    backgroundColor: colors.accent,
    color: colors.accentText,
  },
  qualityGuidance: {
    marginTop: space.sm,
    fontSize: "0.6875rem",
    lineHeight: "1rem",
    color: "rgba(255, 255, 255, 0.45)",
  },
  srOnly: {
    position: "absolute",
    width: "1px",
    height: "1px",
    padding: 0,
    margin: "-1px",
    overflow: "hidden",
    clip: "rect(0, 0, 0, 0)",
    whiteSpace: "nowrap",
    borderWidth: 0,
  },

  /* ── Disk summary ──────────────────────────────────────────────── */
  summaryLine: {
    display: "flex",
    flexWrap: "wrap",
    columnGap: space.md,
    rowGap: space.xs,
    marginTop: space.lg,
    marginBottom: 0,
    fontSize: "0.75rem",
    lineHeight: "1rem",
  },
  summaryTerm: {
    color: "rgba(255, 255, 255, 0.45)",
  },
  summaryValue: {
    marginInlineStart: 0,
    marginInlineEnd: space.lg,
    fontFamily: text.fontMono,
    color: "rgba(255, 255, 255, 0.85)",
  },
  errorNote: {
    marginTop: space.xl,
    padding: space.lg,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "hsl(var(--destructive) / 0.4)",
    backgroundColor: "hsl(var(--destructive) / 0.1)",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    color: colors.danger,
  },

  /* ── Icons ─────────────────────────────────────────────────────── */
  icon: {
    width: "1rem",
    height: "1rem",
  },
  iconSmall: {
    width: "0.875rem",
    height: "0.875rem",
  },
  iconAccent: {
    color: colors.accent,
  },
  iconDanger: {
    color: "hsl(var(--destructive))",
  },
  iconMuted: {
    color: "rgba(255, 255, 255, 0.35)",
  },
  iconWithLabel: {
    marginInlineEnd: "0.25rem",
  },
  spinner: {
    animationName: { default: spin, "@media (prefers-reduced-motion: reduce)": "none" },
    animationDuration: "1s",
    animationIterationCount: "infinite",
    animationTimingFunction: "linear",
  },
});

/**
 * Install rows, as the onboarding screen shows them. They take the place of
 * the map grid once a download starts — the selection is frozen for the rest
 * of the step, and progress is what there is left to watch — so the list
 * lives in the same flexible region and scrolls inside it rather than
 * lengthening the page past its own "Download and continue".
 */
export const installRows = stylex.create({
  list: {
    display: "grid",
    gridAutoRows: "min-content",
    gap: space.sm,
    height: "100%",
    margin: 0,
    padding: 0,
    overflowY: "auto",
    listStyle: "none",
  },
  row: {
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "rgba(255,255,255,0.1)",
    borderRadius: radii.none,
    backgroundColor: "rgba(255, 255, 255, 0.03)",
    paddingInline: space.lg,
    paddingBlock: space.md,
  },
  rowHead: {
    display: "flex",
    alignItems: "center",
    gap: space.lg,
  },
  stateIcon: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: "1.25rem",
    height: "1.25rem",
    color: colors.accent,
  },
  rowLabel: {
    minWidth: 0,
    flex: 1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "0.875rem",
    lineHeight: "1.25rem",
    color: "rgba(255, 255, 255, 0.8)",
  },
  rowBytes: {
    fontFamily: text.fontMono,
    fontSize: "11px",
    color: "rgba(255, 255, 255, 0.4)",
  },
  rowMessage: {
    marginTop: space.md,
    fontSize: "0.75rem",
    lineHeight: "1rem",
    color: colors.danger,
  },
  /**
   * Progress track. The fill's width is the one genuinely runtime value on
   * these screens, so it arrives as a custom property rather than a generated
   * class per percentage.
   */
  track: {
    marginTop: space.md,
    height: "0.25rem",
    overflow: "hidden",
    borderRadius: radii.none,
    backgroundColor: colors.chip,
  },
  fill: {
    height: "100%",
    width: `var(${PROGRESS_VAR})`,
    borderRadius: radii.none,
    backgroundColor: colors.accent,
    transitionProperty: "width",
    transitionDuration: "500ms",
  },
});

/**
 * The hero layer. Everything here is decoration behind the copy: the gradient
 * the server paints, the vendored scene over it, and the two scrims that hold
 * both down far enough for body text to stay readable.
 */
export const hero = stylex.create({
  root: {
    position: "absolute",
    inset: 0,
    overflow: "hidden",
    pointerEvents: "none",
    backgroundImage:
      "radial-gradient(120% 90% at 72% 18%, #1b4a5e 0%, #0d2130 38%, #060a0e 72%, #050607 100%)",
  },
  layer: {
    position: "absolute",
    inset: 0,
  },
  /**
   * The poster and the video: one crop of the scene, covering the layer at
   * any window shape. Both carry it, so swapping one for the other when the
   * motion preference is known changes nothing about the framing.
   */
  scene: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
  },
  verticalScrim: {
    backgroundImage:
      "linear-gradient(180deg, rgba(5,6,7,0.5) 0%, rgba(5,6,7,0.18) 38%, rgba(5,6,7,0.94) 100%)",
  },
  copyScrim: {
    backgroundImage:
      "linear-gradient(90deg, rgba(5,6,7,0.9) 0%, rgba(5,6,7,0.78) 38%, rgba(5,6,7,0.3) 72%, rgba(5,6,7,0.42) 100%)",
  },
});

/**
 * The shell every screen of the hero flow renders into: one canvas with the
 * hero behind it and one centred column the screens fill. `#050607` is the
 * canvas the hero gradient fades to, so the area outside a short screen
 * matches rather than falling back to the dashboard background.
 *
 * The shell owns the space it is given rather than growing past it: a screen
 * that scrolls hides the very button it is asking the user to press.
 * `height` (not `minHeight`) with `overflow: hidden` makes it unscrollable by
 * construction, which in turn makes the column's height *definite* — that is
 * what lets a screen hand its flexible region (the map grid) the space left
 * over from its heading and its actions instead of measuring anything.
 */
export const flow = stylex.create({
  shell: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    backgroundColor: "#050607",
    paddingInline: space.xxl,
    paddingBlock: "2rem",
    color: "#ffffff",
  },
  /** First-run onboarding has no chrome: the flow is the whole window. */
  shellViewport: {
    height: "100svh",
  },
  /**
   * The map library is reached from the app switcher, so it renders inside
   * the dashboard's main area — already the viewport minus the top bar, and
   * already a definite height.
   */
  shellFill: {
    height: "100%",
  },
  /**
   * Full height so a screen that wants the whole viewport (the map grid) can
   * take it, and `justifyContent: center` so a screen that does not (welcome,
   * native render) still reads as centred rather than pinned to the top.
   */
  column: {
    position: "relative",
    zIndex: 10,
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    width: "100%",
    maxWidth: "48rem",
    height: "100%",
    minHeight: 0,
  },
});

/**
 * The map library: the same column, the same contact sheet and the same type
 * as the setup step, with the per-map actions that a persistent surface needs
 * and the setup step does not. Everything it does not restate here it takes
 * from {@link onboarding}, which is the point — the library is the same page
 * of the same flow, reached at any time instead of once.
 */
export const library = stylex.create({
  /** The caption's right-hand end: the size, the progress, or the action. */
  cardStatus: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: space.xs,
    fontFamily: text.fontMono,
    fontSize: "10px",
    color: "rgba(255, 255, 255, 0.7)",
  },
  /**
   * A card-sized action. The product's button heights are written for a
   * toolbar; here the whole card is 4.5rem tall at its smallest, so the
   * install control is a chip in the caption rather than a control the
   * caption has to make room for.
   */
  cardAction: {
    height: "1.375rem",
    paddingInline: space.sm,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: {
      default: "rgba(255, 255, 255, 0.35)",
      ":hover": colors.accent,
    },
    backgroundColor: {
      default: "rgba(5, 6, 7, 0.65)",
      ":hover": "rgba(255, 255, 255, 0.12)",
    },
    fontFamily: text.fontMeta,
    fontSize: "9px",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: "#ffffff",
  },
  /** Progress of one card's install, pinned under its caption. */
  cardTrack: {
    position: "absolute",
    insetInline: 0,
    bottom: 0,
    zIndex: 2,
    height: "0.1875rem",
    backgroundColor: "rgba(255, 255, 255, 0.12)",
  },
  tagAvailable: {
    color: "rgba(255, 255, 255, 0.7)",
  },
  tagFailed: {
    color: colors.danger,
  },
  /** The failure of one map, under the grid rather than inside a card. */
  failure: {
    display: "flex",
    alignItems: "center",
    gap: space.md,
    marginTop: space.lg,
    fontSize: "0.75rem",
    lineHeight: "1rem",
    color: colors.danger,
  },
});
