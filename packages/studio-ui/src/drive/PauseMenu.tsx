"use client";

import { Gauge, RotateCcw, Volume2, VolumeX } from "lucide-react";

import { DRIVE_CAMERA_KINDS, type DriveCameraKind } from "./cameras";

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
  return (
    <div
      className="absolute inset-0 z-20 grid place-items-center bg-black/70 px-6 backdrop-blur-sm"
      data-testid="drive-pause-menu"
      role="dialog"
      aria-label="Paused"
    >
      <div className="w-full max-w-3xl rounded-3xl border border-white/10 bg-[#070a0c]/95 p-7 text-white shadow-2xl">
        <div className="flex items-baseline justify-between">
          <h2 className="font-display text-2xl font-semibold tracking-tight">Paused</h2>
          <span className="text-[11px] uppercase tracking-[0.18em] text-white/40">
            {gamepadConnected ? "Gamepad connected" : "Keyboard"}
          </span>
        </div>

        <div className="mt-6 grid gap-6 sm:grid-cols-2">
          <div className="space-y-5">
            <div>
              <p className="text-[11px] uppercase tracking-[0.18em] text-white/45">Camera</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {DRIVE_CAMERA_KINDS.map((kind) => (
                  <button
                    aria-pressed={kind === cameraKind}
                    className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                      kind === cameraKind
                        ? "border-[#E8E044]/70 bg-[#E8E044]/15 text-[#E8E044]"
                        : "border-white/15 text-white/60 hover:border-white/35"
                    }`}
                    data-camera-kind={kind}
                    key={kind}
                    onClick={() => onCameraKind(kind)}
                    type="button"
                  >
                    {CAMERA_LABELS[kind]}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <p className="text-[11px] uppercase tracking-[0.18em] text-white/45">Audio</p>
              <div className="mt-2 flex items-center gap-3">
                <button
                  aria-label={muted ? "Unmute" : "Mute"}
                  className="grid size-9 place-items-center rounded-full border border-white/15 text-white/70 transition-colors hover:border-white/35"
                  data-testid="drive-mute"
                  onClick={() => onMutedChange(!muted)}
                  type="button"
                >
                  {muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
                </button>
                <input
                  aria-label="Master volume"
                  className="h-1 flex-1 accent-[#E8E044]"
                  max={1}
                  min={0}
                  onChange={(event) => onVolumeChange(Number(event.target.value))}
                  step={0.01}
                  type="range"
                  value={muted ? 0 : volume}
                />
              </div>
            </div>

            <label className="flex items-center gap-2 text-xs text-white/60">
              <input
                checked={debug}
                className="size-3.5 accent-[#E8E044]"
                onChange={(event) => onDebugChange(event.target.checked)}
                type="checkbox"
              />
              <Gauge className="size-3.5" aria-hidden="true" />
              Show frame time
            </label>
          </div>

          <div>
            <p className="text-[11px] uppercase tracking-[0.18em] text-white/45">Controls</p>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              {KEY_HELP.map(([keys, label]) => (
                <div className="contents" key={label}>
                  <dt className="font-mono text-white/45">{keys}</dt>
                  <dd className="text-white/70">{label}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>

        <div className="mt-7 flex flex-wrap items-center gap-2">
          <button
            className="rounded-full bg-[#E8E044] px-6 py-2.5 font-display text-sm font-semibold text-black transition-opacity hover:opacity-90"
            data-testid="drive-resume"
            onClick={onResume}
            type="button"
          >
            Resume
          </button>
          <button
            className="flex items-center gap-1.5 rounded-full border border-white/15 px-4 py-2.5 text-sm text-white/75 transition-colors hover:border-white/35"
            data-testid="drive-respawn"
            onClick={onRespawn}
            type="button"
          >
            <RotateCcw className="size-4" aria-hidden="true" />
            Respawn
          </button>
          <button
            className="rounded-full border border-white/15 px-4 py-2.5 text-sm text-white/75 transition-colors hover:border-white/35"
            onClick={onChangeCar}
            type="button"
          >
            Change car
          </button>
          <button
            className="ml-auto rounded-full px-4 py-2.5 text-sm text-white/45 transition-colors hover:text-white/80"
            onClick={onExit}
            type="button"
          >
            Leave map
          </button>
        </div>
      </div>
    </div>
  );
}
