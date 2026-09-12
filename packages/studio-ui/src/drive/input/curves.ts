/**
 * Axis conditioning shared by every analogue input.
 *
 * A raw gamepad stick rests anywhere inside a few percent of centre and its
 * travel is linear, which makes a car twitchy on-centre and unable to hold a
 * gentle line. Deadzone then curve fixes both, in that order: rescaling after
 * the deadzone keeps full lock reachable, and the exponent puts the steering
 * resolution where a driver spends most of the time.
 */

/** Largest stick offset still treated as centred. Xbox and DualSense both rest inside this. */
export const STICK_DEADZONE = 0.12;
/** Triggers rest at 0 but chatter; a smaller gate is enough and keeps creep control. */
export const TRIGGER_DEADZONE = 0.04;
/** >1 softens on-centre steering. 2.2 is the usual arcade-to-sim compromise. */
export const STEER_CURVE_EXPONENT = 2.2;

/**
 * Remove the deadzone and rescale the remaining travel back to the full range,
 * preserving sign. Values outside the unit range are clamped: a broken axis
 * report must not translate into more than full lock.
 */
export function applyDeadzone(value: number, deadzone: number): number {
  if (!Number.isFinite(value)) return 0;
  const magnitude = Math.min(1, Math.abs(value));
  if (magnitude <= deadzone) return 0;
  const rescaled = (magnitude - deadzone) / (1 - deadzone);
  return value < 0 ? -rescaled : rescaled;
}

/**
 * Deadzone, then the response curve: the complete conditioning of a steering
 * axis, from a stick that rests off-centre to the -1..1 the physics wants.
 */
export function conditionSteerAxis(
  value: number,
  deadzone = STICK_DEADZONE,
  exponent = STEER_CURVE_EXPONENT,
): number {
  const linear = applyDeadzone(value, deadzone);
  const shaped = Math.abs(linear) ** exponent;
  return linear < 0 ? -shaped : shaped;
}
