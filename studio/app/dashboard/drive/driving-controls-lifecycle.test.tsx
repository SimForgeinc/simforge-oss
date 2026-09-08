// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ControlInput, WorldSource, WorldSourceStatus } from "../../lib/live-world/types";
import { DrivingControls } from "./DrivingControls";

const TICK_MS = 50;

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

interface FakeSource extends WorldSource {
  status: WorldSourceStatus;
  sent: ControlInput[];
  emit(status: WorldSourceStatus, error?: string | null): void;
}

function fakeSource(): FakeSource {
  const listeners = new Set<(status: WorldSourceStatus, error: string | null) => void>();
  const source: FakeSource = {
    sent: [],
    status: "running",
    lastError: null,
    subscribeFrames: () => () => {},
    subscribeStatus(fn) {
      listeners.add(fn);
      fn(source.status, null);
      return () => listeners.delete(fn);
    },
    spawn: () => Promise.reject(new Error("unsupported")),
    despawn: () => Promise.reject(new Error("unsupported")),
    control(input) {
      source.sent.push({ ...input });
    },
    emit(status, error = null) {
      source.status = status;
      for (const fn of listeners) fn(status, error);
    },
  };
  return source;
}

interface FakePad {
  id: string;
  index: number;
  connected: boolean;
  mapping: string;
  axes: number[];
  buttons: { value: number; pressed: boolean }[];
}

function fakePad(id: string, axes: number[], buttons: number[] = []): FakePad {
  return { id, index: 0, connected: true, mapping: "", axes, buttons: buttons.map((value) => ({ value, pressed: value >= 0.5 })) };
}

let root: Root;
let host: HTMLDivElement;
let pads: (FakePad | null)[];

function render(source: WorldSource | null, actorId: string | null) {
  act(() => root.render(<DrivingControls source={source} actorId={actorId} />));
}

function tick(times = 1) {
  act(() => vi.advanceTimersByTime(TICK_MS * times));
}

function key(type: "keydown" | "keyup", code: string, init: KeyboardEventInit = {}) {
  act(() => {
    window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true, cancelable: true, ...init }));
  });
}

function text(testId: string): string {
  return host.querySelector(`[data-testid="${testId}"]`)?.textContent ?? "";
}

beforeEach(() => {
  vi.useFakeTimers();
  pads = [];
  Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
  Object.defineProperty(navigator, "getGamepads", { value: () => pads, configurable: true });
  window.localStorage.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe("DrivingControls keyboard lifecycle", () => {
  it("engages on a real key press, streams commands, neutralizes on blur and needs a fresh press to resume", () => {
    const source = fakeSource();
    render(source, "ego");
    tick(2);
    expect(source.sent).toHaveLength(0);
    expect(text("driving-engaged")).toBe("Paused");

    key("keydown", "KeyW");
    tick();
    expect(text("driving-engaged")).toBe("Engaged");
    expect(source.sent.at(-1)).toEqual({ actorId: "ego", steer: 0, throttle: 1, brake: 0, reverse: false });

    key("keydown", "KeyA");
    key("keydown", "KeyR");
    tick();
    expect(source.sent.at(-1)).toMatchObject({ steer: -1, throttle: 1, reverse: true });

    act(() => window.dispatchEvent(new Event("blur")));
    expect(source.sent.at(-1)).toEqual({ actorId: "ego", steer: 0, throttle: 0, brake: 0, reverse: false });
    const sentAfterBlur = source.sent.length;
    tick(4);
    expect(source.sent).toHaveLength(sentAfterBlur);
    expect(text("driving-engaged")).toBe("Paused");
    expect(text("driving-pause-reason")).toContain("lost focus");

    key("keydown", "KeyW", { repeat: true });
    tick();
    expect(source.sent).toHaveLength(sentAfterBlur);

    key("keydown", "KeyW");
    tick();
    expect(text("driving-engaged")).toBe("Engaged");
    expect(source.sent.at(-1)).toMatchObject({ throttle: 1, reverse: false });
  });

  it("ignores driving keys typed into editable fields and buttons", () => {
    const source = fakeSource();
    render(source, "ego");
    const input = document.createElement("input");
    document.body.appendChild(input);
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", bubbles: true, cancelable: true }));
    });
    tick();
    expect(source.sent).toHaveLength(0);
    input.remove();
  });

  it("releases the previous vehicle when the actor changes or the world stops", () => {
    const source = fakeSource();
    render(source, "ego");
    key("keydown", "KeyW");
    tick();
    expect(source.sent.at(-1)).toMatchObject({ actorId: "ego", throttle: 1 });

    render(source, "other");
    expect(source.sent.at(-1)).toEqual({ actorId: "ego", steer: 0, throttle: 0, brake: 0, reverse: false });
    const afterSwitch = source.sent.length;
    tick(2);
    expect(source.sent).toHaveLength(afterSwitch);

    key("keydown", "ArrowUp");
    tick();
    expect(source.sent.at(-1)).toMatchObject({ actorId: "other", throttle: 1 });
    act(() => source.emit("error", "worker died"));
    expect(source.sent.at(-1)).toMatchObject({ actorId: "other", throttle: 0 });
    expect(text("driving-pause-reason")).toContain("not running");

    render(source, null);
    key("keydown", "KeyW");
    tick(2);
    expect(text("driving-engaged")).toBe("Idle");
  });

  it("stops driving when the world rejects a command", () => {
    const source = fakeSource();
    source.control = () => {
      throw new Error("No authored ego vehicle is selected");
    };
    render(source, "ego");
    key("keydown", "KeyW");
    tick();
    expect(text("driving-engaged")).toBe("Paused");
    expect(host.querySelector("[role=alert]")?.textContent).toContain("No authored ego vehicle");
  });
});

describe("DrivingControls injected gamepad", () => {
  beforeEach(() => {
    window.localStorage.setItem("simcloud.drive.inputMode", "wheel");
    window.localStorage.setItem("simcloud.drive.wheelDevice", "Injected Wheel");
    window.localStorage.setItem("simcloud.drive.wheelProfiles", JSON.stringify({
      version: 1,
      profiles: {
        "Injected Wheel": {
          steer: { binding: { kind: "axis", index: 0 }, calibration: { center: 0, left: -1, right: 1, invert: false, deadzone: 0, calibrated: true } },
          throttle: { binding: { kind: "axis", index: 1 }, calibration: { released: 1, pressed: -1, deadzone: 0, calibrated: true } },
          brake: { binding: { kind: "button", index: 2 } },
          reverse: { kind: "button", index: 3 },
        },
      },
    }));
  });

  it("never sends without an explicit engage, refuses engaging with a pressed pedal, and neutralizes on disconnect", () => {
    const source = fakeSource();
    const pad = fakePad("Injected Wheel", [0.5, 0], [0, 0, 0, 0]);
    pads = [pad];
    render(source, "ego");
    tick(2);
    expect(source.sent).toHaveLength(0);
    const engage = host.querySelector<HTMLButtonElement>("[data-testid=driving-engage]")!;
    expect(engage.disabled).toBe(true);
    expect(text("driving-pause-reason")).toContain("Release the pedals");

    pad.axes[1] = 1;
    tick(2);
    expect(engage.disabled).toBe(false);
    act(() => engage.click());
    tick();
    expect(source.sent.at(-1)).toEqual({ actorId: "ego", steer: 0.5, throttle: 0, brake: 0, reverse: false });

    pad.axes[1] = 0;
    pad.buttons[2] = { value: 0.25, pressed: false };
    pad.buttons[3] = { value: 1, pressed: true };
    tick();
    expect(source.sent.at(-1)).toEqual({ actorId: "ego", steer: 0.5, throttle: 0.5, brake: 0.25, reverse: true });

    key("keydown", "Space");
    tick();
    expect(source.sent.at(-1)).toMatchObject({ brake: 0.25, throttle: 0.5 });

    pads = [null];
    tick();
    expect(source.sent.at(-1)).toEqual({ actorId: "ego", steer: 0, throttle: 0, brake: 0, reverse: false });
    const afterLoss = source.sent.length;
    tick(3);
    expect(source.sent).toHaveLength(afterLoss);
    expect(text("driving-pause-reason")).toContain("not connected");
  });

  it("reports missing gamepad support instead of inventing a device", () => {
    Object.defineProperty(navigator, "getGamepads", { value: undefined, configurable: true });
    render(fakeSource(), "ego");
    tick();
    expect(host.textContent).toContain("does not expose the Gamepad API");
    expect(host.querySelector("[data-testid=wheel-bindings]")).toBeNull();
  });
});
