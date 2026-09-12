/**
 * The live input device: keyboard and gamepad behind one command.
 *
 * Both devices are read every frame and the one that is actually being used
 * wins, so a driver can drop the pad and grab the keyboard mid-corner without
 * a mode switch. Hot-plug comes for free from that: the Gamepad API only
 * reports a pad after its first input anyway, so "connected" is just "a pad
 * appeared in the snapshot", and unplugging it leaves the keyboard in charge.
 */

import type { DriveAction, DriveCommand } from './commands';
import { gamepadActions, gamepadIsActive, sampleGamepad, type GamepadSample } from './gamepad';
import { KEYBOARD_ACTION_CODES, KEYBOARD_AXIS_CODES, keyboardCommand } from './keyboard';

export interface DriveInputOptions {
  /** One-shot actions from either device, already de-duplicated per press. */
  onAction: (action: DriveAction) => void;
  /** Notified when a pad appears or disappears, for the pause menu's readout. */
  onGamepadChange?: (connected: boolean) => void;
  /** Defaults to `window`; a test or an embedded canvas can pass its own target. */
  target?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  /** Defaults to `navigator.getGamepads()`. */
  readGamepads?: () => readonly (GamepadSample | null)[];
}

export interface DriveInput {
  /** The command for this frame. The same object every call — copy it if you keep it. */
  sample(dtS: number): Readonly<DriveCommand>;
  /** Suspend driving input (pause menu open) without losing key state. */
  setEnabled(enabled: boolean): void;
  readonly gamepadConnected: boolean;
  dispose(): void;
}

export function createDriveInput(options: DriveInputOptions): DriveInput {
  const target = options.target ?? window;
  const readGamepads = options.readGamepads
    ?? (() => (navigator.getGamepads?.() ?? []) as readonly (GamepadSample | null)[]);
  const pressed = new Set<string>();
  const command: DriveCommand = { throttle: 0, brake: 0, steer: 0, handbrake: false };
  const padCommand: DriveCommand = { throttle: 0, brake: 0, steer: 0, handbrake: false };
  let enabled = true;
  let padMask = 0;
  let padConnected = false;
  let disposed = false;

  const onKeyDown = (event: KeyboardEvent): void => {
    // A driver typing in a text field is not steering.
    const element = event.target as HTMLElement | null;
    if (
      element?.isContentEditable === true
      || element?.tagName === 'INPUT'
      || element?.tagName === 'TEXTAREA'
      || element?.tagName === 'SELECT'
    ) return;
    const action = KEYBOARD_ACTION_CODES[event.code];
    if (action) {
      event.preventDefault();
      // Pause must still be reachable while input is suspended, and repeat
      // events must not fire an action once per frame the key is held.
      if (!event.repeat && (enabled || action === 'pause')) options.onAction(action);
      return;
    }
    if (!KEYBOARD_AXIS_CODES[event.code]) return;
    // Space and the arrows scroll the page; a game must not scroll under the car.
    event.preventDefault();
    pressed.add(event.code);
  };
  const onKeyUp = (event: KeyboardEvent): void => {
    if (!KEYBOARD_AXIS_CODES[event.code]) return;
    event.preventDefault();
    pressed.delete(event.code);
  };
  // A window that loses focus never delivers the keyup, which used to leave the
  // throttle pinned while the player alt-tabbed away.
  const onBlur = (): void => pressed.clear();

  target.addEventListener('keydown', onKeyDown as EventListener);
  target.addEventListener('keyup', onKeyUp as EventListener);
  target.addEventListener('blur', onBlur);

  return {
    sample(dtS) {
      if (!enabled) {
        command.throttle = 0;
        command.brake = 0;
        command.steer = 0;
        command.handbrake = false;
        return command;
      }
      const pads = readGamepads();
      let pad: GamepadSample | null = null;
      for (const candidate of pads) {
        if (candidate && candidate.mapping === 'standard') {
          pad = candidate;
          break;
        }
      }
      if ((pad !== null) !== padConnected) {
        padConnected = pad !== null;
        options.onGamepadChange?.(padConnected);
      }
      if (pad) {
        const mask = sampleGamepad(pad, padCommand);
        for (const action of gamepadActions(padMask, mask)) options.onAction(action);
        padMask = mask;
        if (gamepadIsActive(padCommand, mask)) {
          command.throttle = padCommand.throttle;
          command.brake = padCommand.brake;
          command.steer = padCommand.steer;
          command.handbrake = padCommand.handbrake;
          return command;
        }
      } else {
        padMask = 0;
      }
      return keyboardCommand(pressed, command.steer, dtS, command);
    },
    setEnabled(next) {
      enabled = next;
      if (!next) pressed.clear();
    },
    get gamepadConnected() {
      return padConnected;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      pressed.clear();
      target.removeEventListener('keydown', onKeyDown as EventListener);
      target.removeEventListener('keyup', onKeyUp as EventListener);
      target.removeEventListener('blur', onBlur);
    },
  };
}
