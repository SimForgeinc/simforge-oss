/**
 * What a driver asks of the car, and what a driver asks of the game.
 *
 * The split matters: the command is continuous and is pushed to the physics
 * runtime every rendered frame, while actions are discrete edges that must fire
 * exactly once per press no matter which device produced them or how many
 * frames the button stays down.
 */

/** The per-frame driver command, matching the runtime's `setDriverCommand` payload. */
export interface DriveCommand {
  /** 0..1 */
  throttle: number;
  /** 0..1 */
  brake: number;
  /** -1 full left .. 1 full right */
  steer: number;
  handbrake: boolean;
}

/** One-shot game actions. Every device maps onto this set and nothing else. */
export type DriveAction =
  | 'reset'
  | 'cycleCamera'
  | 'pause'
  | 'toggleMute'
  | 'toggleUnits'
  | 'toggleTraffic'
  | 'toggleDebug'
  | 'horn';
