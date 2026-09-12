"use client";

import { Gauge, RotateCcw, Volume2, VolumeX } from "lucide-react";
import * as stylex from "@stylexjs/stylex";

import { DRIVE_CAMERA_KINDS, type DriveCameraKind } from "./cameras";
import { DriveButton, DrivePill, driveChrome } from "./chrome";
import { driveColors, driveRadius, driveText } from "./drive.stylex";

const CAMERA_LABELS: Readonly<Record<DriveCameraKind, string>> = {
  chase: "Chase",
  hood: "Hood",
  cockpit: "Cockpit",
  orbit: "Orbit",
};

const KEY_HELP: readonly (readonly [string, string])[] = [
  ["W / ↑", "Throttle"],
  ["S / ↓", "Brake"],
  ["A D / ← →", "Steer"],
  ["Space", "Handbrake"],
  ["R", "Respawn"],
  ["C", "Camera"],
  ["M", "Mute"],
  ["U", "Units"],
  ["T", "Traffic"],
  ["H", "Horn"],
  ["F3", "Frame time"],
  ["Esc", "Pause"],
];

const styles = stylex.create({
  card: {
    width: "100%",
    maxWidth: "48rem",
    padding: "1.75rem",
  },
  header: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: "1rem",
  },
  title: {
    margin: 0,
    fontFamily: driveText.fontDisplay,
    fontSize: "1.5rem",
    lineHeight: "2rem",
    fontWeight: 600,
    letterSpacing: "-0.025em",
  },
  /** Which device is driving. Reads as an instrument line, not a sentence. */
  device: {
    fontSize: driveText.sizeMeta,
    textTransform: "uppercase",
    letterSpacing: driveText.trackLabel,
    color: driveColors.textFaint,
  },
  deviceLive: { color: driveColors.accent },

  body: {
    marginTop: "1.5rem",
    display: "grid",
    gap: "1.5rem",
    gridTemplateColumns: {
      default: null,
      "@media (min-width: 640px)": "repeat(2, minmax(0, 1fr))",
    },
  },
  settings: {
    display: "flex",
    flexDirection: "column",
    gap: "1.25rem",
  },
  group: {
    margin: 0,
    borderStyle: "none",
    padding: 0,
    minInlineSize: 0,
  },
  groupLabel: {
    marginBottom: "0.5rem",
    padding: 0,
    display: "block",
  },
  chips: {
    display: "flex",
    flexWrap: "wrap",
    gap: "0.375rem",
  },

  audioRow: {
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
  },
  /** The mute button: a round icon control, so it is its own shape. */
  mute: {
    display: "grid",
    width: "2.25rem",
    height: "2.25rem",
    flexShrink: 0,
    placeItems: "center",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: {
      default: driveColors.line,
      ":hover": driveColors.lineHoverStrong,
    },
    borderRadius: driveRadius.pill,
    backgroundColor: "transparent",
    padding: 0,
    color: driveColors.textBody,
    cursor: "pointer",
    transitionProperty: "color, border-color",
    transitionDuration: "150ms",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    outlineStyle: { default: "none", ":focus-visible": "solid" },
    outlineWidth: "2px",
    outlineColor: driveColors.accent,
    outlineOffset: "2px",
  },
  muteActive: { color: driveColors.accent },
  icon: {
    width: "1rem",
    height: "1rem",
  },
  slider: {
    height: "0.25rem",
    minWidth: 0,
    flex: 1,
    accentColor: driveColors.accent,
    cursor: "pointer",
  },
  /** The level as a number: this menu is the only place it can be read. */
  volumeReadout: {
    width: "2.5rem",
    flexShrink: 0,
    textAlign: "right",
    color: driveColors.textFaint,
  },

  checkboxRow: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    color: driveColors.textControl,
    cursor: "pointer",
  },
  checkbox: {
    width: "0.875rem",
    height: "0.875rem",
    accentColor: driveColors.accent,
    cursor: "pointer",
  },
  smallIcon: {
    width: "0.875rem",
    height: "0.875rem",
  },

  keys: {
    margin: 0,
    marginTop: "0.5rem",
    display: "grid",
    gridTemplateColumns: "auto 1fr",
    columnGap: "0.75rem",
    rowGap: "0.25rem",
    fontSize: "0.75rem",
    lineHeight: "1rem",
  },
  keyPair: { display: "contents" },
  keyCap: {
    fontFamily: driveText.fontMono,
    color: driveColors.textDim,
  },
  keyLabel: {
    margin: 0,
    color: driveColors.textBody,
  },

  actions: {
    marginTop: "1.75rem",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "0.5rem",
  },
  /** The way out sits apart from the ways back in. */
  exit: { marginLeft: "auto" },
});

/**
 * The pause overlay: audio, camera, the key map, and the ways out.
 *
 * Drawn over a live world that keeps advancing — the physics does not stop,
 * because a session that freezes and resumes on a menu makes traffic teleport.
 * Only input is suspended while this is up.
 */
export function PauseMenu({
  cameraKind,
  muted,
  volume,
  gamepadConnected,
  debug,
  onResume,
  onCameraKind,
  onMutedChange,
  onVolumeChange,
  onDebugChange,
  onRespawn,
  onChangeCar,
  onExit,
}: {
  cameraKind: DriveCameraKind;
  muted: boolean;
  /** Master volume, 0..1. */
  volume: number;
  gamepadConnected: boolean;
  debug: boolean;
  onResume: () => void;
  onCameraKind: (kind: DriveCameraKind) => void;
  onMutedChange: (muted: boolean) => void;
  onVolumeChange: (volume: number) => void;
  onDebugChange: (debug: boolean) => void;
  onRespawn: () => void;
  onChangeCar: () => void;
  onExit: () => void;
}) {
  const level = muted ? 0 : volume;
  return (
    <div
      {...stylex.props(driveChrome.menuLayer)}
      data-testid="drive-pause-menu"
      role="dialog"
      aria-label="Paused"
    >
      <div {...stylex.props(driveChrome.panelDialog, styles.card)}>
        <div {...stylex.props(styles.header)}>
          <h2 {...stylex.props(styles.title)}>Paused</h2>
          <span {...stylex.props(styles.device, gamepadConnected && styles.deviceLive)}>
            {gamepadConnected ? "Gamepad connected" : "Keyboard"}
          </span>
        </div>

        <div {...stylex.props(styles.body)}>
          <div {...stylex.props(styles.settings)}>
            <fieldset {...stylex.props(styles.group)}>
              <legend {...stylex.props(driveChrome.sectionLabel, styles.groupLabel)}>
                Camera
              </legend>
              <div {...stylex.props(styles.chips)}>
                {DRIVE_CAMERA_KINDS.map((kind) => (
                  <DrivePill
                    active={kind === cameraKind}
                    aria-pressed={kind === cameraKind}
                    data-camera-kind={kind}
                    key={kind}
                    onClick={() => onCameraKind(kind)}
                    size="chip"
                  >
                    {CAMERA_LABELS[kind]}
                  </DrivePill>
                ))}
              </div>
            </fieldset>

            <fieldset {...stylex.props(styles.group)}>
              <legend {...stylex.props(driveChrome.sectionLabel, styles.groupLabel)}>
                Audio
              </legend>
              <div {...stylex.props(styles.audioRow)}>
                <button
                  {...stylex.props(styles.mute, muted && styles.muteActive)}
                  aria-label={muted ? "Unmute" : "Mute"}
                  aria-pressed={muted}
                  data-testid="drive-mute"
                  onClick={() => onMutedChange(!muted)}
                  type="button"
                >
                  {muted
                    ? <VolumeX {...stylex.props(styles.icon)} />
                    : <Volume2 {...stylex.props(styles.icon)} />}
                </button>
                <input
                  {...stylex.props(styles.slider)}
                  aria-label="Master volume"
                  max={1}
                  min={0}
                  onChange={(event) => onVolumeChange(Number(event.target.value))}
                  step={0.01}
                  type="range"
                  value={level}
                />
                <span {...stylex.props(driveChrome.monoMicro, styles.volumeReadout)}>
                  {Math.round(level * 100)}%
                </span>
              </div>
            </fieldset>

            <label {...stylex.props(styles.checkboxRow)}>
              <input
                {...stylex.props(styles.checkbox)}
                checked={debug}
                onChange={(event) => onDebugChange(event.target.checked)}
                type="checkbox"
              />
              <Gauge {...stylex.props(styles.smallIcon)} aria-hidden="true" />
              Show frame time
            </label>
          </div>

          <div>
            <p {...stylex.props(driveChrome.sectionLabel)}>Controls</p>
            <dl {...stylex.props(styles.keys)}>
              {KEY_HELP.map(([keys, label]) => (
                <div {...stylex.props(styles.keyPair)} key={label}>
                  <dt {...stylex.props(styles.keyCap)}>{keys}</dt>
                  <dd {...stylex.props(styles.keyLabel)}>{label}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>

        <div {...stylex.props(styles.actions)}>
          <DriveButton data-testid="drive-resume" onClick={onResume} tone="primary">
            Resume
          </DriveButton>
          <DriveButton data-testid="drive-respawn" onClick={onRespawn}>
            <RotateCcw {...stylex.props(styles.icon)} aria-hidden="true" />
            Respawn
          </DriveButton>
          <DriveButton onClick={onChangeCar}>Change car</DriveButton>
          <DriveButton onClick={onExit} tone="quiet" xstyle={styles.exit}>
            Leave map
          </DriveButton>
        </div>
      </div>
    </div>
  );
}
