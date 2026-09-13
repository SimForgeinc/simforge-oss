/**
 * StyleX styles for the map canvas: its controls, its DOM overlays and the
 * DOM-rendered parts of its GL layers.
 *
 * The palette is `map-layer-constants`'s `C`, written out as literals because
 * `stylex.create` needs compile-time values and `C` is also read at runtime by
 * the MapLibre paint expressions next to these components. The constants below
 * are the same six values; they are folded into the generated CSS at build
 * time, so a drift between the two lists would show up as a colour change on
 * the surface and nowhere else — hence one block, next to each other.
 *
 * What deliberately stays inline at the callsites:
 *  - marker geometry that follows the camera (`width`/`height`/`transform`
 *    from the zoom-resolved marker scale, per-feature rotation),
 *  - tooltip and popover placement, which is computed from the pointer and the
 *    container rect,
 *  - per-feature colour, which comes from the feature's own properties,
 *  - MapLibre's own marker `transform`, which it writes to the element.
 *
 * Radii: the global stylesheet enforces `border-radius: 0 !important` on every
 * element, so every radius here — including the `999px` pills carried over
 * from the inline styles and the `0` that Tailwind's `rounded-*` utilities
 * resolve to in this product — is inert. They are kept as authored so this
 * file records the same intent the inline styles did.
 */

import * as stylex from "@stylexjs/stylex";

/** `C.bg`, `C.fg`, `C.border`, `C.muted` and `C.font` from `map-layer-constants`. */
const BG = "#0a0a0a";
const FG = "#fafafa";
const BORDER = "#262626";
const MUTED = "#a3a3a3";
const FONT = "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

/** `SIGNAL_UNKNOWN_COLOR` from `signal-plan-model`: a junction on map timers. */
const SIGNAL_UNKNOWN = "#6B7280";

/**
 * The actor hover card's face. Deliberately not `FONT`: the card names the
 * system stack without Blink, as it did when it was written inline.
 */
const CARD_FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

/** Colour/background cross-fade shared by every control in the cluster. */
const CONTROL_TRANSITION = "background 0.15s, color 0.15s";

/** The 3D chunk's pending spinner. */
const spin = stylex.keyframes({ to: { transform: "rotate(360deg)" } });

/** An actor hover card rises 2 px as it fades in, under its own centring. */
const hoverInfoFadeIn = stylex.keyframes({
  from: { opacity: 0, transform: "translateX(-50%) translateY(2px)" },
  to: { opacity: 1, transform: "translateX(-50%) translateY(0)" },
});

/** Hold-to-move: the ring closes over the hold window, then stays closed. */
const holdProgressFill = stylex.keyframes({ to: { strokeDashoffset: 0 } });

/**
 * How long an actor must be held before the drag arms — the window the ring
 * animates over. It lives here because the ring is the only thing that reads
 * it; `ActorMarkerView` arms on mousedown and disarms on mouseup.
 */
const HOLD_TO_MOVE_MS = 500;

export const styles = stylex.create({
  fullscreen: { position: "absolute", inset: 0, width: "100%", height: "100%" },
  map: { width: "100%", height: "100%" },

  // ── Control cluster ────────────────────────────────────────────────────
  /** Every control is pinned to the canvas; each one carries its own corner. */
  control: { position: "absolute" },
  /**
   * Bottom-right, above any surface a mode swaps in — the editor's twin canvas
   * covers the map at z-20, and this toggle is the only way back out of it.
   */
  viewModeControl: {
    bottom: "0.75rem",
    right: "0.75rem",
    zIndex: 30,
    display: "flex",
    alignItems: "center",
    borderRadius: "999px",
    overflow: "hidden",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: BORDER,
    boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
    fontFamily: FONT,
  },
  /** Bottom-left, a pill that hugs its own segments. */
  basemapControl: {
    bottom: "0.75rem",
    left: "0.75rem",
    zIndex: 10,
    display: "flex",
    borderRadius: "999px",
    overflow: "hidden",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: BORDER,
    boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
    fontFamily: FONT,
  },
  /** Bottom-right, just above MapLibre's attribution control. */
  measureControl: {
    bottom: "2.5rem",
    right: "0.75rem",
    zIndex: 10,
    width: "2rem",
    height: "2rem",
    padding: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "999px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: BORDER,
    cursor: "pointer",
    boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
    transition: CONTROL_TRANSITION,
  },
  controlEnabled: { opacity: 1, pointerEvents: "auto" },
  controlDisabled: { opacity: 0.5, pointerEvents: "none" },

  /** 2D / 3D / 3D Twin. Flex because a pending mode carries a spinner. */
  viewModeButton: {
    padding: "0.3rem 0.85rem",
    fontSize: "0.75rem",
    letterSpacing: "0.02em",
    borderStyle: "none",
    whiteSpace: "nowrap",
    display: "flex",
    alignItems: "center",
    gap: "0.35rem",
    transition: CONTROL_TRANSITION,
  },
  /**
   * Map / Satellite. Its own segment metrics: the switch is two words of plain
   * label, so it keeps the tighter padding and none of the view-mode switch's
   * spinner-carrying flex box or tracking.
   */
  basemapButton: {
    padding: "0.3rem 0.75rem",
    fontSize: "0.75rem",
    borderStyle: "none",
    whiteSpace: "nowrap",
    transition: CONTROL_TRANSITION,
  },
  /** The selected segment inverts, and stops offering to be clicked. */
  segmentActive: { fontWeight: 600, cursor: "default", backgroundColor: FG, color: BG },
  segmentInactive: { fontWeight: 400, cursor: "pointer", backgroundColor: `${BG}f2`, color: FG },

  /** Follow-camera toggle: a square icon button divided off the segments. */
  followButton: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 30,
    padding: 0,
    borderTopStyle: "none",
    borderRightStyle: "none",
    borderBottomStyle: "none",
    borderLeftWidth: "1px",
    borderLeftStyle: "solid",
    borderLeftColor: BORDER,
    transition: CONTROL_TRANSITION,
  },
  /** Only bites with an actor selected — otherwise it is visibly inert. */
  followEnabled: { opacity: 1, cursor: "pointer" },
  followDisabled: { opacity: 0.4, cursor: "not-allowed" },
  icon13: { width: 13, height: 13 },

  /** Measure mode inverts the button the same way a selected segment does. */
  measureActive: { backgroundColor: FG, color: BG },
  measureInactive: { backgroundColor: `${BG}f2`, color: FG },

  spinner: {
    width: 8,
    height: 8,
    borderRadius: "999px",
    borderWidth: "1.5px",
    borderStyle: "solid",
    borderTopColor: "transparent",
    borderRightColor: BG,
    borderBottomColor: BG,
    borderLeftColor: BG,
    animationName: spin,
    animationDuration: "700ms",
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
  },

  // ── Canvas-level status chrome ─────────────────────────────────────────
  /** "← Show all maps", centred at the top of a single-asset view. */
  resetButton: {
    position: "absolute",
    top: "0.75rem",
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 10,
    padding: "0.3rem 0.85rem",
    backgroundColor: `${BG}f2`,
    color: FG,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: BORDER,
    borderRadius: "999px",
    fontSize: "0.75rem",
    fontFamily: FONT,
    cursor: "pointer",
    boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
    whiteSpace: "nowrap",
  },
  /** "Loading geometry…", centred at the bottom and never clickable. */
  loadingPill: {
    position: "absolute",
    bottom: "0.75rem",
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 10,
    padding: "0.3rem 0.75rem",
    backgroundColor: `${BG}e0`,
    color: MUTED,
    borderRadius: "999px",
    fontSize: "0.75rem",
    fontFamily: FONT,
    pointerEvents: "none",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: BORDER,
    whiteSpace: "nowrap",
  },

  // ── Dynamic-import placeholders ────────────────────────────────────────
  /**
   * flex h-full min-h-[400px] items-center justify-center bg-background/50
   * text-sm text-muted-foreground
   *
   * The two placeholders are the only part of this file that is theme-bound
   * rather than `map-layer-constants` palette: they are page chrome shown
   * before the canvas exists, so they bridge the semantic custom properties
   * the rest of the dashboard uses. `bg-background/50` is written out at the
   * utility's own alpha because a bridged variable has no channel left to
   * tint.
   */
  loading: {
    display: "flex",
    height: "100%",
    minHeight: "400px",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "hsl(var(--background) / 0.5)",
    fontSize: "0.875rem",
    lineHeight: "1.25rem",
    color: "hsl(var(--muted-foreground))",
  },
  /** h-full min-h-[400px] bg-background/50 — same plate, no copy. */
  loadingSilent: {
    height: "100%",
    minHeight: "400px",
    backgroundColor: "hsl(var(--background) / 0.5)",
  },

  // ── Hover tooltips and the cluster popover ─────────────────────────────
  /** Asset pin / cluster hover. Placement comes from the callsite. */
  assetTooltip: {
    position: "absolute",
    zIndex: 999,
    pointerEvents: "none",
    fontFamily: FONT,
    padding: "0.35rem 0.6rem",
    backgroundColor: `${BG}f2`,
    color: FG,
    borderRadius: "6px",
    fontSize: "0.8125rem",
    boxShadow: "0 2px 8px rgba(0,0,0,0.5)",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: BORDER,
  },
  tooltipText: { opacity: 0.7 },
  /** Feature hover: taller, scrollable, and capped so it cannot cover the map. */
  featureTooltip: {
    position: "absolute",
    zIndex: 999,
    pointerEvents: "none",
    fontFamily: FONT,
    padding: "0.4rem 0.65rem",
    backgroundColor: `${BG}f2`,
    color: FG,
    borderRadius: "6px",
    fontSize: "0.75rem",
    boxShadow: "0 2px 8px rgba(0,0,0,0.5)",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: BORDER,
    maxWidth: 280,
    maxHeight: 160,
    overflow: "auto",
  },
  featurePrimary: { fontSize: "0.75rem", fontWeight: 600, lineHeight: 1.35 },
  featureList: {
    listStyle: "none",
    margin: "0.35rem 0 0",
    padding: 0,
    display: "flex",
    flexDirection: "column",
    gap: "0.2rem",
  },
  featureItem: { color: MUTED, fontSize: "0.72rem", lineHeight: 1.3 },

  /** The cluster picker takes the pointer — it is a list of real choices. */
  clusterPopover: {
    position: "absolute",
    zIndex: 1000,
    pointerEvents: "auto",
    fontFamily: FONT,
    minWidth: 220,
    maxWidth: 300,
    padding: "0.75rem 1rem",
    backgroundColor: `${BG}fa`,
    color: FG,
    borderRadius: "8px",
    fontSize: "0.8125rem",
    boxShadow: "0 4px 16px rgba(0,0,0,0.6)",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: BORDER,
  },
  popoverHeading: { marginBottom: "0.5rem", color: MUTED, fontWeight: 500 },
  popoverList: { listStyle: "none", margin: 0, padding: 0 },
  popoverItem: { marginBottom: "0.25rem" },
  popoverAsset: {
    display: "block",
    width: "100%",
    textAlign: "left",
    padding: "0.5rem 0.6rem",
    backgroundColor: "rgba(255,255,255,0.05)",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: BORDER,
    borderRadius: "6px",
    color: FG,
    fontSize: "0.8125rem",
    fontFamily: FONT,
    cursor: "pointer",
  },
  popoverClose: {
    marginTop: "0.5rem",
    padding: "0.25rem 0.5rem",
    fontSize: "0.75rem",
    fontFamily: FONT,
    color: MUTED,
    backgroundColor: "transparent",
    borderStyle: "none",
    cursor: "pointer",
  },

  // ── Marker scaffolding ────────────────────────────────────────────────
  svgBlock: { display: "block" },
  svgOverflow: { display: "block", overflow: "visible" },
  /** A marker body that hosts an absolutely-placed card, chip or ring. */
  markerRelative: { position: "relative" },
  /** Pins are decoration until a click handler is wired. */
  markerInteractive: { pointerEvents: "auto", cursor: "pointer" },
  markerInert: { pointerEvents: "none", cursor: "default" },
  /** An emphasized pin draws over its neighbours. */
  markerAbove: { zIndex: 2 },
  markerBelow: { zIndex: 1 },
  cursorPointer: { cursor: "pointer" },
  cursorDefault: { cursor: "default" },
  pointerEventsAuto: { pointerEvents: "auto" },
  pointerEventsNone: { pointerEvents: "none" },

  // ── Search-result pins ────────────────────────────────────────────────
  pinSvg: { display: "block", filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.5))" },

  // ── World sensors (cameras) ───────────────────────────────────────────
  /** `MARKER_SIZE` in `WorldSensorLayers`; yaw and scale stay at the callsite. */
  sensorMarker: {
    position: "relative",
    width: "48px",
    height: "48px",
    overflow: "visible",
    pointerEvents: "auto",
    transformOrigin: "center center",
  },
  sensorLabel: {
    position: "absolute",
    left: "50%",
    top: "100%",
    whiteSpace: "nowrap",
    fontSize: "11px",
    fontFamily: "'Open Sans', sans-serif",
    fontWeight: 600,
    color: "#ffffff",
    textShadow: "-1px -1px 0 #0f172a, 1px -1px 0 #0f172a, -1px 1px 0 #0f172a, 1px 1px 0 #0f172a",
    pointerEvents: "none",
    marginTop: "2px",
  },

  // ── Measure tool overlay ──────────────────────────────────────────────
  /** The live preview pill must never swallow the second click. */
  measureMarker: { zIndex: 5 },
  measurePill: {
    display: "flex",
    alignItems: "center",
    gap: "0.4rem",
    padding: "0.25rem 0.6rem",
    backgroundColor: `${BG}f2`,
    color: FG,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: BORDER,
    borderRadius: "999px",
    fontSize: "0.75rem",
    fontFamily: FONT,
    whiteSpace: "nowrap",
    boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
  },
  /** A distance that changes as the cursor moves must not jitter its width. */
  measureValue: { fontVariantNumeric: "tabular-nums" },
  measureClear: {
    borderStyle: "none",
    backgroundColor: "transparent",
    color: MUTED,
    cursor: "pointer",
    padding: 0,
    fontSize: "0.8rem",
    lineHeight: 1,
  },

  // ── Intersection candidates ───────────────────────────────────────────
  /** The glyph IS the button: no chrome of its own. */
  bareButton: {
    backgroundColor: "transparent",
    borderStyle: "none",
    cursor: "pointer",
    display: "block",
    padding: 0,
    pointerEvents: "auto",
  },
  candidateFan: {
    display: "block",
    overflow: "visible",
    transformOrigin: "center",
    transition: "transform 120ms ease-out",
  },
  candidateFanHovered: { transform: "scale(1.08)" },
  /** Identity in place, above the fan, out of the pointer's way. */
  candidateCard: {
    pointerEvents: "none",
    position: "absolute",
    left: "50%",
    bottom: "calc(100% + 10px)",
    zIndex: 10,
    width: "220px",
    transform: "translateX(-50%)",
    borderRadius: 0,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "rgba(255,255,255,0.15)",
    backgroundColor: "rgba(0,0,0,0.9)",
    paddingInline: "0.625rem",
    paddingBlock: "0.5rem",
    boxShadow: "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)",
    backdropFilter: "blur(8px)",
  },
  candidateName: { fontSize: "12px", fontWeight: 600, lineHeight: 1.25, color: "#ffffff" },
  candidateMeta: { fontSize: "10px", color: "rgba(255,255,255,0.55)" },
  /** Only the first counts line is pushed off the name. */
  candidateMetaSpaced: { marginTop: "0.125rem" },
  candidateSplit: {
    marginTop: "0.25rem",
    fontSize: "10px",
    lineHeight: 1.375,
    color: "#F0B429",
  },
  candidateFooter: {
    marginTop: "0.375rem",
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderTopColor: "rgba(255,255,255,0.1)",
    paddingTop: "0.375rem",
  },
  candidateAction: { fontSize: "10px", fontWeight: 600, color: "#E8E044" },
  candidateId: { fontSize: "9px", color: "rgba(255,255,255,0.3)" },

  // ── Junction signal glyphs ────────────────────────────────────────────
  /** 1 px hook the floating signal card measures itself against. */
  signalAnchor: { display: "block", width: 1, height: 1, pointerEvents: "none" },
  /** Size and lamp colour follow the plan and the zoom; the rest is fixed. */
  junctionGlyph: {
    display: "block",
    borderRadius: 0,
    cursor: "pointer",
    pointerEvents: "auto",
    transition: "transform 120ms ease-out",
  },
  junctionGlyphHovered: { transform: "scale(1.12)" },
  /** Controlled: an opaque lamp in a white bezel. Otherwise: a hollow hint. */
  junctionControlled: {
    opacity: 0.95,
    borderWidth: "2px",
    borderStyle: "solid",
    borderColor: "rgba(255,255,255,0.92)",
  },
  junctionUncontrolled: {
    opacity: 0.4,
    backgroundColor: "transparent",
    borderWidth: "1.5px",
    borderStyle: "solid",
    borderColor: SIGNAL_UNKNOWN,
  },
  junctionUncontrolledHovered: { opacity: 0.7 },
  junctionSelected: {
    boxShadow: "0 0 0 3px rgba(232,224,68,0.35)",
    outline: "2px solid #E8E044",
  },
  junctionHoveredRing: { boxShadow: "0 0 0 2px rgba(232,224,68,0.22)" },
  /** Mode chip, hung under the glyph. */
  junctionChip: {
    pointerEvents: "none",
    position: "absolute",
    left: "50%",
    top: "calc(100% + 3px)",
    transform: "translateX(-50%)",
    whiteSpace: "nowrap",
    borderRadius: 0,
    backgroundColor: "rgba(0,0,0,0.75)",
    paddingInline: "0.25rem",
    paddingBlock: "1px",
    fontSize: "8px",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    color: "rgba(255,255,255,0.8)",
  },

  // ── Runtime actors ────────────────────────────────────────────────────
  /** Marker body. Size, scale and dim state come from the actor. */
  actorMarker: {
    position: "relative",
    overflow: "visible",
    transformOrigin: "center center",
    transition: "opacity 0.2s ease",
  },
  /**
   * A parity pair is the one place transparency MEANS something: the candidate
   * is drawn over the reference so the offset between them is readable, and
   * that only works if the top one is see-through.
   */
  actorTranslucent: { opacity: 0.5 },
  actorOpaque: { opacity: 1 },
  /** A preview actor is scenery: it never takes the pointer. */
  actorPreview: { pointerEvents: "none" },
  actorInteractive: { pointerEvents: "auto" },
  /** The icon hit target. Rotation is the actor's heading. */
  actorButton: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderStyle: "none",
    padding: 0,
    margin: 0,
    backgroundColor: "transparent",
    cursor: "pointer",
  },
  /** Fallback ink for an actor with no colour of its own. */
  actorDefaultColor: { color: "#f8fafc" },
  /** Hover card. `bottom` clears the marker, whose size is the actor's. */
  actorCard: {
    position: "absolute",
    left: "50%",
    transform: "translateX(-50%)",
    width: "max-content",
    minWidth: 132,
    maxWidth: 200,
    pointerEvents: "none",
    zIndex: 20,
    opacity: 0,
    animationName: hoverInfoFadeIn,
    animationDuration: "120ms",
    animationTimingFunction: "ease-out",
    animationFillMode: "forwards",
  },
  actorCardPlate: {
    overflow: "hidden",
    padding: "8px 10px 7px",
    backgroundColor: "rgba(10, 10, 10, 0.94)",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "rgba(232, 224, 68, 0.62)",
    boxShadow: "0 10px 28px rgba(0, 0, 0, 0.5)",
    backdropFilter: "blur(8px)",
    WebkitBackdropFilter: "blur(8px)",
    fontFamily: CARD_FONT,
  },
  actorCardTitle: {
    overflow: "hidden",
    color: "#ffffff",
    fontSize: 12,
    fontWeight: 700,
    lineHeight: 1.2,
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  actorCardHints: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    marginTop: 4,
    color: "rgba(248, 250, 252, 0.55)",
    fontSize: 8,
    fontWeight: 650,
    whiteSpace: "nowrap",
  },
  actorCardKey: { color: "#ffffff" },
  actorCardKeyAccent: { color: "#E8E044" },
  actorCardSeparator: { color: "rgba(255,255,255,0.22)" },
  /** The card's tail, a rotated square tucked under its plate. */
  actorCardTail: {
    position: "absolute",
    left: "50%",
    bottom: -5,
    transform: "translateX(-50%) rotate(45deg)",
    width: 8,
    height: 8,
    backgroundColor: "rgba(10, 10, 10, 0.96)",
    borderRightWidth: "1px",
    borderRightStyle: "solid",
    borderRightColor: "rgba(232, 224, 68, 0.78)",
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: "rgba(232, 224, 68, 0.78)",
  },
  /** Hold-to-move ring, drawn from 12 o'clock over the marker. */
  holdRing: {
    position: "absolute",
    inset: 0,
    pointerEvents: "none",
    transform: "rotate(-90deg)",
    transformOrigin: "center",
  },
  /** The dash offset itself is the circle's circumference — see the callsite. */
  holdRingTrack: {
    animationName: holdProgressFill,
    animationDuration: `${HOLD_TO_MOVE_MS}ms`,
    animationTimingFunction: "linear",
    animationFillMode: "forwards",
  },

  // ── 3D chrome ─────────────────────────────────────────────────────────
  /** 3D draws the models in GL; these markers only carry DOM chrome. */
  chromeMarker: { width: "56px", height: "56px", pointerEvents: "none" },
  chromeMarkerHost: {
    position: "relative",
    width: "56px",
    height: "56px",
    pointerEvents: "none",
  },
});
