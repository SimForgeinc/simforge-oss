"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Gamepad2, Keyboard, Play } from "lucide-react";

import { Badge } from "@simforge-oss/studio-ui/components/ui/badge";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import { Card, CardContent } from "@simforge-oss/studio-ui/components/ui/card";
import { SelectMenu } from "@simforge-oss/studio-ui/components/ui/select-menu";
import { Switch } from "@simforge-oss/studio-ui/components/ui/switch";
import { cn } from "@simforge-oss/studio-ui/lib/utils";
import type { ControlInput, WorldSource, WorldSourceStatus } from "@/app/lib/live-world/types";

import {
  applyKeyboardState,
  applyWheelSample,
  DRIVING_KEY_CODES,
  detectMovedInput,
  MAX_DEADZONE,
  neutralize,
  pedalsReleased,
  steeringCalibrationValid,
  wheelProfileRefusal,
  type DriveCommand,
  type InputMode,
  type PedalBinding,
  type WheelProfile,
} from "./input/driving-input";
import {
  loadInputMode,
  loadPreferredDeviceKey,
  loadWheelProfile,
  persistInputMode,
  persistPreferredDeviceKey,
  persistWheelProfile,
} from "./input/driving-profiles";
import {
  detectGamepadSupport,
  readGamepads,
  samplePad,
  syncDeviceList,
  type GamepadDeviceInfo,
  type GamepadSupport,
} from "./input/gamepad-devices";

const TICK_MS = 50;
const PUBLISH_EVERY_TICKS = 2;
const LISTEN_THRESHOLD = 0.5;

const INTERACTIVE_ROLES: Record<string, true> = {
  button: true, menuitem: true, menuitemradio: true, menuitemcheckbox: true, radio: true,
  checkbox: true, slider: true, textbox: true, combobox: true, switch: true, option: true, tab: true,
};

type BindingTarget = "steer" | "throttle" | "brake" | "reverse";

type CalibrationStep =
  | { target: "steer"; step: "center" | "left" | "right"; center: number; left: number }
  | { target: "throttle" | "brake"; step: "released" | "pressed"; released: number };

interface LiveReadout {
  steer: number;
  throttle: number;
  brake: number;
  reverse: boolean;
  padConnected: boolean;
  axes: number[];
  buttons: number[];
}

const EMPTY_LIVE: LiveReadout = { steer: 0, throttle: 0, brake: 0, reverse: false, padConnected: false, axes: [], buttons: [] };

function shieldedTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON" || (tag === "A" && target.hasAttribute("href"))) return true;
  const role = target.getAttribute("role");
  return role !== null && INTERACTIVE_ROLES[role] === true;
}

function bindingLabel(binding: PedalBinding | null): string {
  if (!binding) return "Unbound";
  return `${binding.kind === "axis" ? "Axis" : "Button"} ${binding.index}`;
}

export function DrivingControls({ source, actorId }: { source: WorldSource | null; actorId: string | null }) {
  const [mode, setMode] = useState<InputMode>("keyboard");
  const [support, setSupport] = useState<GamepadSupport>({ supported: false, reason: null });
  const [devices, setDevices] = useState<GamepadDeviceInfo[]>([]);
  const [deviceKey, setDeviceKey] = useState<string | null>(null);
  const [profile, setProfile] = useState<WheelProfile | null>(null);
  const [engaged, setEngaged] = useState(false);
  const [pauseReason, setPauseReason] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sourceStatus, setSourceStatus] = useState<WorldSourceStatus>("idle");
  const [live, setLive] = useState<LiveReadout>(EMPTY_LIVE);
  const [listening, setListening] = useState<BindingTarget | null>(null);
  const [calibration, setCalibration] = useState<CalibrationStep | null>(null);

  const modeRef = useRef<InputMode>("keyboard");
  const profileRef = useRef<WheelProfile | null>(null);
  const deviceKeyRef = useRef<string | null>(null);
  const supportedRef = useRef(false);
  const engagedRef = useRef(false);
  const actorIdRef = useRef<string | null>(null);
  const sourceRef = useRef<WorldSource | null>(null);
  const sourceRunningRef = useRef(false);
  const lastControlledRef = useRef<{ source: WorldSource; actorId: string } | null>(null);
  const commandRef = useRef<DriveCommand>({ steer: 0, throttle: 0, brake: 0, reverse: false });
  const controlRef = useRef<ControlInput>({ actorId: "", steer: 0, throttle: 0, brake: 0, reverse: false });
  const pressedRef = useRef(new Set<string>());
  const axesRef = useRef<number[]>([]);
  const buttonsRef = useRef<number[]>([]);
  const padConnectedRef = useRef(false);
  const reverseEdgeRef = useRef({ reverseButtonDown: false });
  const listenRef = useRef<{ target: BindingTarget; axes: number[]; buttons: number[] } | null>(null);
  const devicesRef = useRef<GamepadDeviceInfo[]>([]);

  const transmit = useCallback((target: WorldSource, targetActorId: string, command: Readonly<DriveCommand>): boolean => {
    const control = controlRef.current;
    control.actorId = targetActorId;
    control.steer = command.steer;
    control.throttle = command.throttle;
    control.brake = command.brake;
    control.reverse = command.reverse;
    try {
      target.control(control);
      lastControlledRef.current = lastControlledRef.current?.source === target && lastControlledRef.current.actorId === targetActorId
        ? lastControlledRef.current
        : { source: target, actorId: targetActorId };
      return true;
    } catch (caught) {
      setError(`World rejected control: ${caught instanceof Error ? caught.message : String(caught)}`);
      return false;
    }
  }, []);

  const disengage = useCallback((reason: string) => {
    const wasEngaged = engagedRef.current;
    engagedRef.current = false;
    neutralize(commandRef.current);
    pressedRef.current.clear();
    reverseEdgeRef.current.reverseButtonDown = false;
    const last = lastControlledRef.current;
    if (last) {
      lastControlledRef.current = null;
      try {
        controlRef.current.actorId = last.actorId;
        controlRef.current.steer = 0;
        controlRef.current.throttle = 0;
        controlRef.current.brake = 0;
        controlRef.current.reverse = false;
        last.source.control(controlRef.current);
      } catch {
        // the world is gone or refused the neutral command; nothing further to release
      }
    }
    if (wasEngaged) {
      setEngaged(false);
      setPauseReason(reason);
    }
  }, []);

  const engage = useCallback((): string | null => {
    if (!actorIdRef.current) return "No vehicle is being driven.";
    if (!sourceRef.current || !sourceRunningRef.current) return "The world is not running.";
    if (modeRef.current === "wheel") {
      const current = profileRef.current;
      if (!current) return "Select a wheel first.";
      if (!padConnectedRef.current) return "The selected wheel is not connected.";
      const refusal = wheelProfileRefusal(current);
      if (refusal) return refusal;
      if (!pedalsReleased(commandRef.current)) return "Release the pedals before engaging.";
    } else {
      pressedRef.current.clear();
      neutralize(commandRef.current);
    }
    engagedRef.current = true;
    setEngaged(true);
    setPauseReason(null);
    setError(null);
    return null;
  }, []);

  const updateProfile = useCallback((mutate: (draft: WheelProfile) => void) => {
    const current = profileRef.current;
    if (!current) return;
    const next: WheelProfile = {
      deviceKey: current.deviceKey,
      steer: { binding: current.steer.binding, calibration: { ...current.steer.calibration } },
      throttle: { binding: current.throttle.binding, calibration: { ...current.throttle.calibration } },
      brake: { binding: current.brake.binding, calibration: { ...current.brake.calibration } },
      reverse: current.reverse,
    };
    mutate(next);
    profileRef.current = next;
    setProfile(next);
    persistWheelProfile(next);
  }, []);

  useEffect(() => {
    const storedMode = loadInputMode();
    const detected = detectGamepadSupport();
    modeRef.current = storedMode;
    supportedRef.current = detected.supported;
    setMode(storedMode);
    setSupport(detected);
    const preferred = loadPreferredDeviceKey();
    if (preferred) {
      deviceKeyRef.current = preferred;
      profileRef.current = loadWheelProfile(preferred);
      setDeviceKey(preferred);
      setProfile(profileRef.current);
    }
  }, []);

  useEffect(() => {
    const previous = actorIdRef.current;
    actorIdRef.current = actorId;
    if (previous !== actorId) disengage(previous ? "The driven vehicle changed." : "Driving stopped.");
  }, [actorId, disengage]);

  useEffect(() => {
    sourceRef.current = source;
    disengage("The world restarted.");
    if (!source) {
      sourceRunningRef.current = false;
      setSourceStatus("idle");
      return;
    }
    return source.subscribeStatus((status, statusError) => {
      sourceRunningRef.current = status === "running";
      setSourceStatus(status);
      if (status !== "running") disengage(status === "error" ? `The world reported an error${statusError ? `: ${statusError}` : "."}` : "The world is not running.");
    });
  }, [source, disengage]);

  useEffect(() => () => disengage("Controls unmounted."), [disengage]);

  useEffect(() => {
    const onBlur = () => disengage("The window lost focus.");
    const onVisibility = () => {
      if (document.visibilityState !== "visible") disengage("The tab was hidden.");
    };
    const onPadLost = (event: GamepadEvent) => {
      if (modeRef.current === "wheel" && event.gamepad.id === deviceKeyRef.current) disengage("The wheel disconnected.");
    };
    window.addEventListener("blur", onBlur);
    window.addEventListener("pagehide", onBlur);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("gamepaddisconnected", onPadLost);
    return () => {
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("pagehide", onBlur);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("gamepaddisconnected", onPadLost);
    };
  }, [disengage]);

  useEffect(() => {
    if (mode !== "keyboard") return;
    const pressed = pressedRef.current;
    const keyDown = (event: KeyboardEvent) => {
      if (!DRIVING_KEY_CODES[event.code] || event.isComposing || shieldedTarget(event.target)) return;
      event.preventDefault();
      if (event.repeat) return;
      if (!engagedRef.current) {
        const refusal = engage();
        if (refusal) {
          setPauseReason(refusal);
          return;
        }
      }
      pressed.add(event.code);
      if (event.code === "KeyR") commandRef.current.reverse = !commandRef.current.reverse;
    };
    const keyUp = (event: KeyboardEvent) => {
      if (!DRIVING_KEY_CODES[event.code]) return;
      if (!shieldedTarget(event.target)) event.preventDefault();
      pressed.delete(event.code);
    };
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    return () => {
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
      pressed.clear();
    };
  }, [engage, mode]);

  useEffect(() => {
    let ticks = 0;
    const published: LiveReadout = { ...EMPTY_LIVE };
    const tick = () => {
      ticks += 1;
      const command = commandRef.current;
      const axes = axesRef.current;
      const buttons = buttonsRef.current;
      let pad: Gamepad | null = null;
      if (supportedRef.current) {
        const pads = readGamepads();
        if (pads) {
          const nextDevices = syncDeviceList(pads, devicesRef.current);
          if (nextDevices !== devicesRef.current) {
            devicesRef.current = nextDevices;
            setDevices(nextDevices);
          }
          const wanted = deviceKeyRef.current;
          if (wanted !== null) {
            for (const candidate of pads) {
              if (candidate && candidate.connected && candidate.id === wanted) {
                pad = candidate;
                break;
              }
            }
          }
        }
      }
      const padConnected = pad !== null;
      if (padConnected !== padConnectedRef.current) {
        padConnectedRef.current = padConnected;
        if (!padConnected && modeRef.current === "wheel") disengage("The wheel disconnected.");
      }
      if (pad) {
        samplePad(pad, axes, buttons);
        const listen = listenRef.current;
        if (listen) {
          const moved = detectMovedInput(listen, { axes, buttons }, LISTEN_THRESHOLD);
          if (moved) {
            listenRef.current = null;
            setListening(null);
            updateProfile((draft) => {
              if (listen.target === "steer") {
                if (moved.kind === "axis") draft.steer.binding = moved;
              } else if (listen.target === "reverse") {
                if (moved.kind === "button") draft.reverse = moved;
              } else {
                draft[listen.target].binding = moved;
              }
            });
          }
        }
      } else {
        axes.length = 0;
        buttons.length = 0;
      }

      if (modeRef.current === "keyboard") {
        const pressed = pressedRef.current;
        applyKeyboardState((code) => pressed.has(code), command);
      } else if (pad && profileRef.current) {
        applyWheelSample({ axes, buttons }, profileRef.current, command, reverseEdgeRef.current);
      } else {
        neutralize(command);
      }

      if (engagedRef.current) {
        const target = sourceRef.current;
        const targetActorId = actorIdRef.current;
        if (target && targetActorId && sourceRunningRef.current) {
          if (!transmit(target, targetActorId, command)) disengage("The world rejected the control command.");
        }
      }

      if (ticks % PUBLISH_EVERY_TICKS !== 0) return;
      const wheelPanel = modeRef.current === "wheel";
      let changed = published.steer !== command.steer || published.throttle !== command.throttle
        || published.brake !== command.brake || published.reverse !== command.reverse || published.padConnected !== padConnected;
      if (!changed && wheelPanel) {
        changed = published.axes.length !== axes.length || published.buttons.length !== buttons.length;
        for (let index = 0; !changed && index < axes.length; index += 1) changed = published.axes[index] !== axes[index];
        for (let index = 0; !changed && index < buttons.length; index += 1) changed = published.buttons[index] !== buttons[index];
      }
      if (!changed) return;
      published.steer = command.steer;
      published.throttle = command.throttle;
      published.brake = command.brake;
      published.reverse = command.reverse;
      published.padConnected = padConnected;
      published.axes = wheelPanel ? axes.slice() : [];
      published.buttons = wheelPanel ? buttons.slice() : [];
      setLive({ ...published });
    };
    const interval = window.setInterval(tick, TICK_MS);
    return () => window.clearInterval(interval);
  }, [disengage, transmit, updateProfile]);

  const selectMode = (next: InputMode) => {
    if (next === modeRef.current) return;
    disengage("Input mode changed.");
    modeRef.current = next;
    setMode(next);
    persistInputMode(next);
    listenRef.current = null;
    setListening(null);
    setCalibration(null);
  };

  const selectDevice = (key: string | null) => {
    disengage("Wheel selection changed.");
    deviceKeyRef.current = key;
    padConnectedRef.current = false;
    profileRef.current = key ? loadWheelProfile(key) : null;
    setDeviceKey(key);
    setProfile(profileRef.current);
    persistPreferredDeviceKey(key);
    listenRef.current = null;
    setListening(null);
    setCalibration(null);
  };

  const startListening = (target: BindingTarget) => {
    if (listenRef.current?.target === target) {
      listenRef.current = null;
      setListening(null);
      return;
    }
    listenRef.current = { target, axes: axesRef.current.slice(), buttons: buttonsRef.current.slice() };
    setListening(target);
  };

  const rawValue = (binding: PedalBinding | null): number | null => {
    if (!binding) return null;
    const value = (binding.kind === "axis" ? live.axes : live.buttons)[binding.index];
    return value === undefined ? null : value;
  };

  const advanceCalibration = () => {
    const current = profileRef.current;
    if (!calibration || !current) return;
    if (calibration.target === "steer") {
      const raw = rawValue(current.steer.binding);
      if (raw === null) return;
      if (calibration.step === "center") setCalibration({ ...calibration, step: "left", center: raw });
      else if (calibration.step === "left") setCalibration({ ...calibration, step: "right", left: raw });
      else {
        const next = { ...current.steer.calibration, center: calibration.center, left: calibration.left, right: raw, calibrated: true };
        if (!steeringCalibrationValid(next)) {
          setError("Steering calibration rejected: left and right must lie on opposite sides of centre.");
          setCalibration(null);
          return;
        }
        setError(null);
        updateProfile((draft) => { draft.steer.calibration = next; });
        setCalibration(null);
      }
      return;
    }
    const raw = rawValue(current[calibration.target].binding);
    if (raw === null) return;
    if (calibration.step === "released") {
      setCalibration({ ...calibration, step: "pressed", released: raw });
      return;
    }
    if (Math.abs(raw - calibration.released) <= 1e-3) {
      setError("Pedal calibration rejected: released and pressed values are identical.");
      setCalibration(null);
      return;
    }
    setError(null);
    updateProfile((draft) => {
      draft[calibration.target].calibration = { ...draft[calibration.target].calibration, released: calibration.released, pressed: raw, calibrated: true };
    });
    setCalibration(null);
  };

  const noVehicle = actorId === null;
  const profileRefusal = profile ? wheelProfileRefusal(profile) : null;
  const engageRefusal = noVehicle
    ? "Start driving a vehicle to enable controls."
    : sourceStatus !== "running"
      ? "The world is not running."
      : mode === "wheel"
        ? !support.supported
          ? "Wheel input is unavailable in this browser."
          : !profile
            ? "Select a wheel."
            : !live.padConnected
              ? "The selected wheel is not connected."
              : profileRefusal !== null
                ? profileRefusal
                : !pedalsReleased(live)
                  ? "Release the pedals to engage."
                  : null
        : null;

  return (
    <Card className="pointer-events-auto w-full shadow-xl" data-testid="driving-controls">
      <CardContent className="space-y-3 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-md border border-border p-0.5" role="group" aria-label="Driving input mode">
            <Button type="button" size="sm" variant={mode === "keyboard" ? "secondary" : "ghost"} onClick={() => selectMode("keyboard")}>
              <Keyboard aria-hidden="true" /> Keyboard
            </Button>
            <Button type="button" size="sm" variant={mode === "wheel" ? "secondary" : "ghost"} onClick={() => selectMode("wheel")}>
              <Gamepad2 aria-hidden="true" /> Wheel
            </Button>
          </div>
          <Badge variant={engaged ? "default" : noVehicle ? "outline" : "secondary"} data-testid="driving-engaged">
            {engaged ? "Engaged" : noVehicle ? "Idle" : "Paused"}
          </Badge>
          {live.reverse ? <Badge variant="destructive">Reverse</Badge> : null}
          <div className="flex-1" />
          <Button
            type="button"
            size="sm"
            variant={engaged ? "outline" : "default"}
            disabled={engaged || engageRefusal !== null}
            onClick={() => {
              const refusal = engage();
              if (refusal) setPauseReason(refusal);
            }}
            data-testid="driving-engage"
          >
            <Play aria-hidden="true" /> {pauseReason && !noVehicle ? "Resume" : "Engage"}
          </Button>
        </div>

        <div className="grid grid-cols-3 gap-2 text-[10px] uppercase tracking-wide text-muted-foreground" aria-label="Live driving input">
          <Meter label="Steer" value={live.steer} centered />
          <Meter label="Throttle" value={live.throttle} />
          <Meter label="Brake" value={live.brake} />
        </div>

        {!engaged && !noVehicle ? (
          <p className="text-xs text-muted-foreground" data-testid="driving-pause-reason">
            {engageRefusal ?? pauseReason ?? (mode === "keyboard" ? "Press a driving key or Engage to take control." : "Engage to hand control to the wheel.")}
          </p>
        ) : null}
        {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}

        {mode === "keyboard" ? (
          <p className="text-xs text-muted-foreground">
            <kbd>W</kbd>/<kbd>↑</kbd> throttle · <kbd>S</kbd>/<kbd>↓</kbd>/<kbd>Space</kbd> brake · <kbd>A</kbd>/<kbd>D</kbd> or <kbd>←</kbd>/<kbd>→</kbd> steer · <kbd>R</kbd> toggles reverse. Keys are ignored while a text field or button has focus.
          </p>
        ) : (
          <WheelPanel
            support={support}
            devices={devices}
            deviceKey={deviceKey}
            profile={profile}
            live={live}
            listening={listening}
            calibration={calibration}
            onSelectDevice={selectDevice}
            onListen={startListening}
            onClearBinding={(target) => updateProfile((draft) => {
              if (target === "steer") draft.steer.binding = null;
              else if (target === "reverse") draft.reverse = null;
              else draft[target].binding = null;
            })}
            onStartCalibration={(target) => {
              setError(null);
              setCalibration(target === "steer"
                ? { target, step: "center", center: 0, left: 0 }
                : { target, step: "released", released: 0 });
            }}
            onCancelCalibration={() => setCalibration(null)}
            onAdvanceCalibration={advanceCalibration}
            onUpdateProfile={updateProfile}
            rawValue={rawValue}
          />
        )}
      </CardContent>
    </Card>
  );
}

function Meter({ label, value, centered = false }: { label: string; value: number; centered?: boolean }) {
  const percent = centered ? 50 + value * 50 : value * 100;
  return (
    <div>
      <div className="flex justify-between">
        <span>{label}</span>
        <span className="font-mono normal-case text-foreground">{value.toFixed(2)}</span>
      </div>
      <div className="relative mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
        {centered ? <div className="absolute inset-y-0 left-1/2 w-px bg-border" /> : null}
        <div
          className="absolute inset-y-0 bg-primary"
          style={centered
            ? { left: `${Math.min(50, percent)}%`, width: `${Math.abs(percent - 50)}%` }
            : { left: 0, width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

function WheelPanel({
  support, devices, deviceKey, profile, live, listening, calibration,
  onSelectDevice, onListen, onClearBinding, onStartCalibration, onCancelCalibration, onAdvanceCalibration, onUpdateProfile, rawValue,
}: {
  support: GamepadSupport;
  devices: GamepadDeviceInfo[];
  deviceKey: string | null;
  profile: WheelProfile | null;
  live: LiveReadout;
  listening: BindingTarget | null;
  calibration: CalibrationStep | null;
  onSelectDevice: (key: string | null) => void;
  onListen: (target: BindingTarget) => void;
  onClearBinding: (target: BindingTarget) => void;
  onStartCalibration: (target: "steer" | "throttle" | "brake") => void;
  onCancelCalibration: () => void;
  onAdvanceCalibration: () => void;
  onUpdateProfile: (mutate: (draft: WheelProfile) => void) => void;
  rawValue: (binding: PedalBinding | null) => number | null;
}) {
  if (!support.supported) {
    return <p role="alert" className="text-xs text-destructive">{support.reason ?? "Gamepad input is unavailable."}</p>;
  }
  const selected = devices.find((device) => device.key === deviceKey) ?? null;
  const options = devices.map((device) => ({ value: device.key, label: `${device.key} (${device.axes} axes, ${device.buttons} buttons)` }));
  if (deviceKey && !selected) options.push({ value: deviceKey, label: `${deviceKey} (not connected)` });

  return (
    <div className="space-y-3 text-xs">
      <div className="space-y-1">
        <SelectMenu
          label="Wheel device"
          value={deviceKey ?? ""}
          options={options}
          onChange={(value) => onSelectDevice(value || null)}
          placeholder={devices.length === 0 ? "No gamepads exposed" : "Select a wheel"}
          className="h-8 text-xs"
        />
        <p className="text-muted-foreground">
          {devices.length === 0
            ? "No gamepad is exposed yet. Press a button or turn the wheel so the browser lists it."
            : selected
              ? `Connected · mapping ${selected.mapping || "custom"} · slot ${selected.index}`
              : deviceKey
                ? "The saved wheel is not connected."
                : `${devices.length} device${devices.length === 1 ? "" : "s"} available.`}
        </p>
      </div>

      {profile ? (
        <>
          <div className="space-y-2" data-testid="wheel-bindings">
            <BindingRow
              label="Steering"
              binding={profile.steer.binding}
              raw={rawValue(profile.steer.binding)}
              listening={listening === "steer"}
              hint="axis"
              calibrated={profile.steer.calibration.calibrated}
              onListen={() => onListen("steer")}
              onClear={() => onClearBinding("steer")}
              onCalibrate={profile.steer.binding ? () => onStartCalibration("steer") : null}
              disabled={!live.padConnected}
            >
              <label className="flex items-center gap-1">
                <Switch checked={profile.steer.calibration.invert} onCheckedChange={(checked) => onUpdateProfile((draft) => { draft.steer.calibration.invert = checked; })} aria-label="Invert steering" />
                Invert
              </label>
              <DeadzoneInput label="Steering deadzone" value={profile.steer.calibration.deadzone} onChange={(value) => onUpdateProfile((draft) => { draft.steer.calibration.deadzone = value; })} />
            </BindingRow>
            {(["throttle", "brake"] as const).map((pedal) => (
              <BindingRow
                key={pedal}
                label={pedal === "throttle" ? "Throttle" : "Brake"}
                binding={profile[pedal].binding}
                raw={rawValue(profile[pedal].binding)}
                listening={listening === pedal}
                hint="axis or button"
                calibrated={profile[pedal].binding?.kind === "button" ? true : profile[pedal].calibration.calibrated}
                onListen={() => onListen(pedal)}
                onClear={() => onClearBinding(pedal)}
                onCalibrate={profile[pedal].binding?.kind === "axis" ? () => onStartCalibration(pedal) : null}
                disabled={!live.padConnected}
              >
                {profile[pedal].binding?.kind === "axis" ? (
                  <DeadzoneInput label={`${pedal} deadzone`} value={profile[pedal].calibration.deadzone} onChange={(value) => onUpdateProfile((draft) => { draft[pedal].calibration.deadzone = value; })} />
                ) : null}
              </BindingRow>
            ))}
            <BindingRow
              label="Reverse"
              binding={profile.reverse}
              raw={rawValue(profile.reverse)}
              listening={listening === "reverse"}
              hint="button (toggles)"
              calibrated
              onListen={() => onListen("reverse")}
              onClear={() => onClearBinding("reverse")}
              onCalibrate={null}
              disabled={!live.padConnected}
            />
          </div>

          {calibration ? (
            <div className="space-y-1 rounded-md border border-border p-2" data-testid="wheel-calibration">
              <p className="font-medium text-foreground">
                {calibration.target === "steer"
                  ? calibration.step === "center"
                    ? "Centre the wheel, then set centre."
                    : calibration.step === "left"
                      ? "Turn the wheel to full left lock, then set left."
                      : "Turn the wheel to full right lock, then set right."
                  : calibration.step === "released"
                    ? `Release the ${calibration.target} pedal, then set released.`
                    : `Press the ${calibration.target} pedal fully, then set pressed.`}
              </p>
              <p className="font-mono text-muted-foreground">
                raw {rawValue(calibration.target === "steer" ? profile.steer.binding : profile[calibration.target].binding)?.toFixed(3) ?? "—"}
                {calibration.target === "steer" && calibration.step !== "center" ? ` · centre ${calibration.center.toFixed(3)}` : ""}
                {calibration.target === "steer" && calibration.step === "right" ? ` · left ${calibration.left.toFixed(3)}` : ""}
                {calibration.target !== "steer" && calibration.step === "pressed" ? ` · released ${calibration.released.toFixed(3)}` : ""}
              </p>
              <div className="flex gap-2">
                <Button type="button" size="sm" variant="default" disabled={!live.padConnected} onClick={onAdvanceCalibration}>
                  {calibration.target === "steer" ? `Set ${calibration.step}` : `Set ${calibration.step}`}
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={onCancelCalibration}>Cancel</Button>
              </div>
            </div>
          ) : null}

          {live.padConnected ? (
            <p className="font-mono text-[10px] text-muted-foreground" data-testid="wheel-raw">
              axes [{live.axes.map((value) => value.toFixed(2)).join(" ")}] · buttons [{live.buttons.map((value, index) => value >= 0.5 ? index : null).filter((index) => index !== null).join(" ")}]
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function BindingRow({ label, binding, raw, listening, hint, calibrated, onListen, onClear, onCalibrate, disabled, children }: {
  label: string;
  binding: PedalBinding | null;
  raw: number | null;
  listening: boolean;
  hint: string;
  calibrated: boolean;
  onListen: () => void;
  onClear: () => void;
  onCalibrate: (() => void) | null;
  disabled: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-16 font-medium text-foreground">{label}</span>
      <span className={cn("font-mono", binding ? "text-foreground" : "text-muted-foreground")}>{bindingLabel(binding)}</span>
      <span className="w-14 font-mono text-muted-foreground">{raw === null ? "—" : raw.toFixed(2)}</span>
      {binding && !calibrated ? <Badge variant="outline">Uncalibrated</Badge> : null}
      <Button type="button" size="sm" variant={listening ? "secondary" : "outline"} disabled={disabled} onClick={onListen}>
        {listening ? `Move the ${hint}…` : "Listen"}
      </Button>
      {onCalibrate ? <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={onCalibrate}>Calibrate</Button> : null}
      {binding ? <Button type="button" size="sm" variant="ghost" onClick={onClear}>Clear</Button> : null}
      {children}
    </div>
  );
}

function DeadzoneInput({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <label className="flex items-center gap-1 text-muted-foreground">
      Deadzone
      <input
        type="range"
        min={0}
        max={MAX_DEADZONE}
        step={0.01}
        value={value}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
        className="h-1.5 w-16 cursor-pointer appearance-none rounded-full bg-muted accent-primary"
        aria-label={label}
      />
      <span className="font-mono">{value.toFixed(2)}</span>
    </label>
  );
}
