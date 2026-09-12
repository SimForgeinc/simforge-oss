/**
 * Gamepad driving, against the W3C standard mapping.
 *
 * Standard mapping is the only layout addressed by index here: every pad that
 * reports `mapping: 'standard'` (Xbox, DualSense, 8BitDo, most third parties)
 * agrees on axis 0 = left stick X, button 6 = left trigger, button 7 = right
 * trigger and buttons 0-3 = the face cluster. A pad that reports something else
 * is refused rather than guessed at, because a mis-guessed layout means the
 * car drives itself.
 */

import type { DriveAction, DriveCommand } from './commands';
import { STICK_DEADZONE, TRIGGER_DEADZONE, applyDeadzone, conditionSteerAxis } from './curves';

/** The parts of `Gamepad` this module reads. Lets the mapping be tested without a device. */
export interface GamepadSample {
  readonly mapping: string;
  readonly axes: readonly number[];
  readonly buttons: readonly { readonly pressed: boolean; readonly value: number }[];
}

const AXIS_STEER = 0;
const BUTTON_BRAKE = 6;
const BUTTON_THROTTLE = 7;

/**
 * Face and shoulder buttons to one-shot actions. Handbrake is deliberately
 * absent: it is a held control and lives on the command, not here.
 */
export const GAMEPAD_ACTION_BUTTONS: Readonly<Record<number, DriveAction>> = {
  1: 'reset',          // B / circle
  2: 'horn',           // X / square
  3: 'cycleCamera',    // Y / triangle
  4: 'toggleTraffic',  // left bumper
  5: 'toggleUnits',    // right bumper
  8: 'toggleMute',     // view / share
  9: 'pause',          // menu / options
  16: 'toggleDebug',   // guide, where the pad reports it
};

/** A / cross, held. */
const BUTTON_HANDBRAKE = 0;

const NO_ACTIONS: readonly DriveAction[] = [];

/**
 * Read one pad into the command. Returns the button bitmask so the caller can
 * edge-detect actions against the previous frame; a pad that is not standard
 * mapping leaves the command untouched and reports no buttons.
 */
export function sampleGamepad(pad: GamepadSample, into: DriveCommand): number {
  if (pad.mapping !== 'standard') return 0;
  const throttle = pad.buttons[BUTTON_THROTTLE]?.value ?? 0;
  const brake = pad.buttons[BUTTON_BRAKE]?.value ?? 0;
  into.throttle = Math.min(1, applyDeadzone(throttle, TRIGGER_DEADZONE));
  into.brake = Math.min(1, applyDeadzone(brake, TRIGGER_DEADZONE));
  into.steer = conditionSteerAxis(pad.axes[AXIS_STEER] ?? 0, STICK_DEADZONE);
  into.handbrake = pad.buttons[BUTTON_HANDBRAKE]?.pressed ?? false;

  let mask = 0;
  const count = Math.min(31, pad.buttons.length);
  for (let index = 0; index < count; index += 1) {
    if (pad.buttons[index]?.pressed) mask |= 1 << index;
  }
  return mask;
}

/**
 * Actions for the buttons pressed since the previous mask. Returns a shared
 * empty array when nothing changed, which is every frame but the ones a human
 * actually pressed something on.
 */
export function gamepadActions(previousMask: number, mask: number): readonly DriveAction[] {
  const rising = mask & ~previousMask;
  if (rising === 0) return NO_ACTIONS;
  const actions: DriveAction[] = [];
  for (const [index, action] of Object.entries(GAMEPAD_ACTION_BUTTONS)) {
    if (rising & (1 << Number(index))) actions.push(action);
  }
  return actions;
}

/**
 * Whether a pad is asking for anything at all, used to decide which device owns
 * the car this frame. A resting pad must not cancel the keyboard, and a driver
 * touching the pad must take over instantly without a mode switch.
 */
export function gamepadIsActive(command: DriveCommand, mask: number): boolean {
  return mask !== 0 || command.throttle > 0 || command.brake > 0 || command.steer !== 0;
}
