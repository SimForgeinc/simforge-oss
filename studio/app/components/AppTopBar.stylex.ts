/**
 * StyleX styles for `AppTopBar` — the authenticated dashboard's sticky chrome.
 *
 * A one-for-one translation of the Tailwind the bar shipped with: the same
 * literal rems, the same `rgb(r g b / a)` channels the slash-opacity utilities
 * produced, and Tailwind's own filter ordering inside the composite
 * `backdrop-filter`. Nothing here changes a pixel.
 *
 * The cloud layer's own paint is not restated here. It is shared with
 * `SkyCloudBackdrop`'s un-animated branch, so it lives beside that component
 * as `cloudPlate` and is re-exported below; `styles.clouds` is only the box it
 * is painted into.
 */

import * as stylex from "@stylexjs/stylex";
import { colors, layers } from "@simforge-oss/studio-ui/stylex/tokens.stylex";
// Imported through the package's public subpath, like every other
// `studio-ui` import in `studio/app`. `cloudPlate` is a `stylex.create`
// module, so the class names are hashed from the *defining* file and the
// specifier only decides which compiled copy is loaded — `src` in
// development, `dist` in a production build, which is the same copy
// `SkyCloudBackdrop` itself resolves to in each mode, so the plate's atomic
// rules are shared rather than emitted twice. A `defineVars` module cannot
// be imported this way; see `drive-route.stylex.ts`.
export { cloudPlate } from "@simforge-oss/studio-ui/components/SkyCloudBackdrop.stylex";

/** Tailwind's default transition curve and its `transition-colors` set. */
const EASE = "cubic-bezier(0.4, 0, 0.2, 1)";
const COLOR_TRANSITION =
  "color, background-color, border-color, text-decoration-color, fill, stroke";
const REDUCED = "@media (prefers-reduced-motion: reduce)";
/** `ease-out` — Tailwind's curve, which is not the CSS `ease-out` keyword. */
const EASE_OUT = "cubic-bezier(0, 0, 0.2, 1)";

/**
 * The logo's hover state, published to the mark inside the button.
 *
 * StyleX has no `group-hover`: there is no selector from a parent's `:hover`
 * down to a child. The button publishes the finished values instead and the
 * mark reads them, so its own `transition` animates them exactly as the
 * `group-hover:`/`group-focus-visible:` utilities did.
 */
export const logoTransform = stylex.defineVars({ value: "none" });
export const logoFilter = stylex.defineVars({
  value: "drop-shadow(0 0 0 transparent)",
});

export const styles = stylex.create({
  /**
   * sticky top-0 z-[260] flex h-14 w-full shrink-0 items-center overflow-hidden
   * border-b border-white/15 bg-black/[0.52]
   * shadow-[0_10px_35px_rgba(0,0,0,0.24),inset_0_1px_0_rgba(255,255,255,0.10)]
   * backdrop-blur-2xl backdrop-saturate-0 after:pointer-events-none
   * after:absolute after:inset-0
   * after:shadow-[inset_0_0_34px_rgba(255,255,255,0.07)]
   *
   * The `::after` layer is the inner glow on the glass; Tailwind's `after:`
   * variants supply the empty `content` that makes it render.
   */
  header: {
    position: "sticky",
    top: 0,
    zIndex: layers.topbar,
    display: "flex",
    height: "3.5rem",
    width: "100%",
    flexShrink: 0,
    alignItems: "center",
    overflow: "hidden",
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: "rgb(255 255 255 / 0.15)",
    backgroundColor: "rgb(0 0 0 / 0.52)",
    boxShadow:
      "0 10px 35px rgba(0,0,0,0.24), inset 0 1px 0 rgba(255,255,255,0.10)",
    backdropFilter: "blur(40px) saturate(0)",
    "::after": {
      content: "",
      pointerEvents: "none",
      position: "absolute",
      inset: 0,
      boxShadow: "inset 0 0 34px rgba(255,255,255,0.07)",
    },
  },

  // pointer-events-none absolute -inset-x-[8%] -inset-y-full
  clouds: {
    pointerEvents: "none",
    position: "absolute",
    left: "-8%",
    right: "-8%",
    top: "-100%",
    bottom: "-100%",
  },

  // relative z-10 flex h-full w-full items-center gap-3 px-3
  row: {
    position: "relative",
    zIndex: 10,
    display: "flex",
    height: "100%",
    width: "100%",
    alignItems: "center",
    gap: "0.75rem",
    paddingInline: "0.75rem",
  },

  /**
   * group flex size-10 shrink-0 items-center justify-center bg-transparent
   * text-primary transition-colors hover:bg-transparent hover:text-[#f4ed55]
   * focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
   */
  trigger: {
    [logoTransform.value]: {
      default: "none",
      ":hover": "scale(1.18)",
      ":focus-visible": "scale(1.18)",
    },
    [logoFilter.value]: {
      default: "drop-shadow(0 0 0 transparent)",
      ":hover":
        "drop-shadow(0 0 1px #E8E044) drop-shadow(0 0 8px rgba(232,224,68,0.32))",
    },
    display: "flex",
    width: "2.5rem",
    height: "2.5rem",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "transparent",
    color: { default: colors.primary, ":hover": "#f4ed55" },
    transitionProperty: COLOR_TRANSITION,
    transitionDuration: "150ms",
    transitionTimingFunction: EASE,
    outlineWidth: { default: null, ":focus-visible": "2px" },
    outlineStyle: { default: null, ":focus-visible": "solid" },
    outlineColor: { default: null, ":focus-visible": "transparent" },
    outlineOffset: { default: null, ":focus-visible": "2px" },
    boxShadow: { default: null, ":focus-visible": `0 0 0 2px ${colors.ring}` },
  },

  /**
   * flex items-center justify-center transition-[transform,filter]
   * duration-200 ease-out [filter:drop-shadow(0_0_0_transparent)]
   * group-hover:scale-[1.18] group-hover:[filter:…]
   * group-focus-visible:scale-[1.18] motion-reduce:transition-none
   */
  logo: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    transform: logoTransform.value,
    filter: logoFilter.value,
    transitionProperty: { default: "transform, filter", [REDUCED]: "none" },
    transitionDuration: "200ms",
    transitionTimingFunction: EASE_OUT,
  },

  // flex min-w-0 flex-1 items-center gap-4
  content: {
    display: "flex",
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "0%",
    alignItems: "center",
    gap: "1rem",
  },

  // flex min-w-0 items-baseline gap-2 truncate text-foreground
  titleRow: {
    display: "flex",
    minWidth: 0,
    alignItems: "baseline",
    gap: "0.5rem",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: colors.text,
  },

  /**
   * shrink-0 text-[20px] uppercase, plus the inline `style` the brand word
   * carried: the heavy face, its weight, and the tight optical setting that
   * makes "SIMFORGE" read as one block.
   */
  brand: {
    flexShrink: 0,
    fontSize: "20px",
    textTransform: "uppercase",
    fontFamily: "var(--font-heavy)",
    fontWeight: 700,
    letterSpacing: "-0.055em",
    lineHeight: 0.84,
  },

  // shrink-0 text-foreground/35
  separator: { flexShrink: 0, color: "hsl(var(--foreground) / 0.35)" },

  /**
   * min-w-0 truncate text-[22px] font-semibold leading-[1.1] tracking-tight,
   * plus the inline display face.
   */
  pageTitle: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "22px",
    fontWeight: 600,
    lineHeight: 1.1,
    letterSpacing: "-0.025em",
    fontFamily: "var(--font-display)",
  },

  // flex shrink-0 items-center gap-2
  actions: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: "0.5rem",
  },
  // mr-auto — actions pushed against the title
  actionsStart: { marginRight: "auto" },
  // ml-auto — actions pushed to the trailing edge
  actionsEnd: { marginLeft: "auto" },

  // flex shrink-0 items-center
  trailing: { display: "flex", flexShrink: 0, alignItems: "center" },
});
