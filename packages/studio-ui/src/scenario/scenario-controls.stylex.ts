/**
 * Caller-side StyleX for the shared primitives the scenario surfaces drive.
 *
 * The list, rail, scene and review surfaces are still authored in
 * Tailwind, but the controls they hand their overrides to — `Button`,
 * `Badge`, `Input`, `CloudLoadingSurface`, `CloudActivityIndicator` — are
 * compiled by StyleX. A StyleX atom is guarded by `:not(#\#)` three times over
 * and therefore outranks a plain utility class at every stylesheet position,
 * so an override passed as `className` is dropped rather than applied. These
 * keys are those overrides, restated so they can travel as `xstyle` and be
 * merged by StyleX in argument order.
 *
 * One module for five directories because the overrides are one vocabulary:
 * the same 28px icon button, the same top-bar toggle chip and the same
 * full-width accent footer button recur across the rail, the list and the
 * dataset column, and a copy per directory would let them drift.
 *
 * `rounded-full` / `rounded-none` are not translated. `styles.css` pins every
 * element to `border-radius: 0 !important` and the app's Tailwind config
 * resolves the whole radius scale to `0`, so both utilities were already
 * inert; carrying them over would be inventing a value, not preserving one.
 */
import * as stylex from "@stylexjs/stylex";
import { colors, space, text } from "../stylex/tokens.stylex";
/** Tailwind's `font-[Share_Tech_Mono,IBM_Plex_Mono,monospace]`. */
const CHIP_FONT = "Share Tech Mono, IBM Plex Mono, monospace";

/** Shared geometry and flat-background pieces the control keys compose with. */
export const control = stylex.create({
  /** `size-7` */
  iconSm: { width: "1.75rem", height: "1.75rem" },
  /** `relative` */
  relative: { position: "relative" },
  /** `bg-transparent hover:bg-transparent` */
  flatBackground: { backgroundColor: { default: "transparent", ":hover": "transparent" } },
  /** `w-full` */
  fullWidth: { width: "100%" },
  /** `mt-1.5` */
  spaceAbove15: { marginTop: space.s1_5 },
  /** `mt-4` */
  spaceAbove4: { marginTop: space.s4 },
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
  /** `font-meta text-micro uppercase tracking-meta-wide text-muted-foreground` */
  metaLabel: {
    color: colors.mutedForeground,
  },
  /** `text-primary` on the selected row, over the menu's own focus ink. */
  selected: { color: { default: colors.primary, ":focus": colors.primary } },
});

/**
 * `CloudLoadingSurface`'s `pane` scope declares its own `min-height: 12rem`; a
 * pane that reserves a different amount of room while it loads says so
 * through `xstyle`.
 */
export const paneLoading = stylex.create({
  /** `min-h-24` */
  h24: { minHeight: "6rem" },
});

/** `Button` overrides in `scenario/list`. */
export const list = stylex.create({
  /**
   * `h-9 w-full bg-transparent font-meta text-micro font-bold uppercase
   * tracking-meta-wide hover:bg-transparent hover:text-primary`
   */
  loadMore: {
    width: "100%",
    fontFamily: text.fontMeta,
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaWide,
  },
  /** `h-7 min-w-0 flex-1 px-2 text-meta` */
  tagNameInput: {
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "0%",
    paddingInline: space.s2,
  },
  /** `h-7 border-primary/60 px-2 text-micro uppercase tracking-meta text-primary` */
  tagSubmit: {
    paddingInline: space.s2,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
  },
  /** `h-8 w-full justify-start px-3 text-xs` */
  allScenarios: {
    height: "2rem",
    width: "100%",
    justifyContent: "flex-start",
    paddingInline: space.s3,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
  },
  /** `h-9 pl-9` — the map search field, cleared of the leading icon. */
  mapSearchInput: { paddingLeft: "2.25rem" },
  /**
   * `h-4 rounded-full border-red-400/40 bg-red-400/10 px-1.5 py-0 font-meta
   * text-[8px] uppercase tracking-meta-narrow text-red-300`
   */
  rejectedBadge: {
    height: "1rem",
    borderColor: colors.critical,
    backgroundColor: colors.criticalWash,
    paddingInline: space.s1_5,
    paddingBlock: 0,
    color: colors.critical,
  },
  /** `w-full gap-2` on the `.xosc` file chooser. */
  fileChooser: { width: "100%", gap: space.s2 },
});

/** The row-level icon buttons in `ScenarioDocumentRow`. */
export const row = stylex.create({
  /** `text-foreground/65 hover:text-foreground` */
  quiet: { color: { default: colors.inkSecondary, ":hover": colors.text } },
  /** `text-primary`, beside the row base's own `hover:text-foreground`. */
  activeInk: { color: { default: colors.primary, ":hover": colors.text } },
  /** `text-primary` where the ghost variant still supplies the hover ink. */
  accentInk: { color: { default: colors.primary, ":hover": colors.hoverWashText } },
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
  active: { color: { default: colors.critical, ":hover": colors.text } },
  activeFlat: { color: colors.critical },
  /** `text-yellow-400 hover:text-yellow-300` */
  running: { color: { default: colors.warning, ":hover": colors.warning } },
  runningFlat: { color: colors.warning },
  /** `text-green-400 hover:text-green-300` */
  complete: { color: { default: colors.positive, ":hover": colors.positive } },
  completeFlat: { color: colors.positive },
  /** `text-red-400 hover:text-red-300` */
  none: { color: { default: colors.critical, ":hover": colors.critical } },
  noneFlat: { color: colors.critical },
});

/**
 * The top-bar toggle chip, shared by the scenario list's tag filter and the
 * dataset detail view's tag editor. Both are the same control.
 */
export const chip = stylex.create({
});

/** `scenario/scene` — the retry action and the cache-everything button. */
export const scene = stylex.create({
  /** `mt-6 h-10 rounded-full bg-[#E8E044] px-5 text-black hover:bg-[#f1ea55]` */
  retry: {
    marginTop: space.s6,
    paddingInline: space.s5,
  },
});

/** `scenario/rail` — the in-editor scenario rail. */
export const rail = stylex.create({
  /** `text-primary` on a rail toggle that is on. */
  toggleOn: { color: { default: colors.primary, ":hover": colors.hoverWashText } },
  /**
   * `h-7 flex-1 gap-1.5 bg-transparent px-2 font-meta text-micro font-bold
   * uppercase tracking-meta hover:bg-transparent hover:text-primary`
   */
  autoplay: {
    height: "1.75rem",
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "0%",
    gap: space.s1_5,
    backgroundColor: { default: "transparent", ":hover": "transparent" },
    paddingInline: space.s2,
    color: { default: null, ":hover": colors.primary },
  },
  /** `text-primary` while autoplay runs, over `autoplay`'s own hover ink. */
  autoplayOn: { color: { default: colors.primary, ":hover": colors.primary } },
  /**
   * `w-full justify-center gap-1.5 rounded-none border-0 border-t
   * border-white/10 bg-[#E8E044] px-0 font-meta text-micro font-bold uppercase
   * tracking-meta text-black hover:bg-[#f1e949] hover:text-black` — the accent
   * footer action.
   */
  footerAction: {
    width: "100%",
    justifyContent: "center",
    gap: space.s1_5,
    paddingInline: 0,
    fontFamily: text.fontMeta,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
  },
});

/** `scenario/review` — the review queue's badges and saving indicator. */
export const review = stylex.create({
  /** `text-[10px]` */
  tagBadge: { fontSize: text.sizeMicro, lineHeight: "inherit" },
  /** `font-mono text-[10px]` */
  idBadge: { fontFamily: text.fontMono, fontSize: text.sizeMicro, lineHeight: "inherit" },
  /** `ml-1 text-xs text-muted-foreground` */
  saving: {
    marginLeft: space.s1,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.mutedForeground,
  },
});
