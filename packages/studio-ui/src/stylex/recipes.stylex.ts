/**
 * Recipes: the looks Studio repeats, written once.
 *
 * A recipe is a small `stylex.create` namespace built only from tokens. It is
 * composed first in `stylex.props(recipe…, local…, variant…, xstyle)`, so a
 * component's own layout and state styles win over it and a caller's
 * `xstyle` wins over both. Recipes carry look (focus, motion, lines, fills,
 * type), never layout: where a thing sits and how big it is stays local.
 *
 *   import { focus, motionRecipe, typography } from "../../stylex/recipes.stylex";
 *   <button {...stylex.props(focus.ring, motionRecipe.colors, typography.label, styles.root)} />
 *
 * (`motionRecipe` and `typography` are named so they never collide with the
 * `motion` and `text` token groups a file often imports beside them.)
 *
 * From `studio/app`, import `@simforge-oss/studio-ui/stylex/recipes.stylex`.
 *
 * Adding one: it must be used, or about to be used, in at least two
 * unrelated places; it must read only tokens; and its name says the role, not
 * the declarations. The style guide lists them all with when to reach for
 * each (docs/engineering/studio-style-guide.md).
 */
import * as stylex from "@stylexjs/stylex";

import { colors, layout, motion as m, shadows, space, stroke, text } from "./tokens.stylex";

/**
 * Keyboard focus. Every interactive element takes exactly one of these.
 *
 * The ring is a box-shadow, so it follows the element's shape and is never
 * clipped by `overflow: hidden` on the element itself. The transparent
 * outline beside it is not decoration: forced-colors mode drops box-shadows
 * and repaints outlines, so the outline is the ring high-contrast users see.
 *
 *  - `ring`: the default, outside the element: 2px of brand accent.
 *  - `ringInset`: inside the element, for controls flush against a neighbour
 *    or inside a scroller that would clip an outside ring.
 *    (There is one ring colour: the accent. `ringAccent`, `ringAccentInset`
 *    and `ringOffset` are gone; compose `ring` or `ringInset`.)
 *  - `outline`: a solid outline instead of a shadow, for elements that
 *    already use `box-shadow` for something else.
 *  - `within`: the ring on a container while any descendant has focus.
 */
export const focus = stylex.create({
  ring: {
    outlineWidth: { default: null, ":focus-visible": stroke.thick },
    outlineStyle: { default: null, ":focus-visible": "solid" },
    outlineColor: { default: null, ":focus-visible": "transparent" },
    outlineOffset: { default: null, ":focus-visible": "2px" },
    boxShadow: { default: null, ":focus-visible": shadows.ring },
  },
  ringInset: {
    outlineWidth: { default: null, ":focus-visible": stroke.thick },
    outlineStyle: { default: null, ":focus-visible": "solid" },
    outlineColor: { default: null, ":focus-visible": "transparent" },
    outlineOffset: { default: null, ":focus-visible": "2px" },
    boxShadow: { default: null, ":focus-visible": shadows.ringInset },
  },
  outline: {
    outlineWidth: { default: null, ":focus-visible": stroke.thick },
    outlineStyle: { default: null, ":focus-visible": "solid" },
    outlineColor: { default: null, ":focus-visible": colors.ring },
    outlineOffset: { default: null, ":focus-visible": "2px" },
  },
  within: {
    outlineWidth: { default: null, ":focus-within": stroke.thick },
    outlineStyle: { default: null, ":focus-within": "solid" },
    outlineColor: { default: null, ":focus-within": "transparent" },
    outlineOffset: { default: null, ":focus-within": "2px" },
    boxShadow: { default: null, ":focus-within": shadows.ring },
  },
});

const spin = stylex.keyframes({
  from: { transform: "rotate(0deg)" },
  to: { transform: "rotate(360deg)" },
});

const pulse = stylex.keyframes({
  "0%, 100%": { opacity: 1 },
  "50%": { opacity: 0.5 },
});

const fadeIn = stylex.keyframes({
  from: { opacity: 0 },
  to: { opacity: 1 },
});

const sweep = stylex.keyframes({
  "0%": { transform: "translateX(-100%)" },
  "100%": { transform: "translateX(400%)" },
});

/**
 * Motion. Colour and opacity move; geometry mostly does not (a transitioned
 * width or transform on chrome over the live world fights the WebGL scene).
 * Every recipe here stops under `prefers-reduced-motion`.
 *
 *  - `colors`: hover and state colour changes on controls.
 *  - `opacity`: things that fade in place.
 *  - `transform`: the few controls that move (a chevron turning, a thumb).
 *  - `spin`: a spinner's rotation. Prefer the `Spinner` primitive.
 *  - `pulse`: a breathing placeholder or live indicator.
 *  - `fadeIn`: a one-shot entrance.
 *  - `sweep`: an indeterminate progress bar's travelling block.
 */
export const motionRecipe = stylex.create({
  colors: {
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionDuration: { default: m.durStandard, [layout.reducedMotion]: "0s" },
    transitionTimingFunction: m.easeStandard,
  },
  opacity: {
    transitionProperty: "opacity",
    transitionDuration: { default: m.durStandard, [layout.reducedMotion]: "0s" },
    transitionTimingFunction: m.easeStandard,
  },
  transform: {
    transitionProperty: "transform",
    transitionDuration: { default: m.durStandard, [layout.reducedMotion]: "0s" },
    transitionTimingFunction: m.easeStandard,
  },
  spin: {
    animationName: { default: spin, [layout.reducedMotion]: "none" },
    animationDuration: m.durSpin,
    animationTimingFunction: m.easeLinear,
    animationIterationCount: "infinite",
  },
  pulse: {
    animationName: { default: pulse, [layout.reducedMotion]: "none" },
    animationDuration: m.durPulse,
    animationTimingFunction: m.easePulse,
    animationIterationCount: "infinite",
  },
  fadeIn: {
    animationName: { default: fadeIn, [layout.reducedMotion]: "none" },
    animationDuration: m.durBase,
    animationTimingFunction: m.easeDecelerate,
    animationFillMode: "both",
  },
  sweep: {
    animationName: { default: sweep, [layout.reducedMotion]: "none" },
    animationDuration: "1.5s",
    animationIterationCount: "infinite",
    animationTimingFunction: m.easeStandard,
  },
});

/**
 * Hairlines: one weight, one colour, on the sides you ask for. Compose a
 * weight modifier after it (`hairline.all, hairline.strong`) to change the
 * colour on every side at once.
 */
export const hairline = stylex.create({
  all: { borderWidth: stroke.hairline, borderStyle: "solid", borderColor: colors.hairline },
  top: { borderTopWidth: stroke.hairline, borderTopStyle: "solid", borderTopColor: colors.hairline },
  bottom: { borderBottomWidth: stroke.hairline, borderBottomStyle: "solid", borderBottomColor: colors.hairline },
  start: { borderInlineStartWidth: stroke.hairline, borderInlineStartStyle: "solid", borderInlineStartColor: colors.hairline },
  end: { borderInlineEndWidth: stroke.hairline, borderInlineEndStyle: "solid", borderInlineEndColor: colors.hairline },
  subtle: { borderColor: colors.hairlineSubtle },
  strong: { borderColor: colors.hairlineStrong },
  /** A hairline that brightens under the pointer: cards and rows. */
  hover: { borderColor: { default: colors.hairline, ":hover": colors.hairlineStrong } },
});

/**
 * Surfaces: what a region is made of. Pair with `hairline.*` for its edge.
 *
 *  - `plate`: the opaque near-black panel chrome sits on.
 *  - `raised`: a plate one step up (menus, popovers, dialogs).
 *  - `card`: a resting card on a plate: a faint fill.
 *  - `glass`: a translucent pane over the live world, with blur.
 *  - `chip`: a small filled label or toggle.
 *  - `scrim`: the dim layer behind a modal.
 */
export const surface = stylex.create({
  plate: { backgroundColor: colors.panelSolid, color: colors.ink },
  raised: { backgroundColor: colors.panel, color: colors.ink, boxShadow: shadows.elevationLg },
  card: { backgroundColor: colors.fillFaint },
  glass: { backgroundColor: colors.fillSubtle, backdropFilter: m.blurGlass },
  chip: { backgroundColor: colors.fillStrong },
  scrim: { backgroundColor: colors.scrim, backdropFilter: m.blurSm },
});

/**
 * Interaction states for anything clickable that is not a `Button`: rows,
 * tiles, list items. Compose `interactive.base` with one of the others.
 *
 *  - `base`: pointer, colour transitions, a disabled state.
 *  - `hoverFill`: a fill appears under the pointer.
 *  - `hoverInk`: muted ink brightens under the pointer.
 *  - `selected`: the current item: accent wash and full ink.
 */
export const interactive = stylex.create({
  base: {
    cursor: { default: "pointer", ":disabled": "not-allowed" },
    opacity: { default: null, ":disabled": 0.5 },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionDuration: { default: m.durStandard, [layout.reducedMotion]: "0s" },
    transitionTimingFunction: m.easeStandard,
  },
  hoverFill: { backgroundColor: { default: null, ":hover": colors.fill } },
  hoverInk: { color: { default: colors.inkMuted, ":hover": colors.ink } },
  selected: { backgroundColor: colors.accentWash, color: colors.ink },
});

/**
 * Type roles. Pick by what the text is, not how big it should be.
 *
 *  - `eyebrow`: the instrument label above a section or value: meta face,
 *    uppercase, tracked out, muted.
 *  - `tag`: the eyebrow one step smaller, for status tags on dense rows.
 *  - `caps`: uppercase control text in the body face.
 *  - `meta`: a secondary fact beside a value (a count, a time, a size).
 *  - `label`: a control's or field's label.
 *  - `body`: running copy.
 *  - `bodySm`: dense copy in panels and rows.
 *  - `title`: the name of a panel, card or dialog.
 *  - `heading`: the name of a page.
 *  - `numeric`: tabular digits for values that change in place.
 */
export const typography = stylex.create({
  eyebrow: {
    fontFamily: text.fontMeta,
    fontSize: text.sizeMicro,
    fontWeight: text.weightBold,
    lineHeight: text.lineMicro,
    letterSpacing: text.trackingMetaWide,
    textTransform: "uppercase",
    color: colors.inkMuted,
  },
  /** A status tag on a dense row: the eyebrow one step smaller. */
  tag: {
    fontFamily: text.fontMeta,
    fontSize: text.sizeTag,
    fontWeight: text.weightBold,
    lineHeight: text.lineMicro,
    letterSpacing: text.trackingMeta,
    textTransform: "uppercase",
  },
  /** Uppercase control text in the body face (a segmented control, a tab). */
  caps: {
    fontFamily: text.fontBody,
    fontSize: text.sizeXs,
    fontWeight: text.weightSemibold,
    lineHeight: text.lineXs,
    letterSpacing: text.trackingWide,
    textTransform: "uppercase",
  },
  meta: {
    fontFamily: text.fontBody,
    fontSize: text.sizeMeta,
    lineHeight: text.lineXs,
    color: colors.inkMuted,
  },
  label: {
    fontFamily: text.fontBody,
    fontSize: text.sizeXs,
    fontWeight: text.weightMedium,
    lineHeight: text.lineXs,
    color: colors.inkSecondary,
  },
  body: {
    fontFamily: text.fontBody,
    fontSize: text.sizeSm,
    lineHeight: text.lineSm,
    color: colors.inkSecondary,
  },
  bodySm: {
    fontFamily: text.fontBody,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.inkSecondary,
  },
  title: {
    fontFamily: text.fontDisplay,
    fontSize: text.sizeBase,
    fontWeight: text.weightSemibold,
    lineHeight: text.lineBase,
    letterSpacing: text.trackingTight,
    color: colors.ink,
  },
  heading: {
    fontFamily: text.fontDisplay,
    fontSize: text.sizeXl,
    fontWeight: text.weightSemibold,
    lineHeight: text.lineXl,
    letterSpacing: text.trackingTight,
    color: colors.ink,
  },
  numeric: { fontVariantNumeric: "tabular-nums" },
});

/**
 * Control geometry: height, inline padding and type size of a control, so
 * buttons, inputs, selects and chips on one row line up. `iconXs`…`iconLg`
 * are square.
 */
export const control = stylex.create({
  xs: { height: "1.5rem", paddingInline: space.s2, fontSize: text.sizeMicro, gap: space.s1 },
  sm: { height: "2rem", paddingInline: space.s3, fontSize: text.sizeXs, gap: space.s1_5 },
  md: { height: "2.25rem", paddingInline: space.s3, fontSize: text.sizeSm, gap: space.s2 },
  lg: { height: "2.5rem", paddingInline: space.s4, fontSize: text.sizeSm, gap: space.s2 },
  iconXs: { width: "1.5rem", height: "1.5rem", paddingInline: 0 },
  iconSm: { width: "2rem", height: "2rem", paddingInline: 0 },
  iconMd: { width: "2.25rem", height: "2.25rem", paddingInline: 0 },
  iconLg: { width: "2.5rem", height: "2.5rem", paddingInline: 0 },
});

/** Accessibility helpers. */
export const a11y = stylex.create({
  /** Present to assistive technology, absent from the screen. */
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
});

/** Text that must not wrap or overflow its box. */
export const textLayout = stylex.create({
  truncate: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  clamp2: { display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 2, overflow: "hidden" },
});

/**
 * Which boxes scroll. A box in the app shell either scrolls on purpose or can never scroll.
 *
 *  - `clip`: clips its overflow and is never a scroll container. `overflow: hidden` still is one:
 *    `focus()`, `scrollIntoView()` and the router's scroll restoration all scroll it, and on the
 *    scenario page that slid the whole page up under the top bar and left an empty band under the
 *    map until a reload. Every shell box between the viewport and a scroller takes this.
 *  - `y`: the scroller itself. Its scroll chain stops at its own edges, so reaching the end of a list
 *    never moves what is around it, and a thin themed scrollbar says it scrolls.
 */
export const scroll = stylex.create({
  clip: { overflow: "clip" },
  y: {
    overflowX: "hidden",
    overflowY: "auto",
    overscrollBehavior: "contain",
    scrollbarWidth: "thin",
    scrollbarColor: `${colors.inkGhost} transparent`,
  },
});
