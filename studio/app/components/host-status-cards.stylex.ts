/**
 * StyleX styles for the two "what is this installation" cards: the local
 * execution card (what runs on this computer) and the SimCloud connection card
 * (the optional account), plus the account segments of the app switcher's
 * bar. They share a header shape — icon, eyebrow, title, lede, a definition
 * list of facts, then an action row — so the shared half lives in {@link card}
 * and each card keeps only what is genuinely its own.
 *
 * Radii are written as tokens to record intent; `styles.css` enforces
 * `border-radius: 0 !important` globally, so none of them round anything.
 *
 * Accent alphas are mixed from `colors.accent` rather than written as
 * `rgba(232, 224, 68, …)`: mixing with `transparent` in sRGB is exact, so the
 * pixels are unchanged and the brand colour still has one definition.
 *
 * The Button roots are StyleX-backed. Icon-level size/pointer-event selectors
 * remain in Button's documented compatibility bridge because the component
 * accepts arbitrary child SVGs and cannot style them through inherited values.
 */
import * as stylex from "@stylexjs/stylex";
import { colors, layers, layout, motion, space, stroke, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

/** `sm:` — the one breakpoint these cards respond to. */
const SM = "@media (min-width: 640px)";

/** `animate-spin`: Tailwind's one-revolution-per-second loader turn. */
const spin = stylex.keyframes({
  from: { transform: "rotate(0deg)" },
  to: { transform: "rotate(360deg)" },
});

/** `animate-pulse`: Tailwind's opacity breath, used by the connecting lamp. */
const pulse = stylex.keyframes({
  "0%, 100%": { opacity: 1 },
  "50%": { opacity: 0.5 },
});

/** `transition-colors`: Tailwind's colour property list, kept identical. */
const COLOR_TRANSITION =
  "color, background-color, border-color, text-decoration-color, fill, stroke";

/** `focus-visible:ring-2 ring-[#E8E044]` with the default zero ring offset. */
const ACCENT_RING = `0 0 0 2px ${colors.accent}`;
const ACCENT_RING_INSET = `inset 0 0 0 2px ${colors.accent}`;
const XL = "@media (min-width: 1200px)";

/** `bg-[#E8E044]/10`, `border-[#E8E044]/30`, and the connected glow. */
const ACCENT_10 = `color-mix(in srgb, ${colors.accent} 10%, transparent)`;
const ACCENT_30 = `color-mix(in srgb, ${colors.accent} 30%, transparent)`;
const ACCENT_GLOW = `0 0 14px color-mix(in srgb, ${colors.accent} 35%, transparent)`;

/**
 * Caution amber. Not `colors.danger`: an expired session and a credential
 * vault that is missing are warnings about what is *locked*, not failures, and
 * they are the same amber in both themes for that reason.
 */
const AMBER_400 = "#fbbf24";
const AMBER_400_30 = "rgba(251, 191, 36, 0.3)";
const AMBER_400_10 = "rgba(251, 191, 36, 0.1)";
const AMBER_300_90 = "rgba(252, 211, 77, 0.9)";

/** The shared card shell: header block, instrument type, action row. */
export const card = stylex.create({
  // text-white — the cards sit on the dashboard's near-black plate.
  section: {
    color: colors.ink,
  },
  // flex items-start gap-3
  header: {
    display: "flex",
    alignItems: "flex-start",
    gap: space.s3,
  },
  // grid size-10 shrink-0 place-items-center text-[#E8E044]
  icon: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: "2.5rem",
    height: "2.5rem",
    color: colors.accent,
  },
  // min-w-0 flex-1
  body: {
    minWidth: 0,
    flex: 1,
  },
  // font-meta text-[9px] font-bold uppercase tracking-[0.16em] text-white/40
  eyebrow: {
    fontFamily: text.fontMeta,
    fontSize: "9px",
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaWide,
    color: "rgba(255, 255, 255, 0.4)",
  },
  // mt-1 text-lg font-semibold
  title: {
    marginTop: space.s1,
    fontSize: text.sizeLg,
    lineHeight: text.lineLg,
    fontWeight: text.weightSemibold,
  },
  // ml-2 font-mono text-xs font-normal text-white/40
  titleVersion: {
    marginLeft: space.s2,
    fontFamily: text.fontMono,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    fontWeight: text.weightNormal,
    color: "rgba(255, 255, 255, 0.4)",
  },
  // mt-2 text-sm leading-6 text-white/55
  lede: {
    marginTop: space.s2,
    fontSize: text.sizeSm,
    lineHeight: text.lineBase,
    color: "rgba(255, 255, 255, 0.55)",
  },
  // font-mono
  mono: {
    fontFamily: text.fontMono,
  },
  // shrink-0 font-meta text-[9px] font-bold uppercase tracking-[0.14em] text-white/30
  //
  // The instrument caption on every fact in both cards. Tracked well past the
  // usual ceiling because the meta face is only legible uppercase that wide.
  factLabel: {
    flexShrink: 0,
    fontFamily: text.fontMeta,
    fontSize: "9px",
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: "rgba(255, 255, 255, 0.3)",
  },
  // mt-5 flex flex-wrap items-center gap-2
  actions: {
    marginTop: space.s5,
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space.s2,
  },
});

/** Card-specific action controls, replacing the remaining caller utilities. */
export const action = stylex.create({
  // h-10 gap-2 rounded-full border-white/15 bg-transparent text-white hover:bg-white/5
  outline: {
    height: "2.5rem",
    gap: space.s2,
    borderColor: "rgba(255, 255, 255, 0.15)",
    backgroundColor: { default: "transparent", ":hover": "rgba(255, 255, 255, 0.05)" },
    color: colors.ink,
  },
  // h-9 gap-2 rounded-full bg-amber-300 text-black hover:bg-amber-200
  amber: {
    height: "2.25rem",
    gap: space.s2,
    backgroundColor: { default: "#fcd34d", ":hover": "#fde68a" },
    color: "#000000",
  },
  // size-4
  icon: {
    width: "1rem",
    height: "1rem",
  },
  // animate-spin
  spin: {
    animationName: { default: spin, [layout.reducedMotion]: "none" },
    animationDuration: motion.durSpin,
    animationTimingFunction: motion.easeLinear,
    animationIterationCount: "infinite",
  },
});

/**
 * The connection lamp, one variant per connection state. A variant rather than
 * a colour threaded through the component: the states are a closed set, and
 * only `connecting` animates.
 */
export const lamp = stylex.create({
  // size-2 shrink-0 rounded-sm
  base: {
    width: "0.5rem",
    height: "0.5rem",
    flexShrink: 0,
  },
  // bg-[#E8E044] shadow-[0_0_14px_rgba(232,224,68,0.35)]
  connected: {
    backgroundColor: colors.accent,
    boxShadow: ACCENT_GLOW,
  },
  // bg-sky-300 animate-pulse — still waiting on the browser, so it breathes.
  connecting: {
    backgroundColor: "#7dd3fc",
    animationName: { default: pulse, [layout.reducedMotion]: "none" },
    animationDuration: motion.durPulse,
    animationTimingFunction: motion.easePulse,
    animationIterationCount: "infinite",
  },
  // bg-amber-400 — expired or errored: something is locked, nothing is broken.
  attention: {
    backgroundColor: AMBER_400,
  },
  // bg-white/25
  idle: {
    backgroundColor: "rgba(255, 255, 255, 0.25)",
  },
});

/**
 * The SimCloud sign-out confirmation, which every surface that can sign out
 * shares. Sign-out locks account-only maps, so it always asks first.
 */
export const cloud = stylex.create({
  // flex w-full flex-col gap-3 rounded-2xl border border-amber-400/30 bg-amber-400/10 p-4
  confirm: {
    display: "flex",
    width: "100%",
    flexDirection: "column",
    gap: space.s3,
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: AMBER_400_30,
    backgroundColor: AMBER_400_10,
    padding: space.s4,
  },
  // text-sm font-semibold
  confirmTitle: {
    fontSize: text.sizeSm,
    lineHeight: text.lineSm,
    fontWeight: text.weightSemibold,
  },
  // text-xs leading-5 text-white/60
  confirmDetail: {
    fontSize: text.sizeXs,
    lineHeight: text.lineSm,
    color: "rgba(255, 255, 255, 0.6)",
  },
  // flex gap-2
  confirmActions: {
    display: "flex",
    gap: space.s2,
  },
});

/**
 * The app-switcher bar segments: workspace, account or SimCloud connection,
 * each a full-height cell of the switcher's one bar, divided from its
 * neighbour by a hairline rather than framed as a card of its own.
 */
export const chip = stylex.create({
  root: {
    display: "flex",
    // Stacked below XL the segments share their row evenly.
    flex: { default: "1 1 0", [XL]: "0 1 auto" },
    minWidth: 0,
    alignItems: "center",
    gap: space.s2_5,
    paddingInlineStart: space.s3_5,
    borderWidth: 0,
    borderStyle: "solid",
    borderColor: colors.hairline,
    // Stacked below XL the first segment starts at the frame's own edge.
    borderInlineStartWidth: { default: stroke.hairline, ":first-child": { default: 0, [XL]: stroke.hairline } },
  },
  /** A segment that is itself a button (the workspace menu trigger). */
  trigger: {
    paddingInlineEnd: space.s3_5,
    backgroundColor: { default: "transparent", ":hover": colors.fillSubtle },
    color: "inherit",
    textAlign: "left",
    cursor: "pointer",
    outlineWidth: { default: null, ":focus-visible": stroke.thick },
    outlineStyle: { default: null, ":focus-visible": "solid" },
    outlineColor: { default: null, ":focus-visible": "transparent" },
    outlineOffset: { default: null, ":focus-visible": "-2px" },
    boxShadow: { default: null, ":focus-visible": ACCENT_RING_INSET },
    opacity: { default: null, ":disabled": 0.6 },
  },
  body: {
    display: "grid",
    minWidth: 0,
    flex: { default: "1 1 auto", [XL]: "0 1 auto" },
  },
  eyebrow: {
    fontFamily: text.fontMeta,
    fontSize: "8px",
    lineHeight: "0.75rem",
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaWide,
    color: colors.inkFaint,
  },
  summary: {
    maxWidth: "11rem",
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    fontWeight: text.weightSemibold,
    color: "rgba(255, 255, 255, 0.85)",
  },
  chevron: {
    width: "0.875rem",
    height: "0.875rem",
    flexShrink: 0,
    color: colors.inkMuted,
  },
  /** A segment's menu: above the switcher overlay, which is itself above dialogs. */
  menu: { zIndex: layers.appSwitcherTop, minWidth: "14rem" },
  /** The menu's header: who, then where or how. */
  menuName: {
    display: "block",
    fontSize: text.sizeSm,
    lineHeight: text.lineSm,
    fontWeight: text.weightSemibold,
  },
  menuMeta: {
    display: "block",
    fontSize: "11px",
    lineHeight: text.lineXs,
    fontWeight: text.weightNormal,
    color: "rgba(255, 255, 255, 0.5)",
  },
  menuIcon: { width: "0.875rem", height: "0.875rem", flexShrink: 0, marginInlineEnd: space.s2 },
});

/** The local execution card. */
export const local = stylex.create({
  // mt-3 divide-y divide-white/[0.06] — the rule belongs to the rows below.
  facts: {
    marginTop: space.s3,
  },
  /**
   * One fact row, and the `divide-y` hairline that separates it from the row
   * above. Tailwind's divider is a `* + *` child rule, which StyleX cannot
   * express; the border lives on the row and the first one drops it, which is
   * the same result for any arrangement of children.
   */
  // flex min-w-0 gap-3 py-1.5
  row: {
    display: "flex",
    minWidth: 0,
    gap: space.s3,
    paddingBlock: space.s1_5,
    borderTopWidth: { default: stroke.hairline, ":first-child": 0 },
    borderTopStyle: "solid",
    borderTopColor: "rgba(255, 255, 255, 0.06)",
  },
  // w-32 leading-5 — the fact captions share one measure so the values line up.
  rowLabel: {
    width: "8rem",
    lineHeight: text.lineSm,
  },
  // min-w-0 text-xs text-white/75, wrapping mid-token where it must.
  rowValue: {
    minWidth: 0,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: "rgba(255, 255, 255, 0.75)",
    // Paths, digests and target triples have no spaces to break at.
    overflowWrap: "anywhere",
  },
  // flex min-w-0 flex-wrap items-center gap-2 text-xs text-white/75
  rowValueWrap: {
    display: "flex",
    minWidth: 0,
    flexWrap: "wrap",
    alignItems: "center",
    gap: space.s2,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: "rgba(255, 255, 255, 0.75)",
  },
  // text-white/45 — why the renderer is not on offer, in the host's words.
  rowNote: {
    color: colors.inkMuted,
  },
  // py-1.5, sharing the divider above.
  reasonsRow: {
    paddingBlock: space.s1_5,
    borderTopWidth: { default: stroke.hairline, ":first-child": 0 },
    borderTopStyle: "solid",
    borderTopColor: "rgba(255, 255, 255, 0.06)",
  },
  // list-disc pl-5 text-xs text-amber-300/90
  reasons: {
    listStyleType: "disc",
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
    paddingLeft: space.s5,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: AMBER_300_90,
  },
  // space-y-1, as a per-item rule for the same reason `divide-y` became one.
  reason: {
    marginTop: { default: space.s1, ":first-child": 0 },
  },
  // mt-3 border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive
  error: {
    marginTop: space.s3,
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: "hsl(var(--destructive) / 0.4)",
    backgroundColor: "hsl(var(--destructive) / 0.1)",
    padding: space.s3,
    fontSize: text.sizeSm,
    lineHeight: text.lineSm,
    color: colors.danger,
  },
  // mt-3 flex items-center gap-2 text-xs text-white/45
  probing: {
    marginTop: space.s3,
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.inkMuted,
  },
  // size-3.5 animate-spin
  probingSpinner: {
    width: "0.875rem",
    height: "0.875rem",
    animationName: { default: spin, [layout.reducedMotion]: "none" },
    animationDuration: motion.durSpin,
    animationTimingFunction: motion.easeLinear,
    animationIterationCount: "infinite",
  },
});

/** The ready/not-ready badge on the local render row. */
export const readyPill = stylex.create({
  // inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5
  // font-meta text-[8px] font-bold uppercase tracking-[0.13em]
  base: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1_5,
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    paddingInline: space.s2,
    paddingBlock: space.s0_5,
    fontFamily: text.fontMeta,
    fontSize: "8px",
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    letterSpacing: "0.13em",
  },
  // border-[#E8E044]/30 bg-[#E8E044]/10 text-[#E8E044]
  ready: {
    borderColor: ACCENT_30,
    backgroundColor: ACCENT_10,
    color: colors.accent,
  },
  // border-white/10 text-white/45
  notReady: {
    borderColor: "rgba(255, 255, 255, 0.1)",
    color: colors.inkMuted,
  },
  // size-1.5 rounded-sm
  dot: {
    width: "0.375rem",
    height: "0.375rem",
  },
  // bg-[#E8E044]
  dotReady: {
    backgroundColor: colors.accent,
  },
  // bg-white/30
  dotNotReady: {
    backgroundColor: "rgba(255, 255, 255, 0.3)",
  },
});
