import { describe, expect, it } from "vitest";

import type { DriveAction, DriveCommand } from "./commands";
import { applyDeadzone, conditionSteerAxis } from "./curves";
import { createDriveInput } from "./drive-input";
import { gamepadActions, gamepadIsActive, sampleGamepad, type GamepadSample } from "./gamepad";
import { advanceKeyboardSteer, keyboardCommand } from "./keyboard";

function blankCommand(): DriveCommand {
  return { throttle: 0, brake: 0, steer: 0, handbrake: false };
}

function pad(overrides: {
  mapping?: string;
  axes?: readonly number[];
  buttons?: Readonly<Record<number, number>>;
  buttonCount?: number;
}): GamepadSample {
  const count = overrides.buttonCount ?? 17;
  const values = overrides.buttons ?? {};
  return {
    mapping: overrides.mapping ?? "standard",
    axes: overrides.axes ?? [0, 0, 0, 0],
    buttons: Array.from({ length: count }, (_unused, index) => {
      const value = values[index] ?? 0;
      return { pressed: value > 0.5, value };
    }),
  };
}

describe("analogue conditioning", () => {
  it("gates the resting stick and still reaches full lock", () => {
    expect(applyDeadzone(0.1, 0.12)).toBe(0);
    expect(applyDeadzone(-0.1, 0.12)).toBe(0);
    expect(applyDeadzone(1, 0.12)).toBe(1);
    expect(applyDeadzone(-1, 0.12)).toBe(-1);
  });

  it("rescales the travel above the deadzone instead of stepping off it", () => {
    // Just past the gate must be a trickle of steering, not 56% of the lock.
    expect(applyDeadzone(0.13, 0.12)).toBeCloseTo(0.0114, 3);
    expect(applyDeadzone(0.56, 0.12)).toBeCloseTo(0.5, 3);
  });

  it("clamps an over-range axis report rather than commanding more than full lock", () => {
    expect(applyDeadzone(1.4, 0.12)).toBe(1);
    expect(applyDeadzone(-1.4, 0.12)).toBe(-1);
    expect(applyDeadzone(Number.NaN, 0.12)).toBe(0);
  });

  it("softens mid-stick steering while keeping the extremes and the sign", () => {
    expect(conditionSteerAxis(1)).toBeCloseTo(1, 6);
    expect(conditionSteerAxis(-1)).toBeCloseTo(-1, 6);
    const half = conditionSteerAxis(0.56);
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(0.5);
    expect(conditionSteerAxis(-0.56)).toBeCloseTo(-half, 6);
  });
});

describe("keyboard mapping", () => {
  it("maps both key families to the same command", () => {
    const wasd = keyboardCommand(new Set(["KeyW", "KeyD", "Space"]), 0, 1, blankCommand());
    expect(wasd).toEqual({ throttle: 1, brake: 0, steer: 1, handbrake: true });
    const arrows = keyboardCommand(new Set(["ArrowUp", "ArrowRight", "Space"]), 0, 1, blankCommand());
    expect(arrows).toEqual(wasd);
  });

  it("cancels opposing steer keys instead of picking a winner", () => {
    const command = keyboardCommand(new Set(["KeyA", "KeyD"]), 0.8, 0.1, blankCommand());
    expect(command.steer).toBeLessThan(0.8);
    expect(keyboardCommand(new Set(["KeyA", "KeyD"]), 0, 1, blankCommand()).steer).toBe(0);
  });

  it("sweeps the wheel over time rather than snapping to full lock", () => {
    let steer = 0;
    steer = advanceKeyboardSteer(steer, true, false, 1 / 60);
    expect(steer).toBeGreaterThan(-0.1);
    expect(steer).toBeLessThan(0);
    for (let frame = 0; frame < 120; frame += 1) steer = advanceKeyboardSteer(steer, true, false, 1 / 60);
    expect(steer).toBe(-1);
  });

  it("returns to exactly centre when released, faster than it steered", () => {
    const sweep = advanceKeyboardSteer(0, false, true, 0.1);
    const centred = advanceKeyboardSteer(sweep, false, false, 0.1);
    expect(centred).toBeLessThan(sweep);
    expect(advanceKeyboardSteer(0.01, false, false, 0.1)).toBe(0);
    expect(advanceKeyboardSteer(-0.01, false, false, 0.1)).toBe(0);
  });

  it("crosses centre at the sweep rate when the driver asks for opposite lock", () => {
    // Countersteer must not get the fast centring rate for the whole travel:
    // that made a keyboard flick snap the wheel across in a single frame.
    const step = advanceKeyboardSteer(1, true, false, 0.1);
    expect(step).toBeCloseTo(1 - 0.32, 6);
  });
});

describe("gamepad mapping", () => {
  it("reads triggers, stick and handbrake from the standard mapping", () => {
    const command = blankCommand();
    const mask = sampleGamepad(
      pad({ axes: [-1, 0, 0, 0], buttons: { 6: 0.5, 7: 1, 0: 1 } }),
      command,
    );
    expect(command.throttle).toBeCloseTo(1, 6);
    expect(command.brake).toBeCloseTo(0.479, 2);
    expect(command.steer).toBeCloseTo(-1, 6);
    expect(command.handbrake).toBe(true);
    expect(mask & 1).toBe(1);
  });

  it("ignores a pad that does not report the standard mapping", () => {
    const command = blankCommand();
    command.throttle = 0.5;
    expect(sampleGamepad(pad({ mapping: "", buttons: { 7: 1 } }), command)).toBe(0);
    expect(command.throttle).toBe(0.5);
  });

  it("fires each button action once on the press edge", () => {
    const idle = 0;
    const pressed = 1 << 3;
    expect(gamepadActions(idle, pressed)).toEqual(["cycleCamera"]);
    expect(gamepadActions(pressed, pressed)).toEqual([]);
    expect(gamepadActions(pressed, idle)).toEqual([]);
    expect(gamepadActions(idle, (1 << 1) | (1 << 9)).sort()).toEqual(["pause", "reset"]);
  });

  it("treats a resting pad as inactive so the keyboard keeps the car", () => {
    const command = blankCommand();
    const mask = sampleGamepad(pad({ axes: [0.05, 0, 0, 0] }), command);
    expect(gamepadIsActive(command, mask)).toBe(false);
    const driving = blankCommand();
    const drivingMask = sampleGamepad(pad({ axes: [0.9, 0, 0, 0] }), driving);
    expect(gamepadIsActive(driving, drivingMask)).toBe(true);
  });
});

describe("live input device", () => {
  function harness(pads: () => readonly (GamepadSample | null)[]) {
    const listeners = new Map<string, Set<EventListener>>();
    const actions: DriveAction[] = [];
    const connections: boolean[] = [];
    const target = {
      addEventListener(type: string, listener: EventListener) {
        const set = listeners.get(type) ?? new Set<EventListener>();
        set.add(listener);
        listeners.set(type, set);
      },
      removeEventListener(type: string, listener: EventListener) {
        listeners.get(type)?.delete(listener);
      },
    } as unknown as Window;
    const input = createDriveInput({
      target,
      readGamepads: pads,
      onAction: (action) => actions.push(action),
      onGamepadChange: (connected) => connections.push(connected),
    });
    const fire = (type: string, event: Partial<KeyboardEvent>) => {
      for (const listener of listeners.get(type) ?? []) {
        listener({ preventDefault() {}, repeat: false, target: null, ...event } as unknown as Event);
      }
    };
    return { actions, connections, fire, input, listeners };
  }

  it("drives from the keyboard and releases on blur", () => {
    const { fire, input } = harness(() => []);
    fire("keydown", { code: "KeyW" });
    expect(input.sample(1 / 60).throttle).toBe(1);
    fire("blur", {});
    expect(input.sample(1 / 60).throttle).toBe(0);
    input.dispose();
  });

  it("does not steal keys typed into a text field", () => {
    const { fire, input } = harness(() => []);
    fire("keydown", { code: "KeyW", target: { tagName: "INPUT" } as unknown as EventTarget });
    expect(input.sample(1 / 60).throttle).toBe(0);
    input.dispose();
  });

  it("hands the car to a pad that is being used and back when it is unplugged", () => {
    let pads: readonly (GamepadSample | null)[] = [];
    const { connections, fire, input } = harness(() => pads);
    fire("keydown", { code: "KeyW" });
    expect(input.sample(1 / 60).throttle).toBe(1);

    pads = [pad({ buttons: { 6: 1 } })];
    const withPad = input.sample(1 / 60);
    expect(withPad.brake).toBeCloseTo(1, 6);
    expect(withPad.throttle).toBe(0);
    expect(connections).toEqual([true]);

    pads = [];
    expect(input.sample(1 / 60).throttle).toBe(1);
    expect(connections).toEqual([true, false]);
    input.dispose();
  });

  it("keeps the keyboard in charge while the pad is resting", () => {
    const pads = [pad({ axes: [0.03, 0, 0, 0] })];
    const { fire, input } = harness(() => pads);
    fire("keydown", { code: "ArrowUp" });
    expect(input.sample(1 / 60).throttle).toBe(1);
    input.dispose();
  });

  it("reports one action per press and ignores auto-repeat", () => {
    const { actions, fire, input } = harness(() => []);
    fire("keydown", { code: "KeyC" });
    fire("keydown", { code: "KeyC", repeat: true });
    fire("keydown", { code: "KeyR" });
    expect(actions).toEqual(["cycleCamera", "reset"]);
    input.dispose();
  });

  it("suspends driving but not pause while the menu is open", () => {
    const { actions, fire, input } = harness(() => []);
    fire("keydown", { code: "KeyW" });
    input.setEnabled(false);
    expect(input.sample(1 / 60).throttle).toBe(0);
    fire("keydown", { code: "Escape" });
    fire("keydown", { code: "KeyR" });
    expect(actions).toEqual(["pause"]);
    input.dispose();
  });

  it("detaches every listener on dispose", () => {
    const { input, listeners } = harness(() => []);
    input.dispose();
    for (const set of listeners.values()) expect(set.size).toBe(0);
  });
});
