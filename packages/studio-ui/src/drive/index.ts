/** The driving simulator's UI and its device-independent game logic. */
export {
  DRIVE_CAMERA_KINDS,
  DriveCameraRig,
  ORBIT_MAX_DISTANCE_M,
  ORBIT_MAX_PITCH_RAD,
  ORBIT_MIN_DISTANCE_M,
  ORBIT_MIN_PITCH_RAD,
  desiredCameraPose,
  springVelocity,
  type DriveCameraKind,
  type DriveCameraPose,
  type EgoDims,
  type EgoPose,
  type OrbitState,
} from "./cameras";
export { CarPickerScreen, DRIVE_PAINT_COLORS, type DriveVehicleOption } from "./CarPickerScreen";
export { MapPickerScreen, type DriveMapOption } from "./MapPickerScreen";
export { PauseMenu } from "./PauseMenu";
export { VehicleModelPreview } from "./VehicleModelPreview";
export { DriveHud, type DriveHudFrame, type DriveHudHandle, type SpeedUnits } from "./hud/DriveHud";
export { Minimap, type MinimapHandle, type MinimapLane } from "./hud/Minimap";
export { createDriveInput, type DriveInput, type DriveInputOptions } from "./input/drive-input";
export type { DriveAction, DriveCommand } from "./input/commands";
export {
  STEER_CURVE_EXPONENT,
  STICK_DEADZONE,
  TRIGGER_DEADZONE,
  applyDeadzone,
  conditionSteerAxis,
} from "./input/curves";
export {
  GAMEPAD_ACTION_BUTTONS,
  gamepadActions,
  gamepadIsActive,
  sampleGamepad,
  type GamepadSample,
} from "./input/gamepad";
export {
  KEYBOARD_ACTION_CODES,
  KEYBOARD_AXIS_CODES,
  advanceKeyboardSteer,
  keyboardCommand,
} from "./input/keyboard";
export {
  MIN_SPAWN_LANE_LENGTH_M,
  SPAWN_ENTRY_OFFSET_M,
  isSpawnableLane,
  selectLaneSpawn,
  type LaneSpawn,
  type SpawnCandidateLane,
} from "./spawn";
export { emptyDriveTelemetry, type DriveTelemetry } from "./telemetry";
