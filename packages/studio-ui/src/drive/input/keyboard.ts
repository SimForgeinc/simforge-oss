/**
 * Keyboard driving.
 *
 * Keys are binary, a steering rack is not: holding A must sweep the wheel over
 * a believable time and releasing it must return to centre faster than it left,
 * or the car feels like it is snapping between three steering positions. The
 * throttle and brake stay binary on purpose — the physics already models
 * actuator lag, so shaping them here would double up.
 */

import type { DriveAction, DriveCommand } from './commands';

/** Steering lock reached per second while a steer key is held. */
export const KEYBOARD_STEER_RATE_PER_S = 3.2;
/** Return-to-centre rate once no steer key is held. Faster than the sweep, as a real rack is. */
export const KEYBOARD_CENTRE_RATE_PER_S = 6.5;

/** Keys held for a continuous axis, by `KeyboardEvent.code`. */
export const KEYBOARD_AXIS_CODES: Readonly<Record<string, 'throttle' | 'brake' | 'left' | 'right' | 'handbrake'>> = {
  KeyW: 'throttle',
  ArrowUp: 'throttle',
  KeyS: 'brake',
  ArrowDown: 'brake',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  Space: 'handbrake',
};

/** Keys that fire a one-shot action on press, by `KeyboardEvent.code`. */
export const KEYBOARD_ACTION_CODES: Readonly<Record<string, DriveAction>> = {
  KeyR: 'reset',
  KeyC: 'cycleCamera',
  Escape: 'pause',
  KeyM: 'toggleMute',
  KeyU: 'toggleUnits',
  KeyT: 'toggleTraffic',
  KeyH: 'horn',
  F3: 'toggleDebug',
};

/**
 * The steering value after `dtS` of the given key state.
 *
 * Pure so the ramp can be tested without a clock: the DOM layer owns the
 * held-key set and the frame delta, this owns the feel.
 */
export function advanceKeyboardSteer(current: number, left: boolean, right: boolean, dtS: number): number {
  const step = Math.max(0, dtS);
  if (left === right) {
    const decay = KEYBOARD_CENTRE_RATE_PER_S * step;
    return Math.abs(current) <= decay ? 0 : current - Math.sign(current) * decay;
  }
  const target = left ? -1 : 1;
  const sweep = KEYBOARD_STEER_RATE_PER_S * step;
  // Crossing centre uses the sweep rate rather than the (faster) centring rate,
  // because the driver is asking for the opposite lock, not for straight.
  return target > current ? Math.min(target, current + sweep) : Math.max(target, current - sweep);
}

/**
 * Fold the held keys and the previous steering value into one command.
 *
 * `steer` is carried in and out rather than stored here so the caller can keep
 * exactly one command object alive for the session and mutate it per frame.
 */
export function keyboardCommand(
  pressed: ReadonlySet<string>,
  previousSteer: number,
  dtS: number,
  into: DriveCommand,
): DriveCommand {
  let throttle = false;
  let brake = false;
  let left = false;
  let right = false;
  let handbrake = false;
  for (const code of pressed) {
    const axis = KEYBOARD_AXIS_CODES[code];
    if (axis === 'throttle') throttle = true;
    else if (axis === 'brake') brake = true;
    else if (axis === 'left') left = true;
    else if (axis === 'right') right = true;
    else if (axis === 'handbrake') handbrake = true;
  }
  into.throttle = throttle ? 1 : 0;
  into.brake = brake ? 1 : 0;
  into.steer = advanceKeyboardSteer(previousSteer, left, right, dtS);
  into.handbrake = handbrake;
  return into;
}
