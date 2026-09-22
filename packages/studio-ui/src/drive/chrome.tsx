"use client";

/**
 * Drive's shared chrome: the styles every simulator surface draws from, and
 * the two controls that genuinely repeat.
 *
 * Everything here is built on `./drive.stylex`, so the HUD, the pause menu and
 * the two pickers cannot drift apart. It is deliberately mostly *styles*
 * rather than components: the HUD writes into its elements by ref every frame,
 * and wrapping those spans in components would add a DOM layer and a ref hop
 * for nothing. Only the pill and the action button — which repeat across four
 * files with an active/idle state each — are components.
 */

import type { ButtonHTMLAttributes, ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";

import { driveColors, driveLayer, driveRadius, driveText } from "./drive.stylex";
import { motion, shadows, space, stroke, text } from "../stylex/tokens.stylex";

/** Tailwind's colour transition, kept identical while both systems coexist. */
const COLOR_TRANSITION =
  "color, background-color, border-color, text-decoration-color, fill, stroke";

export const driveChrome = stylex.create({
  /**
   * A layer over the live world. Transparent to the mouse and to selection,
   * because everything under it is a 3D view the player is driving through;
   * the pieces that are interactive opt back in with `interactive`.
   */
  worldOverlay: {
    position: "absolute",
    inset: 0,
    zIndex: driveLayer.hud,
    pointerEvents: "none",
    userSelect: "none",
    fontFamily: driveText.fontBody,
    color: driveColors.textPrimary,
  },
  /** Opt an overlay child back into pointer input. */
  interactive: {
    pointerEvents: "auto",
  },
  /**
   * The one layer that covers the HUD: the pause menu. The world keeps
   * advancing underneath, which is why it is scrimmed and blurred rather than
   * replaced.
   */
  menuLayer: {
    position: "absolute",
    inset: 0,
    zIndex: driveLayer.menu,
    display: "grid",
    placeItems: "center",
    paddingInline: space.s6,
    backgroundColor: driveColors.scrim,
    backdropFilter: motion.blurSm,
  },

  /** A full Drive screen outside a session: the pickers. */
  screen: {
    position: "relative",
    minHeight: "100svh",
    overflow: "hidden",
    backgroundColor: driveColors.void,
    backgroundImage:
      "radial-gradient(120% 90% at 78% -10%, #153c4e 0%, #0b1a24 45%, #050607 100%)",
    color: driveColors.textPrimary,
  },

  /** The pause card: a control panel, so it holds back most of the world. */
  panelDialog: {
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: driveColors.lineFaint,
    borderRadius: driveRadius.dialog,
    backgroundColor: driveColors.dialog,
    boxShadow: shadows.elevation2xl,
    color: driveColors.textPrimary,
  },
  /** A number that has to stay legible over bright sky. */
  panelReadout: {
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: driveColors.lineFaint,
    borderRadius: driveRadius.chip,
    backgroundColor: driveColors.panelReadout,
  },
  /** The session's own line: loading, starting, or why it could not spawn. */
  panelStatus: {
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: driveColors.lineFaint,
    borderRadius: driveRadius.pill,
    backgroundColor: driveColors.scrim,
  },
  /** An instrument face — round, dark, ruled. */
  panelDial: {
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: driveColors.line,
    borderRadius: driveRadius.pill,
    backgroundColor: driveColors.panelDial,
  },

  /** Uppercase instrument label: the HUD meta row and its kin. */
  metaRow: {
    fontSize: driveText.sizeMeta,
    textTransform: "uppercase",
    letterSpacing: driveText.trackLabel,
    color: driveColors.textMeta,
  },
  /** A section heading inside the pause menu. */
  sectionLabel: {
    fontSize: driveText.sizeMeta,
    textTransform: "uppercase",
    letterSpacing: driveText.trackLabel,
    color: driveColors.textDim,
  },
  /** Any number that changes while the player watches it. */
  numeric: {
    fontVariantNumeric: "tabular-nums",
  },
  /** A small monospaced instrument number: engine speed, g, frame time. */
  monoMicro: {
    fontFamily: driveText.fontMono,
    fontSize: driveText.sizeMicro,
    fontVariantNumeric: "tabular-nums",
  },
});

const controls = stylex.create({
  base: {
    display: "inline-flex",
    alignItems: "center",
    borderRadius: driveRadius.pill,
    transitionProperty: COLOR_TRANSITION,
    transitionDuration: motion.durStandard,
    transitionTimingFunction: motion.easeStandard,
  },
  /** A HUD toggle: instrument type, always uppercase. */
  hud: {
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    paddingInline: space.s3,
    paddingBlock: space.s1,
    fontSize: driveText.sizeMeta,
    textTransform: "uppercase",
    letterSpacing: driveText.trackControl,
  },
  /** A menu chip: the same shape at reading size, in the product face. */
  chip: {
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    paddingInline: space.s3,
    paddingBlock: space.s1,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
  },
  /** Live or selected. The yellow is the whole signal. */
  active: {
    borderColor: driveColors.accentBorder,
    backgroundColor: driveColors.accentWash,
    color: driveColors.accent,
  },
  hudIdle: {
    borderColor: {
      default: driveColors.line,
      ":hover": driveColors.lineHover,
    },
    backgroundColor: driveColors.panelControl,
    color: driveColors.textControl,
  },
  chipIdle: {
    borderColor: {
      default: driveColors.line,
      ":hover": driveColors.lineHoverStrong,
    },
    color: driveColors.textControl,
  },

  action: {
    gap: space.s2,
    paddingBlock: space.s2_5,
    fontSize: text.sizeSm,
    lineHeight: text.lineSm,
  },
  /** The way forward out of a screen: solid accent, black type. */
  primary: {
    paddingInline: space.s6,
    borderStyle: "none",
    backgroundColor: driveColors.accent,
    fontFamily: driveText.fontDisplay,
    fontWeight: text.weightSemibold,
    color: driveColors.accentText,
    opacity: {
      default: 1,
      ":hover": 0.9,
      ":disabled": 0.4,
    },
    transitionProperty: "opacity",
  },
  /** An alternative action: outlined, quiet until hovered. */
  secondary: {
    paddingInline: space.s4,
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: {
      default: driveColors.line,
      ":hover": driveColors.lineHoverStrong,
    },
    color: driveColors.textAction,
  },
  /** The way out. Present, but never competing with the way forward. */
  quiet: {
    paddingInline: space.s4,
    borderStyle: "none",
    backgroundColor: "transparent",
    color: {
      default: driveColors.textDim,
      ":hover": driveColors.textVehicle,
    },
  },
});

/**
 * What a Drive control accepts.
 *
 * `className`/`style` are deliberately not part of it: these components own
 * both slots through StyleX, and a caller that needs to change one passes
 * `xstyle` so the rules stay in the compiled stylesheet. `data-*` is spelled
 * out because TypeScript only infers those on intrinsic elements, and the
 * simulator's surfaces are addressed by `data-testid` in the harness.
 */
type DriveControlProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "className" | "style"
> & {
  xstyle?: stylex.StyleXStyles;
  children: ReactNode;
} & { [dataAttribute: `data-${string}`]: string | undefined };

/**
 * A pill toggle.
 *
 * `active` is the only state that carries colour, which is what makes a lit
 * pill mean "this is on" everywhere in Drive — traffic, units, camera.
 */
export function DrivePill({
  active = false,
  size = "hud",
  xstyle,
  children,
  ...buttonProps
}: DriveControlProps & {
  active?: boolean;
  /** `hud` is an overlay toggle; `chip` is a menu choice. */
  size?: "hud" | "chip";
}) {
  return (
    <button
      type="button"
      {...buttonProps}
      {...stylex.props(
        controls.base,
        controls[size],
        active ? controls.active : size === "hud" ? controls.hudIdle : controls.chipIdle,
        xstyle,
      )}
    >
      {children}
    </button>
  );
}

/** A menu or picker action button. */
export function DriveButton({
  tone = "secondary",
  xstyle,
  children,
  ...buttonProps
}: DriveControlProps & {
  tone?: "primary" | "secondary" | "quiet";
}) {
  return (
    <button
      type="button"
      {...buttonProps}
      {...stylex.props(controls.base, controls.action, controls[tone], xstyle)}
    >
      {children}
    </button>
  );
}
