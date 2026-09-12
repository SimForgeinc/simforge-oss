/**
 * The driving simulator's sound.
 *
 * `createVehicleAudio` is the whole public surface for a consumer: one call per
 * car, `update()` once per rendered frame with the same telemetry the HUD
 * reads, and `dispose()` when the session ends. The rest of these exports are
 * for tooling and tests — the mix arithmetic, the sample manifest and the
 * catalogue-id-to-family map.
 */
export {
  createVehicleAudio,
  type ListenerPose,
  type VehicleAudio,
  type VehicleAudioOptions,
} from './vehicle-audio';
export {
  VEHICLE_AUDIO_CLASSES,
  VEHICLE_AUDIO_CLASS_BY_CATALOG_ID,
  vehicleAudioClassFor,
  type VehicleAudioClass,
} from './classes';
export {
  CAMERA_ACOUSTICS,
  ENGINE_PROFILES,
  type CameraAcoustics,
  type DriveCamera,
  type EngineProfile,
} from './profiles';
export { ENGINE_BANDS, SHARED_SAMPLES, sampleLibraryFiles, type SharedSampleName } from './samples';
export { blendForRpm, crossfadeGains, playbackRateFor, type BandBlend, type EngineBand } from './bands';
export {
  brakeGain,
  createLadder,
  createMix,
  createMixState,
  loadBlend,
  squealGain,
  updateMix,
  windGain,
  type BandLadder,
  type DriveAudioMix,
  type MixState,
} from './mix';
export { loadSample } from './loader';
export { createNoiseSource } from './noise';
