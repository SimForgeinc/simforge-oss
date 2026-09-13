/**
 * StyleX styles for the first-run onboarding screens.
 *
 * Onboarding is the one place in Studio that is not instrument chrome: it is a
 * marketing-adjacent surface with its own near-black canvas (`#050607`) and the
 * teal hero palette the download page promised. Those two colours are the
 * screen's own art direction rather than product tokens, so they stay literal
 * here; everything that belongs to the product — the accent, the type scale,
 * the spacing rhythm, the destructive colour — comes from the shared tokens.
 *
 * Radii are deliberately `radii.none` throughout: the product's radius scale
 * resolves every step to `0`, so the `rounded-2xl`/`rounded-full` utilities
 * these screens were written with never rounded anything. Naming the zero is
 * how that stays true when someone reads the style object instead of the
 * Tailwind config.
 */

import * as stylex from "@stylexjs/stylex";

import { colors, radii, space, text } from "../stylex/tokens.stylex";

/** The onboarding canvas, shared by both screens and the route layout. */
export const CANVAS = "#050607";

/**
 * Custom property carrying a single install row's completed fraction as a
 * percentage string. One static class paints every row; only this variable
 * changes per render.
 */
export const PROGRESS_VAR = "--onboarding-progress";

/** Teal hero wash behind the map picker. The welcome screen animates instead. */
const MAP_CANVAS_GRADIENT =
  "radial-gradient(120% 90% at 78% -10%, #153c4e 0%, #0b1a24 45%, #050607 100%)";

const spin = stylex.keyframes({
  from: { transform: "rotate(0deg)" },
  to: { transform: "rotate(360deg)" },
});

export const onboarding = stylex.create({
  /* ── Screen shells ─────────────────────────────────────────────── */
  welcomeScreen: {
    position: "relative",
    display: "grid",
    placeItems: "center",
    minHeight: "100svh",
    overflow: "hidden",
    backgroundColor: CANVAS,
    paddingInline: space.xxl,
    paddingBlock: "3rem",
    color: "#ffffff",
  },
  mapScreen: {
    position: "relative",
    minHeight: "100svh",
    overflow: "hidden",
    backgroundColor: CANVAS,
    backgroundImage: MAP_CANVAS_GRADIENT,
    paddingInline: { default: space.xxl, "@media (min-width: 640px)": "2.5rem" },
    paddingBlock: "2.5rem",
    color: "#ffffff",
  },
  welcomeColumn: {
    position: "relative",
    zIndex: 10,
    width: "100%",
    maxWidth: "42rem",
  },
  mapColumns: {
    position: "relative",
    zIndex: 10,
    display: "grid",
    gap: space.xxxl,
    width: "100%",
    maxWidth: "72rem",
    marginInline: "auto",
    gridTemplateColumns: {
      default: null,
      "@media (min-width: 1024px)": "minmax(0, 1fr) 20rem",
    },
  },
  sidebar: {
    position: { default: null, "@media (min-width: 1024px)": "sticky" },
    top: { default: null, "@media (min-width: 1024px)": "2.5rem" },
    alignSelf: { default: null, "@media (min-width: 1024px)": "start" },
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
  welcomeTitle: {
    marginTop: space.lg,
    fontSize: { default: "2.25rem", "@media (min-width: 640px)": "3rem" },
    lineHeight: { default: "2.5rem", "@media (min-width: 640px)": 1 },
    fontWeight: 600,
    letterSpacing: "-0.025em",
  },
  mapTitle: {
    marginTop: space.md,
    fontSize: "1.875rem",
    lineHeight: "2.25rem",
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
  mapLede: {
    marginTop: space.md,
    maxWidth: "42rem",
    fontSize: "0.875rem",
    lineHeight: "1.5rem",
    color: "rgba(255, 255, 255, 0.55)",
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
  qualityFootnote: {
    marginTop: space.lg,
    fontSize: "11px",
    lineHeight: "1rem",
    color: colors.textFaint,
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

  /* ── Signed-out notice ─────────────────────────────────────────── */
  lockedNotice: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space.lg,
    marginTop: "1.25rem",
    paddingInline: space.xl,
    paddingBlock: space.lg,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "rgba(255,255,255,0.1)",
    borderRadius: radii.none,
    backgroundColor: "rgba(255, 255, 255, 0.03)",
  },
  lockedNoticeText: {
    minWidth: 0,
    flex: 1,
    fontSize: "0.75rem",
    lineHeight: "1.25rem",
    color: "rgba(255, 255, 255, 0.55)",
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
  mapGrid: {
    display: "grid",
    gap: space.lg,
    marginTop: space.xxl,
    gridTemplateColumns: {
      default: null,
      "@media (min-width: 640px)": "repeat(2, minmax(0, 1fr))",
      "@media (min-width: 1280px)": "repeat(3, minmax(0, 1fr))",
    },
  },
  mapCard: {
    display: "flex",
    height: "100%",
    flexDirection: "column",
    overflow: "hidden",
    borderWidth: 1,
    borderStyle: "solid",
    borderRadius: radii.none,
    transitionProperty: "color, background-color, border-color",
    transitionDuration: "150ms",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
  },
  mapCardIdle: {
    cursor: "pointer",
    borderColor: {
      default: colors.line,
      ":hover": "rgba(255, 255, 255, 0.2)",
    },
    backgroundColor: "rgba(255, 255, 255, 0.03)",
  },
  mapCardSelected: {
    cursor: "pointer",
    borderColor: "rgba(232, 224, 68, 0.7)",
    backgroundColor: "rgba(232, 224, 68, 0.06)",
  },
  mapCardLocked: {
    cursor: "not-allowed",
    borderColor: "rgba(255, 255, 255, 0.05)",
    backgroundColor: "rgba(255, 255, 255, 0.02)",
    opacity: 0.45,
  },
  thumbnail: {
    position: "relative",
    display: "block",
    aspectRatio: "16 / 9",
    overflow: "hidden",
    backgroundColor: "rgba(0, 0, 0, 0.4)",
  },
  thumbnailImage: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
  },
  lockedVeil: {
    position: "absolute",
    inset: 0,
    display: "grid",
    placeItems: "center",
    backgroundColor: "rgba(0, 0, 0, 0.55)",
  },
  lockedVeilLabel: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    fontSize: "11px",
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: "rgba(255, 255, 255, 0.8)",
  },
  mapCardBody: {
    display: "flex",
    flex: 1,
    alignItems: "flex-start",
    gap: space.lg,
    paddingInline: space.xl,
    paddingBlock: space.lg,
  },
  checkbox: {
    marginTop: space.xs,
    width: "1rem",
    height: "1rem",
    accentColor: colors.accent,
  },
  radio: {
    marginTop: space.xs,
    width: "0.875rem",
    height: "0.875rem",
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
    color: "rgba(255, 255, 255, 0.85)",
  },
  mapCardLocality: {
    display: "block",
    marginTop: space.xxs,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    color: "rgba(255, 255, 255, 0.4)",
  },
  mapCardSize: {
    fontFamily: text.fontMono,
    fontSize: "11px",
    color: "rgba(255, 255, 255, 0.45)",
  },

  /* ── Graphics level ────────────────────────────────────────────── */
  legend: {
    fontFamily: text.fontMeta,
    fontSize: "9px",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaWider,
    color: "rgba(255, 255, 255, 0.4)",
  },
  qualityList: {
    display: "grid",
    gap: space.md,
    marginTop: space.lg,
  },
  qualityOption: {
    display: "flex",
    alignItems: "flex-start",
    gap: space.lg,
    cursor: "pointer",
    paddingInline: space.lg,
    paddingBlock: "0.625rem",
    borderWidth: 1,
    borderStyle: "solid",
    borderRadius: radii.none,
    transitionProperty: "color, background-color, border-color",
    transitionDuration: "150ms",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
  },
  qualityOptionIdle: {
    borderColor: {
      default: colors.line,
      ":hover": "rgba(255, 255, 255, 0.2)",
    },
    backgroundColor: "rgba(255, 255, 255, 0.03)",
  },
  qualityOptionSelected: {
    borderColor: "rgba(232, 224, 68, 0.7)",
    backgroundColor: "rgba(232, 224, 68, 0.06)",
  },
  qualityLabel: {
    display: "flex",
    alignItems: "center",
    gap: space.md,
    fontSize: "0.875rem",
    lineHeight: "1.25rem",
    fontWeight: 500,
    color: "rgba(255, 255, 255, 0.85)",
  },
  recommendedTag: {
    fontFamily: text.fontMeta,
    fontSize: "9px",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: colors.accent,
  },
  qualityGuidance: {
    display: "block",
    marginTop: space.xxs,
    fontSize: "11px",
    lineHeight: "1rem",
    color: "rgba(255, 255, 255, 0.4)",
  },

  /* ── Disk summary ──────────────────────────────────────────────── */
  summary: {
    display: "grid",
    gap: space.md,
    marginTop: space.xxl,
    paddingTop: space.xl,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: colors.line,
    fontSize: "0.75rem",
    lineHeight: "1rem",
  },
  summaryRow: {
    display: "flex",
    justifyContent: "space-between",
    gap: space.lg,
  },
  summaryTerm: {
    color: "rgba(255, 255, 255, 0.4)",
  },
  summaryValue: {
    fontFamily: text.fontMono,
    color: "rgba(255, 255, 255, 0.8)",
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
  /* ── Icons and download action ─────────────────────────────────── */
  icon: {
    width: "1rem",
    height: "1rem",
  },
  /** Only the locked-notice `Lock` carried `shrink-0` at baseline. */
  iconNoShrink: {
    flexShrink: 0,
  },
  iconSmall: {
    width: "0.875rem",
    height: "0.875rem",
  },
  iconWarning: {
    color: "#E8E044",
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
  downloadAction: {
    marginTop: space.lg,
    width: "100%",
    height: "3rem",
    borderRadius: radii.full,
    backgroundColor: "#E8E044",
    color: "#000000",
    ":hover": { backgroundColor: "rgba(232, 224, 68, 0.85)" },
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
