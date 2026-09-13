/**
 * Caller-side StyleX for the shared primitives the scenario surfaces drive.
 *
 * The list, rail, scene, dataset and review surfaces are still authored in
 * Tailwind, but the controls they hand their overrides to — `Button`,
 * `Badge`, `Input`, `WorkspacePaneLoading`, `CloudActivityIndicator` — are
 * compiled by StyleX. A StyleX atom is guarded by `:not(#\#)` three times over
 * and therefore outranks a plain utility class at every stylesheet position,
 * so an override passed as `className` is dropped rather than applied. These
 * keys are those overrides, restated so they can travel as `xstyle` and be
 * merged by StyleX in argument order.
 *
 * One module for five directories because the overrides are one vocabulary:
 * the same 28px icon button, the same top-bar toggle chip and the same
 * full-width accent footer button recur across the rails, the list and the
 * dataset detail view, and a copy per directory would let them drift.
 *
 * `rounded-full` / `rounded-none` are not translated. `styles.css` pins every
 * element to `border-radius: 0 !important` and the app's Tailwind config
 * resolves the whole radius scale to `0`, so both utilities were already
 * inert; carrying them over would be inventing a value, not preserving one.
 */
import * as stylex from "@stylexjs/stylex";
import { colors, layers, text } from "../stylex/tokens.stylex";

/** `hover:text-accent-foreground`, which `Button`'s ghost/outline variants own. */
const ACCENT_FOREGROUND = "hsl(var(--accent-foreground))";
/** Tailwind's `font-[Share_Tech_Mono,IBM_Plex_Mono,monospace]`. */
const CHIP_FONT = "Share Tech Mono, IBM Plex Mono, monospace";

/** Shared geometry and flat-background pieces the control keys compose with. */
export const control = stylex.create({
  /** `size-6` */
  iconXs: { width: "1.5rem", height: "1.5rem" },
  /** `size-7` */
  iconSm: { width: "1.75rem", height: "1.75rem" },
  /** `shrink-0` */
  noShrink: { flexShrink: 0 },
  /** `relative` */
  relative: { position: "relative" },
  /** `bg-transparent hover:bg-transparent` */
  flatBackground: { backgroundColor: { default: "transparent", ":hover": "transparent" } },
  /** `w-full` */
  fullWidth: { width: "100%" },
  /** `mt-1.5` */
  spaceAbove15: { marginTop: "0.375rem" },
  /** `mt-4` */
  spaceAbove4: { marginTop: "1rem" },
  /** `mt-5` */
  spaceAbove5: { marginTop: "1.25rem" },
});

/**
 * Overrides the scenario surfaces hand to `DropdownMenu`'s parts. The menu
 * compiles its own min-width, type scale and focus ink, so a wider menu or a
 * destructive row has to arrive as `xstyle`.
 */
export const menu = stylex.create({
  /** `min-w-[160px]` */
  width160: { minWidth: "160px" },
  /** `min-w-[210px]` */
  width210: { minWidth: "210px" },
  /** `min-w-[220px]` */
  width220: { minWidth: "220px" },
  /** `text-destructive focus:text-destructive` */
  destructiveItem: { color: { default: colors.danger, ":focus": colors.danger } },
  /** `font-meta text-micro uppercase tracking-meta` */
  metaItem: {
    fontFamily: text.fontMeta,
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
  },
  /** `font-meta text-micro uppercase tracking-meta-tight` */
  metaItemTight: {
    fontFamily: text.fontMeta,
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaTight,
  },
  /** `font-meta text-micro uppercase tracking-meta-wide text-muted-foreground` */
  metaLabel: {
    fontFamily: text.fontMeta,
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaWide,
    color: colors.mutedForeground,
  },
  /** `text-primary` on the selected row, over the menu's own focus ink. */
  selected: { color: { default: colors.primary, ":focus": colors.primary } },
});

/**
 * `WorkspacePaneLoading` declares its own `min-height: 5rem`; a pane that
 * reserves more room while it loads has to say so through `xstyle`.
 */
export const paneLoading = stylex.create({
  /** `min-h-24` */
  h24: { minHeight: "6rem" },
  /** `min-h-40` */
  h40: { minHeight: "10rem" },
  /** `min-h-52` */
  h52: { minHeight: "13rem" },
  /** `min-h-[420px]` */
  h420: { minHeight: "420px" },
});

/** `Button` overrides in `scenario/list`. */
export const list = stylex.create({
  /**
   * `h-9 w-full bg-transparent font-meta text-micro font-bold uppercase
   * tracking-meta-wide hover:bg-transparent hover:text-primary`
   */
  loadMore: {
    height: "2.25rem",
    width: "100%",
    backgroundColor: { default: "transparent", ":hover": "transparent" },
    fontFamily: text.fontMeta,
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaWide,
    color: { default: null, ":hover": colors.primary },
  },
  /**
   * `size-6 border-primary/40 text-primary` — the outline variant keeps its
   * own `hover:text-accent-foreground`, which the caller never displaced.
   */
  tagAdd: {
    width: "1.5rem",
    height: "1.5rem",
    borderColor: "hsl(var(--primary) / 0.4)",
    color: { default: colors.primary, ":hover": ACCENT_FOREGROUND },
  },
  /** `h-7 min-w-0 flex-1 px-2 text-meta` */
  tagNameInput: {
    height: "1.75rem",
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "0%",
    paddingInline: "0.5rem",
    fontSize: text.sizeMeta,
    lineHeight: text.lineMeta,
  },
  /** `h-7 border-primary/60 px-2 text-micro uppercase tracking-meta text-primary` */
  tagSubmit: {
    height: "1.75rem",
    borderColor: "hsl(var(--primary) / 0.6)",
    paddingInline: "0.5rem",
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: { default: colors.primary, ":hover": ACCENT_FOREGROUND },
  },
  /** `h-8 w-full justify-start px-3 text-xs` */
  allScenarios: {
    height: "2rem",
    width: "100%",
    justifyContent: "flex-start",
    paddingInline: "0.75rem",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
  },
  /** `h-9 pl-9` — the map search field, cleared of the leading icon. */
  mapSearchInput: { height: "2.25rem", paddingLeft: "2.25rem" },
  /**
   * `h-4 rounded-full border-red-400/40 bg-red-400/10 px-1.5 py-0 font-meta
   * text-[8px] uppercase tracking-meta-narrow text-red-300`
   */
  rejectedBadge: {
    height: "1rem",
    borderColor: "rgb(248 113 113 / 0.4)",
    backgroundColor: "rgb(248 113 113 / 0.1)",
    paddingInline: "0.375rem",
    paddingBlock: 0,
    fontFamily: text.fontMeta,
    fontSize: "8px",
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaNarrow,
    color: "rgb(252 165 165)",
  },
  /**
   * `h-9 px-4 font-meta text-micro font-bold uppercase tracking-meta
   * active:scale-[0.97]`
   */
  newDataset: {
    height: "2.25rem",
    paddingInline: "1rem",
    fontFamily: text.fontMeta,
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    transform: { default: null, ":active": "scale(0.97)" },
  },
  /** `w-full gap-2` on the `.xosc` file chooser. */
  fileChooser: { width: "100%", gap: "0.5rem" },
});

/** The row-level icon buttons in `ScenarioDocumentRow`. */
export const row = stylex.create({
  /** `text-foreground/65 hover:text-foreground` */
  quiet: { color: { default: "hsl(var(--foreground) / 0.65)", ":hover": colors.text } },
  /** `text-primary`, beside the row base's own `hover:text-foreground`. */
  activeInk: { color: { default: colors.primary, ":hover": colors.text } },
  /** `text-primary` where the ghost variant still supplies the hover ink. */
  accentInk: { color: { default: colors.primary, ":hover": ACCENT_FOREGROUND } },
  /**
   * `cursor-not-allowed opacity-50` — the hover ink is dropped by pairing this
   * with a `renderFlat*` key rather than by restating `hover:text-current`,
   * which is the same colour the element already carries.
   */
  disabled: { cursor: "not-allowed", opacity: 0.5 },
});

/**
 * The render button's traffic-light ink. Each state has a hover pair and a
 * flat one: when the button is disabled Tailwind's `hover:text-current`
 * collapsed the hover colour onto the resting colour, which in StyleX is
 * simply a key that declares no hover at all.
 */
export const renderInk = stylex.create({
  /** `text-red-300`, with the row base's `hover:text-foreground`. */
  active: { color: { default: "rgb(252 165 165)", ":hover": colors.text } },
  activeFlat: { color: "rgb(252 165 165)" },
  /** `text-yellow-400 hover:text-yellow-300` */
  running: { color: { default: "rgb(250 204 21)", ":hover": "rgb(253 224 71)" } },
  runningFlat: { color: "rgb(250 204 21)" },
  /** `text-green-400 hover:text-green-300` */
  complete: { color: { default: "rgb(74 222 128)", ":hover": "rgb(134 239 172)" } },
  completeFlat: { color: "rgb(74 222 128)" },
  /** `text-red-400 hover:text-red-300` */
  none: { color: { default: "rgb(248 113 113)", ":hover": "rgb(252 165 165)" } },
  noneFlat: { color: "rgb(248 113 113)" },
});

/**
 * The top-bar toggle chip, shared by the scenario list's tag filter and the
 * dataset detail view's tag editor. Both are the same control.
 */
export const chip = stylex.create({
  /**
   * `h-8 gap-2 rounded-none border-border/80 px-3
   * font-[Share_Tech_Mono,IBM_Plex_Mono,monospace] text-[10px] font-bold
   * uppercase tracking-[0.16em]`
   */
  base: {
    height: "2rem",
    gap: "0.5rem",
    borderColor: "hsl(var(--border) / 0.8)",
    paddingInline: "0.75rem",
    fontFamily: CHIP_FONT,
    fontSize: "10px",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.16em",
  },
  /** `bg-foreground text-background hover:bg-foreground/90` */
  on: {
    backgroundColor: { default: colors.text, ":hover": "hsl(var(--foreground) / 0.9)" },
    color: colors.bg,
  },
  /** `bg-background/70 text-foreground/75 hover:bg-muted hover:text-foreground` */
  off: {
    backgroundColor: { default: "hsl(var(--background) / 0.7)", ":hover": colors.muted },
    color: { default: "hsl(var(--foreground) / 0.75)", ":hover": colors.text },
  },
});

/** `scenario/scene` — the retry action and the cache-everything button. */
export const scene = stylex.create({
  /** `mt-6 h-10 rounded-full bg-[#E8E044] px-5 text-black hover:bg-[#f1ea55]` */
  retry: {
    marginTop: "1.5rem",
    height: "2.5rem",
    backgroundColor: { default: "#E8E044", ":hover": "#f1ea55" },
    paddingInline: "1.25rem",
    color: "black",
  },
  /**
   * `pointer-events-none absolute right-4 top-4 z-10 text-xs text-white/70`
   */
  idleStatus: {
    pointerEvents: "none",
    position: "absolute",
    right: "1rem",
    top: "1rem",
    zIndex: layers.raised,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: "rgb(255 255 255 / 0.7)",
  },
  /**
   * `h-auto min-h-10 w-full justify-start rounded-full border border-[#E8E044]
   * bg-[#E8E044] px-4 py-2 text-left text-xs font-semibold text-neutral-950
   * shadow-[0_0_24px_rgba(232,224,68,0.16)] hover:bg-[#F3EB4F]
   * hover:text-black focus-visible:ring-[#E8E044] focus-visible:ring-offset-2
   * focus-visible:ring-offset-black`
   *
   * The glow rides Tailwind's `--tw-shadow` slot rather than replacing
   * `box-shadow` outright, so the focus ring `Button` composes from
   * `--tw-ring-*` still draws on top of it exactly as it did.
   */
  cacheAll: {
    height: "auto",
    minHeight: "2.5rem",
    width: "100%",
    justifyContent: "flex-start",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "#E8E044",
    backgroundColor: { default: "#E8E044", ":hover": "#F3EB4F" },
    paddingInline: "1rem",
    paddingBlock: "0.5rem",
    textAlign: "left",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    fontWeight: 600,
    color: { default: "rgb(10 10 10)", ":hover": "black" },
    "--tw-shadow": "0 0 24px rgba(232, 224, 68, 0.16)",
    boxShadow: "var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow, 0 0 #0000)",
    "--tw-ring-color": { default: null, ":focus-visible": "#E8E044" },
    "--tw-ring-offset-color": { default: null, ":focus-visible": "#000" },
  },
  /** `size-4 text-neutral-950` on the spinner inside that button. */
  cacheAllSpinner: { width: "1rem", height: "1rem", color: "rgb(10 10 10)" },
});

/** `scenario/dataset` — the detail view's own chrome. */
export const dataset = stylex.create({
  /** `bg-transparent hover:bg-transparent hover:text-primary` on the back arrow. */
  backArrow: {
    backgroundColor: { default: "transparent", ":hover": "transparent" },
    color: { default: null, ":hover": colors.primary },
  },
  /**
   * `h-9 w-full justify-start gap-2 rounded-none border-0 border-t
   * border-white/10 bg-transparent px-0
   * font-[Share_Tech_Mono,IBM_Plex_Mono,monospace] text-[10px] font-bold
   * uppercase tracking-[0.16em] text-primary hover:bg-transparent
   * hover:text-primary/80`
   */
  addScenario: {
    height: "2.25rem",
    width: "100%",
    justifyContent: "flex-start",
    gap: "0.5rem",
    borderWidth: 0,
    borderTopWidth: 1,
    borderStyle: "solid",
    borderColor: "rgb(255 255 255 / 0.1)",
    backgroundColor: { default: "transparent", ":hover": "transparent" },
    paddingInline: 0,
    fontFamily: CHIP_FONT,
    fontSize: "10px",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.16em",
    color: { default: colors.primary, ":hover": "hsl(var(--primary) / 0.8)" },
  },
});

/** `scenario/rail` — the dataset and scenario rails. */
export const rail = stylex.create({
  /** `bg-transparent hover:bg-transparent hover:text-primary` */
  quietAccent: {
    backgroundColor: { default: "transparent", ":hover": "transparent" },
    color: { default: null, ":hover": colors.primary },
  },
  /** `bg-transparent text-muted-foreground hover:bg-transparent hover:text-destructive` */
  quietDestructive: {
    backgroundColor: { default: "transparent", ":hover": "transparent" },
    color: { default: colors.mutedForeground, ":hover": colors.danger },
  },
  /** `text-primary` on a rail toggle that is on. */
  toggleOn: { color: { default: colors.primary, ":hover": ACCENT_FOREGROUND } },
  /**
   * `h-7 flex-1 gap-1.5 bg-transparent px-2 font-meta text-micro font-bold
   * uppercase tracking-meta hover:bg-transparent hover:text-primary`
   */
  autoplay: {
    height: "1.75rem",
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "0%",
    gap: "0.375rem",
    backgroundColor: { default: "transparent", ":hover": "transparent" },
    paddingInline: "0.5rem",
    fontFamily: text.fontMeta,
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: { default: null, ":hover": colors.primary },
  },
  /** `text-primary` while autoplay runs, over `autoplay`'s own hover ink. */
  autoplayOn: { color: { default: colors.primary, ":hover": colors.primary } },
  /**
   * `w-full justify-center gap-1.5 rounded-none border-0 border-t
   * border-white/10 bg-[#E8E044] px-0 font-meta text-micro font-bold uppercase
   * tracking-meta text-black hover:bg-[#f1e949] hover:text-black` — the accent
   * footer action. Height is the one thing the two rails disagree on.
   */
  footerAction: {
    width: "100%",
    justifyContent: "center",
    gap: "0.375rem",
    borderWidth: 0,
    borderTopWidth: 1,
    borderStyle: "solid",
    borderColor: "rgb(255 255 255 / 0.1)",
    backgroundColor: { default: "#E8E044", ":hover": "#f1e949" },
    paddingInline: 0,
    fontFamily: text.fontMeta,
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: { default: "black", ":hover": "black" },
  },
  /** `h-10` on the dataset rail's footer action. */
  footerActionTall: { height: "2.5rem" },
  /** `h-9` on the scenario rail's footer action. */
  footerActionShort: { height: "2.25rem" },
});

/** `scenario/review` — the review queue's badges and saving indicator. */
export const review = stylex.create({
  /** `text-[10px]` */
  tagBadge: { fontSize: "10px" },
  /** `font-mono text-[10px]` */
  idBadge: { fontFamily: text.fontMono, fontSize: "10px" },
  /** `ml-1 text-xs text-muted-foreground` */
  saving: {
    marginLeft: "0.25rem",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.mutedForeground,
  },
});
