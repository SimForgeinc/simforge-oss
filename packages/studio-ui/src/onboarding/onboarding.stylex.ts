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
  /* ── Type ──────────────────────────────────────────────────────── */
  eyebrow: {
    fontFamily: text.fontMeta,
    fontSize: "10px",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaWidest,
    color: colors.accent,
  },
  welcomeTitle: {
    marginTop: space.lg,
    fontSize: { default: "2.25rem", "@media (min-width: 640px)": "3rem" },
    lineHeight: { default: "2.5rem", "@media (min-width: 640px)": 1 },
    fontWeight: 600,
    letterSpacing: "-0.025em",
  },
  welcomeLede: {
    marginTop: "1.25rem",
    maxWidth: "36rem",
    fontSize: "1rem",
    lineHeight: "1.75rem",
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
    marginTop: space.xl,
    fontSize: "0.75rem",
    lineHeight: "1.25rem",
    color: "rgba(252, 211, 77, 0.9)",
  },
  footnote: {
    marginTop: space.xl,
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
    marginTop: "2.5rem",
  },
  rowActions: {
    display: "flex",
    flexShrink: 0,
    gap: space.md,
  },
  /**
   * The host's inline sign-in flow, in the column's own rhythm. The form
   * brings its own internal spacing and 26rem measure, so this only places
   * it: the same gap the actions row uses, and no card around it, because
   * the flow is part of the page rather than a panel over it.
   */
  signInSlot: {
    display: "flex",
    flexDirection: "column",
    marginTop: "2.5rem",
  },

  /* ── Catalog ───────────────────────────────────────────────────── */
  catalogLoading: {
    display: "flex",
    alignItems: "center",
    gap: space.md,
    marginTop: space.xxxl,
    fontSize: "0.875rem",
    lineHeight: "1.25rem",
    color: "rgba(255, 255, 255, 0.45)",
  },
  /**
   * One row per map, over the hero. The rows share the welcome buttons'
   * glass treatment rather than the map gallery's cards: this is the same
   * surface the user just pressed "Continue locally" on.
   */
  mapList: {
    display: "grid",
    gap: space.md,
    marginTop: "2rem",
  },
  mapRow: {
    display: "flex",
    alignItems: "center",
    gap: space.lg,
    paddingInline: space.lg,
    paddingBlock: space.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderRadius: radii.none,
    transitionProperty: "color, background-color, border-color",
    transitionDuration: "150ms",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
  },
  mapRowIdle: {
    cursor: "pointer",
    borderColor: {
      default: "rgba(255, 255, 255, 0.14)",
      ":hover": "rgba(255, 255, 255, 0.3)",
    },
    backgroundColor: "rgba(255, 255, 255, 0.04)",
  },
  mapRowSelected: {
    cursor: "pointer",
    borderColor: "rgba(232, 224, 68, 0.7)",
    backgroundColor: "rgba(232, 224, 68, 0.08)",
  },
  /** The public map: not a choice, so no pointer affordance. */
  mapRowIncluded: {
    borderColor: "rgba(232, 224, 68, 0.7)",
    backgroundColor: "rgba(232, 224, 68, 0.08)",
  },
  mapRowLocked: {
    cursor: "not-allowed",
    borderColor: "rgba(255, 255, 255, 0.08)",
    backgroundColor: "rgba(255, 255, 255, 0.02)",
    opacity: 0.55,
  },
  mapRowControl: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: "1.25rem",
    height: "1.25rem",
  },
  mapRowThumbnail: {
    display: "block",
    flexShrink: 0,
    width: "4rem",
    aspectRatio: "16 / 9",
    overflow: "hidden",
    backgroundColor: "rgba(0, 0, 0, 0.4)",
  },
  thumbnailImage: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
  },
  mapRowMeta: {
    display: "flex",
    flexShrink: 0,
    flexDirection: "column",
    alignItems: "flex-end",
    gap: space.xxs,
  },
  includedTag: {
    fontFamily: text.fontMeta,
    fontSize: "9px",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: colors.accent,
  },
  lockedTag: {
    fontFamily: text.fontMeta,
    fontSize: "9px",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: "rgba(255, 255, 255, 0.5)",
  },
  checkbox: {
    width: "1rem",
    height: "1rem",
    accentColor: colors.accent,
  },
  mapCardText: {
    minWidth: 0,
    flex: 1,
  },
  mapCardLabel: {
    display: "block",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "0.875rem",
    lineHeight: "1.25rem",
    fontWeight: 500,
    color: "rgba(255, 255, 255, 0.9)",
  },
  mapCardLocality: {
    display: "block",
    marginTop: space.xxs,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    color: "rgba(255, 255, 255, 0.45)",
  },
  mapCardSize: {
    fontFamily: text.fontMono,
    fontSize: "11px",
    color: "rgba(255, 255, 255, 0.5)",
  },

  /* ── Graphics level ────────────────────────────────────────────── */
  qualityField: {
    marginTop: "2rem",
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
    gridTemplateColumns: { default: "repeat(2, minmax(0, 1fr))", "@media (min-width: 640px)": "repeat(4, minmax(0, 1fr))" },
    gap: space.sm,
    marginTop: space.md,
  },
  qualitySegment: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: space.xxs,
    minHeight: "2.75rem",
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
  recommendedTag: {
    fontFamily: text.fontMeta,
    fontSize: "8px",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    opacity: 0.8,
  },
  qualityGuidance: {
    marginTop: space.md,
    fontSize: "0.75rem",
    lineHeight: "1.25rem",
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
    marginTop: space.xl,
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

/** Install rows, as the onboarding screen shows them. */
export const installRows = stylex.create({
  list: {
    display: "grid",
    gap: space.md,
    marginTop: space.xxxl,
  },
  row: {
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "rgba(255,255,255,0.1)",
    borderRadius: radii.none,
    backgroundColor: "rgba(255, 255, 255, 0.03)",
    paddingInline: space.xl,
    paddingBlock: space.lg,
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
 * The animated hero layer. Everything here is decoration behind the copy: the
 * gradient the server paints, the two masked scene slots, and the two scrims
 * that hold the scene down far enough for body text to stay readable.
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
  skyMask: {
    maskImage: "linear-gradient(202deg, black 0%, black 50%, transparent 72%)",
    WebkitMaskImage: "linear-gradient(202deg, black 0%, black 50%, transparent 72%)",
  },
  groundMask: {
    maskImage: "linear-gradient(202deg, transparent 46%, black 68%, black 100%)",
    WebkitMaskImage: "linear-gradient(202deg, transparent 46%, black 68%, black 100%)",
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
