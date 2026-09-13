/**
 * StyleX styles for the asset shelf's chrome: the tab strip that heads every
 * `/dashboard/assets` view, the CARLA compatibility page it switches to, and
 * the gallery's own header — the title block's frame and the Models/Maps
 * switch under it.
 *
 * Translated one-for-one from the Tailwind these components shipped with.
 * Nothing here changes a pixel; the values are the compiled output of the
 * utilities they replace, which is why literal rems appear rather than being
 * rounded onto the nearest `space` step — `px-5` is `1.25rem`, and the spacing
 * scale has no such step.
 */

import * as stylex from "@stylexjs/stylex";
import { colors, radii, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

/**
 * The shelf's centred measure. Wider than the dashboard's other columns
 * because these pages are catalogs: the tab strip has to line its left edge up
 * with the grid and the table underneath it, and all three share this value.
 */
const SHELF_MEASURE = "1500px";

/**
 * The tab strip and the CARLA table sit on their own plate, a shade below
 * `--background`, so the strip reads as chrome attached to the page rather
 * than as part of the scrolling content. Theme-invariant by design — the
 * matrix is a dark instrument table in both themes — which is why this is a
 * literal and not a `colors` bridge.
 */
const SHELF_PLATE = "#090b0e";

/** The hairline over that plate. Lighter than `colors.line` (0.08) by design. */
const SHELF_HAIRLINE = "rgba(255, 255, 255, 0.07)";

/** `sm:` — the one breakpoint this chrome responds to. */
const SM = "@media (min-width: 640px)";

export const shelf = stylex.create({
  // border-b border-white/[0.07] bg-[#090b0e] px-5 sm:px-8
  tabBar: {
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: SHELF_HAIRLINE,
    backgroundColor: SHELF_PLATE,
    paddingInline: { default: "1.25rem", [SM]: "2rem" },
  },
  // mx-auto flex max-w-[1500px] gap-5
  tabBarInner: {
    marginInline: "auto",
    display: "flex",
    maxWidth: SHELF_MEASURE,
    gap: "1.25rem",
  },
  // border-b-2 px-0.5 py-3 text-xs font-medium transition-colors
  //
  // `transition-colors` expanded: Tailwind's property list, duration and curve.
  // The border colour is in that list, so the underline fades in with the ink
  // rather than snapping — which is the whole point of the utility here.
  tab: {
    borderBottomWidth: 2,
    borderBottomStyle: "solid",
    paddingInline: "0.125rem",
    paddingBlock: "0.75rem",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    fontWeight: 500,
    transitionProperty:
      "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionDuration: "150ms",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
  },
  // border-[#E8E044] text-white
  tabActive: {
    borderBottomColor: colors.accent,
    color: "#ffffff",
  },
  // border-transparent text-white/45 hover:text-white/75
  tabIdle: {
    borderBottomColor: "transparent",
    color: {
      default: "rgba(255, 255, 255, 0.45)",
      ":hover": "rgba(255, 255, 255, 0.75)",
    },
  },
});

export const carla = stylex.create({
  // min-h-full bg-[#090b0e] text-white
  page: {
    minHeight: "100%",
    backgroundColor: SHELF_PLATE,
    color: "#ffffff",
  },
  // border-b border-white/[0.07] px-5 py-6 sm:px-8
  header: {
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: SHELF_HAIRLINE,
    paddingInline: { default: "1.25rem", [SM]: "2rem" },
    paddingBlock: "1.5rem",
  },
  // mx-auto max-w-[1500px]
  measure: {
    marginInline: "auto",
    maxWidth: SHELF_MEASURE,
  },
  // text-[10px] font-semibold uppercase tracking-[0.18em] text-[#E8E044]
  eyebrow: {
    fontSize: "10px",
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaWider,
    color: colors.accent,
  },
  // mt-2 text-3xl font-semibold tracking-[-0.035em]
  title: {
    marginTop: "0.5rem",
    fontSize: "1.875rem",
    lineHeight: "2.25rem",
    fontWeight: 600,
    letterSpacing: "-0.035em",
  },
  // mt-2 text-sm text-white/50
  summary: {
    marginTop: "0.5rem",
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    color: colors.textSubtle,
  },
  // mx-auto max-w-[1500px] px-5 py-6 sm:px-8
  main: {
    marginInline: "auto",
    maxWidth: SHELF_MEASURE,
    paddingInline: { default: "1.25rem", [SM]: "2rem" },
    paddingBlock: "1.5rem",
  },
});

/**
 * The gallery header's plate. Unlike the tab strip above it this one is the
 * page background proper, hairlined with the themed `--border` rather than
 * the shelf's fixed white wash: it frames themed content, not the dark
 * instrument table.
 */
export const header = stylex.create({
  // border-b border-border bg-background px-5 sm:px-8
  //
  // The inline padding matches `shelf.tabBar` above it on purpose — the two
  // used to inset differently and their left edges did not line up.
  bar: {
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: colors.border,
    backgroundColor: colors.bg,
    paddingInline: { default: "1.25rem", [SM]: "2rem" },
  },
  // mx-auto max-w-[1500px]
  measure: {
    marginInline: "auto",
    maxWidth: SHELF_MEASURE,
  },
  // flex flex-wrap items-center gap-2
  actions: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "0.5rem",
  },
  // mb-4 — the switch's clearance over the grid that follows it.
  sectionSwitch: {
    marginBottom: "1rem",
  },
  // border-b-0 bg-transparent px-0 pb-4 sm:px-0
  //
  // `PageHeader` draws its own rule, plate and inset; this shelf supplies all
  // three itself on `bar` above, so the header's frame is stripped back to the
  // title block. It travels as `xstyle` because the header compiles those
  // declarations with StyleX — a class name would lose to them.
  titleBlock: {
    borderBottomWidth: 0,
    backgroundColor: "transparent",
    paddingInline: 0,
    paddingBottom: "1rem",
  },
});

/**
 * `bg-muted/30`: the themed muted plate at 30%, so the unselected half of the
 * switch reads as a well rather than as a second raised surface. Written out
 * because `colors.muted` is an opaque `hsl()` bridge and alpha has to be
 * applied to the channels inside it.
 */
const SWITCH_WELL = "hsl(var(--muted) / 0.3)";

/**
 * `focus-visible:ring-2 ring-ring ring-offset-1 ring-offset-background`.
 * Tailwind composes its ring from box-shadows — an offset ring in the page
 * background first, then the ring itself — and that is exactly what this is,
 * flattened now that there is no utility layering the two.
 */
const FOCUS_RING = `0 0 0 1px ${colors.bg}, 0 0 0 3px ${colors.ring}`;

/** `shadow-sm`, Tailwind's default: the selected option's slight lift. */
const SHADOW_SM = "0 1px 2px 0 rgb(0 0 0 / 0.05)";

export const segmented = stylex.create({
  // inline-flex items-center gap-0.5 rounded-md border border-border bg-muted/30 p-0.5
  group: {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.125rem",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: SWITCH_WELL,
    padding: "0.125rem",
  },
  // inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium
  // transition-colors focus-visible:outline-none
  //
  // `transition-colors` expanded as in `shelf.tab`; `outline-none` is
  // Tailwind's transparent 2px outline, which suppresses the UA ring without
  // erasing the control's outline in forced-colours mode.
  option: {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.375rem",
    borderRadius: radii.sm,
    paddingInline: "0.75rem",
    paddingBlock: "0.375rem",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    fontWeight: 500,
    transitionProperty:
      "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionDuration: "150ms",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    outlineStyle: { default: null, ":focus-visible": "solid" },
    outlineWidth: { default: null, ":focus-visible": "2px" },
    outlineColor: { default: null, ":focus-visible": "transparent" },
    outlineOffset: { default: null, ":focus-visible": "2px" },
  },
  // bg-background text-foreground shadow-sm
  //
  // The ring is declared per state rather than once on `option` because
  // box-shadow is a single property: the selected option carries a shadow of
  // its own, and a base-level ring would be overwritten by it. Tailwind
  // stacks offset ring, ring, then shadow, and so does this.
  optionActive: {
    backgroundColor: colors.bg,
    color: colors.text,
    boxShadow: {
      default: SHADOW_SM,
      ":focus-visible": `${FOCUS_RING}, ${SHADOW_SM}`,
    },
  },
  // text-muted-foreground hover:text-foreground
  optionIdle: {
    color: { default: colors.mutedForeground, ":hover": colors.text },
    boxShadow: { default: null, ":focus-visible": FOCUS_RING },
  },
  // size-3.5
  icon: {
    width: "0.875rem",
    height: "0.875rem",
  },
});
