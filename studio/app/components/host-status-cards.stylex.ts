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
import { colors, layers, radii, space, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

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

/** The switcher bar's divider hairline, and the width its segments go one-line at. */
const BAR_HAIRLINE = "rgba(255, 255, 255, 0.08)";
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
    color: "#ffffff",
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
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaWide,
    color: "rgba(255, 255, 255, 0.4)",
  },
  // mt-1 text-lg font-semibold
  title: {
    marginTop: "0.25rem",
    fontSize: text.sizeLg,
    lineHeight: "1.75rem",
    fontWeight: 600,
  },
  // flex items-center gap-2 — the cloud title carries its state lamp inline.
  titleRow: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
  },
  // ml-2 font-mono text-xs font-normal text-white/40
  titleVersion: {
    marginLeft: space.s2,
    fontFamily: text.fontMono,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    fontWeight: 400,
    color: "rgba(255, 255, 255, 0.4)",
  },
  // mt-2 text-sm leading-6 text-white/55
  lede: {
    marginTop: "0.5rem",
    fontSize: text.sizeSm,
    lineHeight: "1.5rem",
    color: "rgba(255, 255, 255, 0.55)",
  },
  // truncate
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
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
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: "rgba(255, 255, 255, 0.3)",
  },
  // mt-5 flex flex-wrap items-center gap-2
  actions: {
    marginTop: "1.25rem",
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
    borderRadius: radii.full,
    borderColor: "rgba(255, 255, 255, 0.15)",
    backgroundColor: { default: "transparent", ":hover": "rgba(255, 255, 255, 0.05)" },
    color: "#ffffff",
  },
  // h-10 gap-2 rounded-full bg-[#E8E044] text-black hover:bg-[#f1ea55]
  accent: {
    height: "2.5rem",
    gap: space.s2,
    borderRadius: radii.full,
    backgroundColor: { default: colors.accent, ":hover": colors.accentHover },
    color: "#000000",
  },
  // Accent connect action with the caller's disabled opacity.
  accentConnect: {
    height: "2.5rem",
    gap: space.s2,
    borderRadius: radii.full,
    backgroundColor: { default: colors.accent, ":hover": colors.accentHover },
    color: "#000000",
    opacity: { default: null, ":disabled": 0.6 },
  },
  // h-9 gap-2 rounded-full bg-amber-300 text-black hover:bg-amber-200
  amber: {
    height: "2.25rem",
    gap: space.s2,
    borderRadius: radii.full,
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
    animationName: { default: spin, "@media (prefers-reduced-motion: reduce)": "none" },
    animationDuration: "1s",
    animationTimingFunction: "linear",
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
    borderRadius: radii.sm,
  },
  // bg-[#E8E044] shadow-[0_0_14px_rgba(232,224,68,0.35)]
  connected: {
    backgroundColor: colors.accent,
    boxShadow: ACCENT_GLOW,
  },
  // bg-sky-300 animate-pulse — still waiting on the browser, so it breathes.
  connecting: {
    backgroundColor: "#7dd3fc",
    animationName: { default: pulse, "@media (prefers-reduced-motion: reduce)": "none" },
    animationDuration: "2s",
    animationTimingFunction: "cubic-bezier(0.4, 0, 0.6, 1)",
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
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: AMBER_400_30,
    borderRadius: radii.xl,
    backgroundColor: AMBER_400_10,
    padding: space.s4,
  },
  // text-sm font-semibold
  confirmTitle: {
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    fontWeight: 600,
  },
  // text-xs leading-5 text-white/60
  confirmDetail: {
    fontSize: text.sizeXs,
    lineHeight: "1.25rem",
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
    gap: "0.625rem",
    paddingInlineStart: "0.875rem",
    borderWidth: 0,
    borderStyle: "solid",
    borderColor: BAR_HAIRLINE,
    // Stacked below XL the first segment starts at the frame's own edge.
    borderInlineStartWidth: { default: 1, ":first-child": { default: 0, [XL]: 1 } },
  },
  /** A segment that is itself a button (the workspace menu trigger). */
  trigger: {
    paddingInlineEnd: "0.875rem",
    backgroundColor: { default: "transparent", ":hover": "rgba(255, 255, 255, 0.04)" },
    color: "inherit",
    textAlign: "left",
    cursor: "pointer",
    transitionProperty: COLOR_TRANSITION,
    transitionDuration: "150ms",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    outlineWidth: { default: null, ":focus-visible": "2px" },
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
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaWide,
    color: "rgba(255, 255, 255, 0.35)",
  },
  summary: {
    maxWidth: "11rem",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    fontWeight: 600,
    color: "rgba(255, 255, 255, 0.85)",
  },
  chevron: {
    width: "0.875rem",
    height: "0.875rem",
    flexShrink: 0,
    color: "rgba(255, 255, 255, 0.45)",
  },
  /** A segment's menu: above the switcher overlay, which is itself above dialogs. */
  menu: { zIndex: layers.appSwitcherTop, minWidth: "14rem" },
  /** The menu's header: who, then where or how. */
  menuName: {
    display: "block",
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    fontWeight: 600,
  },
  menuMeta: {
    display: "block",
    fontSize: "11px",
    lineHeight: "1rem",
    fontWeight: 400,
    color: "rgba(255, 255, 255, 0.5)",
  },
  menuIcon: { width: "0.875rem", height: "0.875rem", flexShrink: 0, marginInlineEnd: "0.5rem" },
});

/** The local execution card. */
export const local = stylex.create({
  // mt-3 divide-y divide-white/[0.06] — the rule belongs to the rows below.
  facts: {
    marginTop: "0.75rem",
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
    paddingBlock: "0.375rem",
    borderTopWidth: { default: 1, ":first-child": 0 },
    borderTopStyle: "solid",
    borderTopColor: "rgba(255, 255, 255, 0.06)",
  },
  // w-32 leading-5 — the fact captions share one measure so the values line up.
  rowLabel: {
    width: "8rem",
    lineHeight: "1.25rem",
  },
  // min-w-0 text-xs text-white/75, wrapping mid-token where it must.
  rowValue: {
    minWidth: 0,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
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
    lineHeight: "1rem",
    color: "rgba(255, 255, 255, 0.75)",
  },
  // text-white/45 — why the renderer is not on offer, in the host's words.
  rowNote: {
    color: "rgba(255, 255, 255, 0.45)",
  },
  // py-1.5, sharing the divider above.
  reasonsRow: {
    paddingBlock: "0.375rem",
    borderTopWidth: { default: 1, ":first-child": 0 },
    borderTopStyle: "solid",
    borderTopColor: "rgba(255, 255, 255, 0.06)",
  },
  // list-disc pl-5 text-xs text-amber-300/90
  reasons: {
    listStyleType: "disc",
    display: "flex",
    flexDirection: "column",
    gap: "0.25rem",
    paddingLeft: "1.25rem",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: AMBER_300_90,
  },
  // space-y-1, as a per-item rule for the same reason `divide-y` became one.
  reason: {
    marginTop: { default: space.s1, ":first-child": 0 },
  },
  // mt-3 border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive
  error: {
    marginTop: "0.75rem",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "hsl(var(--destructive) / 0.4)",
    backgroundColor: "hsl(var(--destructive) / 0.1)",
    padding: "0.75rem",
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    color: colors.danger,
  },
  // mt-3 flex items-center gap-2 text-xs text-white/45
  probing: {
    marginTop: "0.75rem",
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: "rgba(255, 255, 255, 0.45)",
  },
  // size-3.5 animate-spin
  probingSpinner: {
    width: "0.875rem",
    height: "0.875rem",
    animationName: { default: spin, "@media (prefers-reduced-motion: reduce)": "none" },
    animationDuration: "1s",
    animationTimingFunction: "linear",
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
    borderWidth: 1,
    borderStyle: "solid",
    borderRadius: radii.full,
    paddingInline: space.s2,
    paddingBlock: "0.125rem",
    fontFamily: text.fontMeta,
    fontSize: "8px",
    fontWeight: 700,
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
    color: "rgba(255, 255, 255, 0.45)",
  },
  // size-1.5 rounded-sm
  dot: {
    width: "0.375rem",
    height: "0.375rem",
    borderRadius: radii.sm,
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
