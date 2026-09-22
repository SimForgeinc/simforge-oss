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
export {
  DASHCAM_FALLBACK_FOV_DEG,
  DASHCAM_FALLBACK_PITCH_RAD,
  dashcamMountFor,
  dashcamMountForDims,
  verticalFovDeg,
  type DashcamMount,
} from "./dashcam";
// Drive's chrome travels through this barrel; its *tokens* deliberately do
// not. StyleX resolves `defineVars` through the importing module's own path,
// so a var group re-exported from an index fails the compile — import
// `./drive.stylex` directly. In this repo that means the source path even
// from `studio/app`, because StyleX resolves theme specifiers with plain Node
// conditions and the `@simforge-oss/studio-ui/drive/drive.stylex` subpath
// would land on `dist`; the subpath export is for consumers outside the repo.
export { DriveButton, DrivePill, driveChrome } from "./chrome";
export { PauseMenu } from "./PauseMenu";
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
export { emptyDriveTelemetry, type DriveTelemetry } from "./telemetry";
