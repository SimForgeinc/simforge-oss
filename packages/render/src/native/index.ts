export { createRenderEngine, resolveBinary, NATIVE_RENDER_ENGINE_ID } from './engine.js';
export type { NativeRenderEngineOptions } from './engine.js';
export { ShmBundleReader, TornBundleError, crc32 } from './shm-bundles.js';
export { NativeServiceClient, stripRgbaPadding } from './service-client.js';
export type { NativeFrameRecord } from './service-client.js';
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
  PINNED_ACTOR_ASSETS_DIGEST, PINNED_ACTOR_ASSETS_SIZE_BYTES, actorAssetsClosureUrl, assertActorAppearanceGrounded,
  ensureActorAssets, nativeActorAssetsInput,
} from './actor-assets.js';
export type { EnsureActorAssetsOptions, NativeActorAssetsInput, VerifiedActorAssets } from './actor-assets.js';
export { nativeActorCatalogId } from './lowering.js';
export type { NativeActorAppearance } from './lowering.js';
export {
  NATIVE_RENDER_MANIFEST_V1_SCHEMA, NATIVE_RUN_DIAGNOSTICS_V1_SCHEMA,
  NativeRenderManifestSchema, NativeRunDiagnosticsSchema, nativeEvidenceFailure, nativeRunExpectations,
} from './evidence.js';
export type {
  NativeEvidenceFailure, NativeRenderManifest, NativeReservedArtifact, NativeRunDiagnostics, NativeRunExpectations,
} from './evidence.js';
export { NATIVE_SERVICE_PROTOCOL, NativeServiceClient, NativeServiceTimeoutError, stripRgbaPadding } from './service-client.js';
export type {
  NativeBundleResponse, NativeFrameIdentity, NativeFrameRecord, NativeServiceConnectOptions, NativeServiceResponse,
} from './service-client.js';
export { startNativeRenderService } from './service-process.js';
export type { NativeServiceOptions, NativeServiceSession } from './service-process.js';
export {
  NATIVE_RENDER_SERVICE_NAME, actorClosureRelativePath, probeLocalBrowserRender, probeLocalNativeRender,
  resolveActorAssets, resolveEncoder, resolveNativeRenderService, resolveProbe,
} from './local-runtime.js';
export type {
  LocalActorAssets, LocalActorAssetsSource, LocalExecutable, LocalExecutableSource, LocalNativeRenderProbe,
} from './local-runtime.js';
