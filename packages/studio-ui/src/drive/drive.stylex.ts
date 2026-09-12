/**
 * The driving simulator's own design tokens.
 *
 * Drive deliberately does not anchor on the Studio theme tokens
 * (`../stylex/tokens.stylex`). Those bridge `hsl(var(--…))` values that flip
 * with the `.dark` class, and half of them resolve against the dashboard's
 * light theme. The game is always a dark cockpit over a live world: its
 * chrome is a fixed instrument palette — near-black translucent panels, one
 * yellow for anything live or selected, and a white opacity ladder for type —
 * and it must not change when the surrounding app switches theme.
 *
 * The values here are exactly the ones the HUD, pause menu and pickers were
 * written with as Tailwind arbitrary values; naming them is what makes a
 * readout and a menu chip share one vocabulary instead of repeating
 * `bg-black/55` and hoping.
 */

import * as stylex from "@stylexjs/stylex";

/**
 * The instrument palette.
 *
 * `panel*` are the translucent blacks a HUD element sits on, ordered by how
 * much of the world they hold back. `accent*` is the single live/selected
 * colour. `text*` is a white opacity ladder, named for the role each step
 * plays rather than its alpha, because the steps are a hierarchy: a speed
 * reading is not dimmed, a camera name is.
 */
export const driveColors = stylex.defineVars({
  /** The backdrop behind every Drive screen and the session canvas. */
  void: "#050607",
  /** Pause-menu card: opaque enough to read a control panel through. */
  dialog: "rgba(7, 10, 12, 0.95)",
  /** Full-screen scrim behind the pause menu and the session status pill. */
  scrim: "rgba(0, 0, 0, 0.7)",
  /** Instrument disc — the g-meter face. */
  panelDial: "rgba(0, 0, 0, 0.45)",
  /** Readouts that must stay legible over bright sky: minimap, frame time. */
  panelReadout: "rgba(0, 0, 0, 0.55)",
  /** HUD toggles, which sit over the world and should not block it. */
  panelControl: "rgba(0, 0, 0, 0.4)",
  /** Picker thumbnail wells. */
  panelWell: "rgba(0, 0, 0, 0.4)",
  /** The preview stage behind the selected car. */
  panelStage: "rgba(0, 0, 0, 0.3)",

  /** Unselected picker rows: barely there, but not nothing. */
  glass: "rgba(255, 255, 255, 0.02)",
  /** Picker cards. */
  glassCard: "rgba(255, 255, 255, 0.03)",
  /** The "3D" model tag. */
  glassTag: "rgba(255, 255, 255, 0.1)",

  /** Hairlines, in the four weights the chrome actually uses. */
  lineFaint: "rgba(255, 255, 255, 0.1)",
  lineTrack: "rgba(255, 255, 255, 0.12)",
  line: "rgba(255, 255, 255, 0.15)",
  lineHover: "rgba(255, 255, 255, 0.3)",
  /** Hover weight for the larger menu and picker controls. */
  lineHoverStrong: "rgba(255, 255, 255, 0.35)",
  /** Hover weight for picker cards and rows. */
  lineHoverCard: "rgba(255, 255, 255, 0.25)",
  /** The g-meter crosshair. */
  lineCrosshair: "rgba(255, 255, 255, 0.1)",

  /** Live, selected, or driver-critical. The only chromatic UI colour. */
  accent: "#E8E044",
  accentBorder: "rgba(232, 224, 68, 0.7)",
  /** Fill behind an active toggle or chip. */
  accentWash: "rgba(232, 224, 68, 0.15)",
  /** Fill behind a selected list row — a row is wide, so it takes less. */
  accentWashRow: "rgba(232, 224, 68, 0.08)",
  /** Hover fill on an unselected card. */
  accentWashHover: "rgba(232, 224, 68, 0.06)",
  /** Type on a solid accent button. */
  accentText: "#000000",

  /** Past the redline: the tachometer arc, and nothing else. */
  redline: "#ff4d4d",
  /** Off the drivable surface. */
  offRoad: "#ff8a3d",
  /** The impact flash. */
  impact: "#ef4444",
  /** A failed map load or a spawn that could not be placed. */
  danger: "#fca5a5",

  /** Speed: the one number read at a glance. */
  textPrimary: "#ffffff",
  /** Map card titles. */
  textTitle: "rgba(255, 255, 255, 0.9)",
  /** Car names in the list. */
  textStrong: "rgba(255, 255, 255, 0.85)",
  /** The vehicle name on the HUD. */
  textVehicle: "rgba(255, 255, 255, 0.8)",
  /** Menu button labels. */
  textAction: "rgba(255, 255, 255, 0.75)",
  /** Body copy and the session status line. */
  textBody: "rgba(255, 255, 255, 0.7)",
  /** HUD toggle labels. */
  textControl: "rgba(255, 255, 255, 0.6)",
  /** Meta rows, secondary copy, the g readout. */
  textMeta: "rgba(255, 255, 255, 0.55)",
  /** Unit captions and back links. */
  textCaption: "rgba(255, 255, 255, 0.5)",
  /** Section labels, engine speed, card subtitles. */
  textDim: "rgba(255, 255, 255, 0.45)",
  /** The camera name — present, never read deliberately. */
  textFaint: "rgba(255, 255, 255, 0.4)",
  /** Vehicle footprints in the list. */
  textGhost: "rgba(255, 255, 255, 0.35)",
  /** A missing thumbnail's placeholder mark. */
  textPlaceholder: "rgba(255, 255, 255, 0.2)",
});

/**
 * Drive's corner radii.
 *
 * The game keeps its rounded chrome: pills for every toggle, soft cards for
 * the pickers. This is a separate scale from the Studio radius tokens on
 * purpose — the dashboard's is a sharp-corner instrument scale, and Drive is
 * not part of that surface.
 */
export const driveRadius = stylex.defineVars({
  /** Toggles, chips, action buttons, the minimap, the g-meter. */
  pill: "9999px",
  /** The pause card and the car preview stage. */
  dialog: "1.5rem",
  /** Map cards. */
  card: "1rem",
  /** Car rows. */
  row: "0.75rem",
  /** The frame-time readout. */
  chip: "0.375rem",
  /** The "3D" tag. */
  tag: "0.125rem",
});

/**
 * What sits over the world, and in what order.
 *
 * The HUD is `auto` by design: it is painted after the canvas in document
 * order and nothing needs to reach between them, so it never creates a
 * stacking context the session's own status line would have to escape. The
 * pause menu is the one layer that must be above everything.
 */
export const driveLayer = stylex.defineVars({
  hud: "auto",
  menu: "20",
});

/** Drive's type: a product face for headings, instrument faces for numbers. */
export const driveText = stylex.defineVars({
  fontBody: "var(--font-body), system-ui, sans-serif",
  fontDisplay: "var(--font-display), system-ui, sans-serif",
  /** The face for a number that is read while moving. */
  fontHeavy: "var(--font-heavy), system-ui, sans-serif",
  fontMeta: "var(--font-meta), ui-monospace, monospace",
  fontMono: "var(--font-mono), ui-monospace, monospace",

  /** 9px — the model tag, and only that. */
  sizeTag: "0.5625rem",
  /** 10px — unit captions and secondary instrument numbers. */
  sizeMicro: "0.625rem",
  /** 11px — every HUD label and toggle. */
  sizeMeta: "0.6875rem",

  /** Tracking for uppercase instrument type, which is illegible without it. */
  trackTag: "0.12em",
  trackControl: "0.14em",
  trackLabel: "0.18em",
  trackUnit: "0.2em",
  trackTitle: "0.22em",
});
