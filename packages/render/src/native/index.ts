export { createRenderEngine, resolveBinary, NATIVE_RENDER_ENGINE_ID } from './engine.js';
export type { NativeRenderEngineOptions } from './engine.js';
export { ShmBundleReader, TornBundleError, crc32 } from './shm-bundles.js';
export type { ShmBundle, ShmBundleEntry } from './shm-bundles.js';
export {
  CINEMATIC_PROFILE_CONFIG, DEFAULT_DAY_OF_YEAR, PRESET_MINUTES, WEATHER_PRESETS,
  resolveNativeLighting, sceneMinutes, solarPosition, weatherPreset,
} from './lighting.js';
export type { NativeLighting, NativeLightingResolution, NativeWeather, WeatherPreset } from './lighting.js';
export {
  NATIVE_MAP_MASTER_INPUT_ID, NATIVE_MAP_MASTER_PATH,
  assertSafeNativeMapMemberPath, collectNativeMapMembers, isNativeMapMemberInputId, nativeMapMemberInputId,
} from './map-closure.js';
export type { NativeMapClosure, NativeMapMemberInput } from './map-closure.js';
export {
  DEFAULT_ACTOR_ASSETS_BASE_URL, NATIVE_ACTOR_ASSETS_INPUT_ID, NATIVE_ACTOR_ASSETS_RELATIVE_PATH,
  PINNED_ACTOR_ASSETS_DIGEST, PINNED_ACTOR_ASSETS_SIZE_BYTES, actorAssetsClosureUrl, nativeActorAssetsInput,
} from './actor-assets.js';
export type { NativeActorAssetsInput, VerifiedActorAssets } from './actor-assets.js';
export { nativeActorCatalogId } from './lowering.js';
export type { NativeActorAppearance } from './lowering.js';
export {
  NATIVE_RENDER_MANIFEST_V1_SCHEMA, NATIVE_RUN_DIAGNOSTICS_V1_SCHEMA,
  NativeRenderManifestSchema, NativeRunDiagnosticsSchema, nativeEvidenceFailure, nativeRunExpectations,
} from './evidence.js';
export type {
  NativeEvidenceFailure, NativeRenderManifest, NativeReservedArtifact, NativeRunDiagnostics, NativeRunExpectations,
} from './evidence.js';
export { NATIVE_SERVICE_PROTOCOL } from './service-client.js';
