import { describe, expect, it } from "vitest";

import {
  applyKeyboardState,
  applyWheelSample,
  defaultPedalCalibration,
  defaultSteeringCalibration,
  defaultWheelProfile,
  detectMovedInput,
  normalizePedal,
  normalizeSteer,
  parseWheelProfile,
  pedalsReleased,
  wheelProfileRefusal,
  type DriveCommand,
} from "./driving-input";

function command(): DriveCommand {
  return { steer: 0, throttle: 0, brake: 0, reverse: false };
}

describe("steering calibration", () => {
  it("maps asymmetric extents around an off-centre wheel and applies deadzone and inversion", () => {
    const cal = { ...defaultSteeringCalibration(), center: 0.1, left: -0.8, right: 1, deadzone: 0.1, calibrated: true };
    expect(normalizeSteer(0.1, cal)).toBe(0);
    expect(normalizeSteer(-0.8, cal)).toBe(-1);
    expect(normalizeSteer(1, cal)).toBe(1);
    expect(normalizeSteer(-2, cal)).toBe(-1);
    expect(normalizeSteer(0.145, cal)).toBe(0);
    expect(normalizeSteer(0.55, { ...cal, invert: true })).toBeCloseTo(-0.4444, 3);
  });

  it("supports wheels whose axis runs right-to-left and rejects unusable calibration", () => {
    const reversed = { ...defaultSteeringCalibration(), center: 0, left: 1, right: -1, deadzone: 0 };
    expect(normalizeSteer(0.5, reversed)).toBe(-0.5);
    expect(normalizeSteer(-0.5, reversed)).toBe(0.5);
    const sameSide = { ...defaultSteeringCalibration(), center: 0, left: 0.5, right: 1 };
    expect(normalizeSteer(0.75, sameSide)).toBe(0);
    expect(normalizeSteer(Number.NaN, defaultSteeringCalibration())).toBe(0);
  });
});

describe("pedal calibration", () => {
  it("maps released→pressed in either direction with a released deadzone", () => {
    const idleHigh = { ...defaultPedalCalibration(), released: 1, pressed: -1, deadzone: 0.1 };
    expect(normalizePedal(1, idleHigh)).toBe(0);
    expect(normalizePedal(0.9, idleHigh)).toBe(0);
    expect(normalizePedal(-1, idleHigh)).toBe(1);
    expect(normalizePedal(0, idleHigh)).toBeCloseTo(0.4444, 3);
    const idleLow = { ...defaultPedalCalibration(), released: 0, pressed: 1, deadzone: 0 };
    expect(normalizePedal(0.25, idleLow)).toBe(0.25);
    expect(normalizePedal(2, idleLow)).toBe(1);
    expect(normalizePedal(0.5, { ...idleLow, pressed: 0 })).toBe(0);
  });
});

describe("wheel sample", () => {
  it("reads bound inputs, treats button pedals as analog, and toggles reverse on the rising edge only", () => {
    const profile = defaultWheelProfile("wheel");
    profile.steer.binding = { kind: "axis", index: 0 };
    profile.steer.calibration.deadzone = 0;
    profile.throttle.binding = { kind: "axis", index: 2 };
    profile.throttle.calibration = { released: 1, pressed: -1, deadzone: 0, calibrated: true };
    profile.brake.binding = { kind: "button", index: 7 };
    profile.reverse = { kind: "button", index: 3 };
    const out = command();
    const edge = { reverseButtonDown: false };
    const buttons = [0, 0, 0, 1, 0, 0, 0, 0.5];
    applyWheelSample({ axes: [-0.5, 0, 0], buttons }, profile, out, edge);
    expect(out).toEqual({ steer: -0.5, throttle: 0.5, brake: 0.5, reverse: true });
    applyWheelSample({ axes: [-0.5, 0, 0], buttons }, profile, out, edge);
    expect(out.reverse).toBe(true);
    buttons[3] = 0;
    applyWheelSample({ axes: [0, 0, 1], buttons }, profile, out, edge);
    expect(out).toEqual({ steer: 0, throttle: 0, brake: 0.5, reverse: true });
    buttons[3] = 1;
    applyWheelSample({ axes: [0, 0, 1], buttons }, profile, out, edge);
    expect(out.reverse).toBe(false);
  });

  it("yields neutral for bindings that point past the device's inputs", () => {
    const profile = defaultWheelProfile("wheel");
    profile.steer.binding = { kind: "axis", index: 9 };
    profile.throttle.binding = { kind: "button", index: 40 };
    const out = command();
    applyWheelSample({ axes: [1], buttons: [1] }, profile, out, { reverseButtonDown: false });
    expect(out).toEqual({ steer: 0, throttle: 0, brake: 0, reverse: false });
    expect(pedalsReleased(out)).toBe(true);
  });

  it("refuses control until every bound axis carries a user-captured calibration", () => {
    const profile = defaultWheelProfile("wheel");
    expect(wheelProfileRefusal(profile)).toBe("Bind a steering axis.");
    profile.steer.binding = { kind: "axis", index: 0 };
    expect(wheelProfileRefusal(profile)).toBe("Calibrate steering.");
    profile.steer.calibration.calibrated = true;
    expect(wheelProfileRefusal(profile)).toBe("Bind the throttle pedal.");
    profile.throttle.binding = { kind: "axis", index: 1 };
    expect(wheelProfileRefusal(profile)).toBe("Calibrate the throttle pedal.");
    profile.throttle.calibration = { released: 1, pressed: -1, deadzone: 0, calibrated: true };
    profile.brake.binding = { kind: "button", index: 2 };
    expect(wheelProfileRefusal(profile)).toBeNull();
    profile.steer.calibration.left = 0.5;
    expect(wheelProfileRefusal(profile)).toBe("Calibrate steering.");
  });
});

describe("keyboard reduction", () => {
  it("cancels opposite steering keys and brakes on any brake key", () => {
    const out = command();
    const held = new Set(["KeyW", "KeyA", "ArrowRight"]);
    applyKeyboardState((code) => held.has(code), out);
    expect(out).toMatchObject({ steer: 0, throttle: 1, brake: 0 });
    held.delete("ArrowRight");
    held.add("Space");
    applyKeyboardState((code) => held.has(code), out);
    expect(out).toMatchObject({ steer: -1, throttle: 1, brake: 1 });
  });
});

describe("input detection", () => {
  it("picks the input that moved the most and ignores button releases", () => {
    const baseline = { axes: [0, 0.2, 1], buttons: [1, 0] };
    expect(detectMovedInput(baseline, { axes: [0.3, 0.2, 1], buttons: [1, 0] })).toBeNull();
    expect(detectMovedInput(baseline, { axes: [0.6, 0.2, 0.2], buttons: [0, 0] })).toEqual({ kind: "axis", index: 2 });
    expect(detectMovedInput(baseline, { axes: [0, 0.2, 1], buttons: [0, 1] })).toEqual({ kind: "button", index: 1 });
  });
});

describe("stored profile parsing", () => {
  it("keeps valid fields and replaces malformed ones with safe defaults", () => {
    const profile = parseWheelProfile({
      steer: { binding: { kind: "button", index: 1 }, calibration: { center: "x", left: -0.9, right: 0.9, invert: true, deadzone: 4, calibrated: true } },
      throttle: { binding: { kind: "axis", index: -1 }, calibration: null },
      brake: { binding: { kind: "axis", index: 3 }, calibration: { released: 1, pressed: -1, deadzone: 0.2, calibrated: true } },
      reverse: { kind: "axis", index: 2 },
    }, "wheel");
    expect(profile.steer.binding).toBeNull();
    expect(profile.steer.calibration).toEqual({ center: 0, left: -0.9, right: 0.9, invert: true, deadzone: 0.5, calibrated: true });
    expect(profile.throttle.binding).toBeNull();
    expect(profile.throttle.calibration.calibrated).toBe(false);
    expect(profile.brake).toEqual({ binding: { kind: "axis", index: 3 }, calibration: { released: 1, pressed: -1, deadzone: 0.2, calibrated: true } });
    expect(profile.reverse).toBeNull();
    expect(parseWheelProfile("garbage", "other")).toEqual(defaultWheelProfile("other"));
  });
});
