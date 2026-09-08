/**
 * Pure driving-input model: bindings, calibration math, keyboard reduction and
 * device-input detection. No DOM access; everything here is unit-testable.
 *
 * Output semantics follow `ControlInput`: steer in [-1, 1] (negative = left),
 * throttle and brake in [0, 1], reverse as an explicit flag.
 */

export type InputMode = "keyboard" | "wheel";

export interface AxisBinding {
  kind: "axis";
  index: number;
}

export interface ButtonBinding {
  kind: "button";
  index: number;
}

export type PedalBinding = AxisBinding | ButtonBinding;

export interface SteeringCalibration {
  /** Raw axis value with the wheel centred. */
  center: number;
  /** Raw axis value at full left lock. */
  left: number;
  /** Raw axis value at full right lock. */
  right: number;
  /** Flip the normalised sign after calibration. */
  invert: boolean;
  /** Fraction of the normalised range around centre that reads as 0. */
  deadzone: number;
  /** False until the user has captured centre and extents on this device. */
  calibrated: boolean;
}

export interface PedalCalibration {
  /** Raw axis value with the pedal released. */
  released: number;
  /** Raw axis value with the pedal fully pressed. */
  pressed: number;
  /** Fraction of the normalised travel from released that reads as 0. */
  deadzone: number;
  /** False until the user has captured released and pressed on this device. */
  calibrated: boolean;
}

export interface WheelProfile {
  /** Stable identity: the Gamepad `id` string; never the runtime index. */
  deviceKey: string;
  steer: { binding: AxisBinding | null; calibration: SteeringCalibration };
  throttle: { binding: PedalBinding | null; calibration: PedalCalibration };
  brake: { binding: PedalBinding | null; calibration: PedalCalibration };
  /** Button that toggles reverse on its rising edge. */
  reverse: ButtonBinding | null;
}

/** Actor-less control command; the loop stamps `actorId` when sending. */
export interface DriveCommand {
  steer: number;
  throttle: number;
  brake: number;
  reverse: boolean;
}

export const NEUTRAL_COMMAND: Readonly<DriveCommand> = Object.freeze({ steer: 0, throttle: 0, brake: 0, reverse: false });

export function neutralize(command: DriveCommand): void {
  command.steer = 0;
  command.throttle = 0;
  command.brake = 0;
  command.reverse = false;
}

/** Pedals are treated as released below this normalised value when engaging a wheel. */
export const PEDAL_RELEASED_THRESHOLD = 0.05;
export const MAX_DEADZONE = 0.5;

export const DRIVING_KEY_CODES: Record<string, true> = {
  ArrowUp: true,
  ArrowDown: true,
  ArrowLeft: true,
  ArrowRight: true,
  KeyW: true,
  KeyA: true,
  KeyS: true,
  KeyD: true,
  KeyR: true,
  Space: true,
};

export function defaultSteeringCalibration(): SteeringCalibration {
  return { center: 0, left: -1, right: 1, invert: false, deadzone: 0.04, calibrated: false };
}

/**
 * Uncalibrated default assumes the common idle=+1 / pressed=-1 pedal axis
 * convention. It is only an assumption; the UI labels it as such until the
 * user captures released/pressed values.
 */
export function defaultPedalCalibration(): PedalCalibration {
  return { released: 1, pressed: -1, deadzone: 0.03, calibrated: false };
}

export function defaultWheelProfile(deviceKey: string): WheelProfile {
  return {
    deviceKey,
    steer: { binding: null, calibration: defaultSteeringCalibration() },
    throttle: { binding: null, calibration: defaultPedalCalibration() },
    brake: { binding: null, calibration: defaultPedalCalibration() },
    reverse: null,
  };
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/** Steering calibration is usable only when left and right lie on opposite sides of centre. */
export function steeringCalibrationValid(cal: SteeringCalibration): boolean {
  const leftSpan = cal.center - cal.left;
  const rightSpan = cal.right - cal.center;
  return Number.isFinite(leftSpan) && Number.isFinite(rightSpan)
    && Math.abs(leftSpan) > 1e-3 && Math.abs(rightSpan) > 1e-3
    && Math.sign(leftSpan) === Math.sign(rightSpan);
}

export function pedalCalibrationValid(cal: PedalCalibration): boolean {
  return Number.isFinite(cal.released) && Number.isFinite(cal.pressed) && Math.abs(cal.pressed - cal.released) > 1e-3;
}

function applyDeadzone(value: number, deadzone: number): number {
  const dz = clamp(finite(deadzone), 0, MAX_DEADZONE);
  const magnitude = Math.abs(value);
  if (magnitude <= dz) return 0;
  return Math.sign(value) * ((magnitude - dz) / (1 - dz));
}

/** Raw steering axis to [-1, 1]; returns 0 when the calibration is unusable. */
export function normalizeSteer(raw: number, cal: SteeringCalibration): number {
  if (!Number.isFinite(raw) || !steeringCalibrationValid(cal)) return 0;
  const value = raw < cal.center
    ? -(cal.center - raw) / (cal.center - cal.left)
    : (raw - cal.center) / (cal.right - cal.center);
  const shaped = applyDeadzone(clamp(value, -1, 1), cal.deadzone);
  return cal.invert ? -shaped : shaped;
}

/** Raw pedal axis to [0, 1]; returns 0 when the calibration is unusable. */
export function normalizePedal(raw: number, cal: PedalCalibration): number {
  if (!Number.isFinite(raw) || !pedalCalibrationValid(cal)) return 0;
  const value = clamp((raw - cal.released) / (cal.pressed - cal.released), 0, 1);
  return applyDeadzone(value, cal.deadzone);
}

/** Minimal read-only view of a Gamepad sample; both arrays are reused by the caller. */
export interface DeviceSample {
  axes: ArrayLike<number>;
  /** Button values in [0, 1] (analog triggers report fractions). */
  buttons: ArrayLike<number>;
}

function readBinding(sample: DeviceSample, binding: PedalBinding | AxisBinding | ButtonBinding): number {
  const source = binding.kind === "axis" ? sample.axes : sample.buttons;
  const value = source[binding.index];
  return value === undefined ? Number.NaN : value;
}

function pedalValue(sample: DeviceSample, pedal: WheelProfile["throttle"]): number {
  if (!pedal.binding) return 0;
  const raw = readBinding(sample, pedal.binding);
  if (pedal.binding.kind === "button") return Number.isFinite(raw) ? clamp(raw, 0, 1) : 0;
  return normalizePedal(raw, pedal.calibration);
}

/**
 * Fold a device sample into `command`. `reverse` is a toggle so the caller
 * keeps the previous reverse-button level in `state` to detect rising edges.
 */
export function applyWheelSample(
  sample: DeviceSample,
  profile: WheelProfile,
  command: DriveCommand,
  state: { reverseButtonDown: boolean },
): void {
  command.steer = profile.steer.binding ? normalizeSteer(readBinding(sample, profile.steer.binding), profile.steer.calibration) : 0;
  command.throttle = pedalValue(sample, profile.throttle);
  command.brake = pedalValue(sample, profile.brake);
  if (profile.reverse) {
    const down = readBinding(sample, profile.reverse) >= 0.5;
    if (down && !state.reverseButtonDown) command.reverse = !command.reverse;
    state.reverseButtonDown = down;
  } else {
    state.reverseButtonDown = false;
  }
}

/** Both pedals must read released before a wheel may take control. */
export function pedalsReleased(command: DriveCommand): boolean {
  return command.throttle < PEDAL_RELEASED_THRESHOLD && command.brake < PEDAL_RELEASED_THRESHOLD;
}

/**
 * Keyboard reduction. `has` answers whether a key code is currently held.
 * Opposite steering keys cancel; S/ArrowDown and Space all brake.
 */
export function applyKeyboardState(has: (code: string) => boolean, command: DriveCommand): void {
  command.throttle = has("KeyW") || has("ArrowUp") ? 1 : 0;
  command.brake = has("Space") || has("KeyS") || has("ArrowDown") ? 1 : 0;
  const left = has("KeyA") || has("ArrowLeft");
  const right = has("KeyD") || has("ArrowRight");
  command.steer = left === right ? 0 : left ? -1 : 1;
}

export type DetectedInput = AxisBinding | ButtonBinding;

/**
 * Compare a baseline sample with the current one and report the single input
 * that moved the most beyond `threshold`. Used by the "listen" binding flow so
 * users never have to know an axis index up front.
 */
export function detectMovedInput(baseline: DeviceSample, current: DeviceSample, threshold = 0.5): DetectedInput | null {
  let best: DetectedInput | null = null;
  let bestDelta = threshold;
  const axisCount = Math.min(baseline.axes.length, current.axes.length);
  for (let index = 0; index < axisCount; index += 1) {
    const delta = Math.abs(finite(current.axes[index]!) - finite(baseline.axes[index]!));
    if (delta > bestDelta) {
      bestDelta = delta;
      best = { kind: "axis", index };
    }
  }
  const buttonCount = Math.min(baseline.buttons.length, current.buttons.length);
  for (let index = 0; index < buttonCount; index += 1) {
    const delta = finite(current.buttons[index]!) - finite(baseline.buttons[index]!);
    if (delta > bestDelta) {
      bestDelta = delta;
      best = { kind: "button", index };
    }
  }
  return best;
}

function isBinding(value: unknown, kinds: readonly string[]): value is AxisBinding | ButtonBinding {
  return typeof value === "object" && value !== null
    && "kind" in value && typeof value.kind === "string" && kinds.includes(value.kind)
    && "index" in value && typeof value.index === "number" && Number.isInteger(value.index) && value.index >= 0;
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function parseSteeringCalibration(value: unknown): SteeringCalibration {
  const base = defaultSteeringCalibration();
  if (typeof value !== "object" || value === null) return base;
  const record = value as Record<string, unknown>;
  return {
    center: num(record.center, base.center),
    left: num(record.left, base.left),
    right: num(record.right, base.right),
    invert: bool(record.invert, base.invert),
    deadzone: clamp(num(record.deadzone, base.deadzone), 0, MAX_DEADZONE),
    calibrated: bool(record.calibrated, base.calibrated),
  };
}

function parsePedalCalibration(value: unknown): PedalCalibration {
  const base = defaultPedalCalibration();
  if (typeof value !== "object" || value === null) return base;
  const record = value as Record<string, unknown>;
  return {
    released: num(record.released, base.released),
    pressed: num(record.pressed, base.pressed),
    deadzone: clamp(num(record.deadzone, base.deadzone), 0, MAX_DEADZONE),
    calibrated: bool(record.calibrated, base.calibrated),
  };
}

/**
 * Validate a stored profile. Unknown or malformed fields fall back to defaults
 * so a corrupt entry can never yield an out-of-range binding or NaN mapping.
 */
export function parseWheelProfile(value: unknown, deviceKey: string): WheelProfile {
  const profile = defaultWheelProfile(deviceKey);
  if (typeof value !== "object" || value === null) return profile;
  const record = value as Record<string, unknown>;
  const steer = record.steer as Record<string, unknown> | undefined;
  const throttle = record.throttle as Record<string, unknown> | undefined;
  const brake = record.brake as Record<string, unknown> | undefined;
  if (steer && typeof steer === "object") {
    profile.steer.binding = isBinding(steer.binding, ["axis"]) ? { kind: "axis", index: steer.binding.index } : null;
    profile.steer.calibration = parseSteeringCalibration(steer.calibration);
  }
  if (throttle && typeof throttle === "object") {
    profile.throttle.binding = isBinding(throttle.binding, ["axis", "button"]) ? { kind: throttle.binding.kind, index: throttle.binding.index } : null;
    profile.throttle.calibration = parsePedalCalibration(throttle.calibration);
  }
  if (brake && typeof brake === "object") {
    profile.brake.binding = isBinding(brake.binding, ["axis", "button"]) ? { kind: brake.binding.kind, index: brake.binding.index } : null;
    profile.brake.calibration = parsePedalCalibration(brake.calibration);
  }
  profile.reverse = isBinding(record.reverse, ["button"]) ? { kind: "button", index: record.reverse.index } : null;
  return profile;
}

export function parseInputMode(value: unknown): InputMode {
  return value === "wheel" ? "wheel" : "keyboard";
}
