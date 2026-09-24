export { NATIVE_LUMINAIRES_MANIFEST, orderNativeFixtures, planNativeLuminaires } from './luminaires.js';
export { createRenderEngine, gatedSceneSourceEvidence, resolveBinary, selectNativeRenderInputs, NATIVE_RENDER_ENGINE_ID } from './engine.js';
export type { NativeRenderEngineOptions } from './engine.js';
export { ShmBundleReader, TornBundleError, crc32 } from './shm-bundles.js';
export type { ShmBundle, ShmBundleEntry } from './shm-bundles.js';
export {
  DEFAULT_DAY_OF_YEAR, PRESET_MINUTES, WEATHER_PRESETS,
  resolveNativeLighting, sceneMinutes, solarPosition, weatherPreset,
} from './lighting.js';
export type { NativeLighting, NativeLightingResolution, NativeWeather, WeatherPreset } from './lighting.js';
export {
  NATIVE_MAP_MASTER_INPUT_ID, NATIVE_MAP_MASTER_PATH,
  assertSafeNativeMapMemberPath, collectNativeMapMembers, isNativeMapMemberInputId, nativeMapMemberInputId,
  NATIVE_MAP_MAX_MEMBERS, NativeMapCapacityError, assertNativeMapMemberCapacity,
} from './map-closure.js';
export type { NativeMapClosure, NativeMapMemberInput } from './map-closure.js';
export { NativeGpuMemoryError, ktx2VramBytes, measureNativeTextureDemand, nativeSceneEstimateBytes, nativeStartupTimeoutMs, planNativeTextureMembers, stageNativeTextureProfile, NativeTextureCapacityError, NATIVE_SCENE_RESERVE_BYTES } from './texture-profile.js';
export type { NativeMapMaster, NativeTextureMemberSource, NativeTexturePlan } from './texture-profile.js';
export type { NativeRenderTextures } from './texture-profile.js';
export { nativeCornerFocalPx, nativeTextureResidencyLevels, nativeTextureResidencyPlan, planNativeTextureDensity, NATIVE_MIN_MIP_BIAS, NATIVE_TEXTURE_DENSITY_MANIFEST, NATIVE_TEXTURE_RESIDENCY_SCHEMA } from './texture-residency.js';
export type { NativeResidencyCamera, NativeTextureDensityImage, NativeTextureDensityPlan, NativeTextureResidency } from './texture-residency.js';
export {
  DEFAULT_ACTOR_ASSETS_BASE_URL, NATIVE_ACTOR_ASSETS_INPUT_ID, NATIVE_ACTOR_ASSETS_RELATIVE_PATH,
  PINNED_ACTOR_ASSETS_DIGEST, PINNED_ACTOR_ASSETS_SIZE_BYTES, actorAssetsClosureUrl, assertActorAppearanceGrounded,
  actorAssetBlobUrl, ensureActorAssets, nativeActorAssetsCacheDir, nativeActorAssetsInput, prewarmActorAssets,
} from './actor-assets.js';
export type { EnsureActorAssetsOptions, NativeActorAssetsInput, VerifiedActorAssets } from './actor-assets.js';
export { nativeActorCatalogId } from './lowering.js';
export type { NativeActorAppearance } from './lowering.js';
export {
  NATIVE_RENDER_MANIFEST_V1_SCHEMA, NATIVE_RUN_DIAGNOSTICS_V1_SCHEMA,
  NativeRenderManifestSchema, NativeRunDiagnosticsSchema, nativeEvidenceFailure, nativeRunExpectations,
  NativeEvidenceSchemaError, parseNativeRenderManifestForHost, parseNativeRunDiagnosticsForHost, parseToleratingUnknownKeys,
} from './evidence.js';
export type {
  HostParsedEvidence, NativeEvidenceFailure, TolerantParseIssue, TolerantParseSchema, NativeRenderManifest, NativeReservedArtifact, NativeRunDiagnostics, NativeRunExpectations,
} from './evidence.js';
export { NATIVE_DEFAULT_PRESET, nativeCaptureEvidence, nativeRenderRequest } from './engine.js';
export type { NativeRenderRequest } from './engine.js';
export { NATIVE_GEOMETRY_LOD_DIRECTORY, NATIVE_GEOMETRY_LOD_MANIFEST, planNativeGeometryLod } from './geometry-lod.js';
export type { NativeGeometryLodMode, NativeGeometryLodPlan } from './geometry-lod.js';
export { DEFAULT_NVENC_MAX_SESSIONS, NVENC_EQUIVALENT_CQ, VideoEncoder, assignVideoCodecs, nvencAvailable } from './video-encoder.js';
export type { NativeVideoCodec, NativeVideoEncoderPreference } from './video-encoder.js';
export { NATIVE_STAGE_TIMINGS_V1_SCHEMA, NativeStageTimingsSchema, StageSamples, splitServiceStages, summarizeStage } from './stage-timings.js';
export type { NativeStageTimings, StageSummary } from './stage-timings.js';
export { NATIVE_SERVICE_PROTOCOL, NativeServiceClient, NativeServiceTimeoutError, stripRgbaPadding } from './service-client.js';
export type {
  NativeBundleResponse, NativeFrameIdentity, NativeFrameRecord, NativeServiceConnectOptions, NativeServiceResponse,
} from './service-client.js';
export { startNativeRenderService } from './service-process.js';
export type { NativeServiceOptions, NativeServiceSession } from './service-process.js';
export {
  SIMFORGE_RENDER_BINARY_NAME, actorClosureRelativePath, probeLocalBrowserRender, probeLocalCarlaRender, probeLocalNativeRender,
  resolveActorAssets, resolveEncoder, resolveNativeRenderService, resolveProbe,
} from './local-runtime.js';
export type {
  LocalActorAssets, LocalActorAssetsSource, LocalExecutable, LocalExecutableSource, LocalNativeRenderProbe,
} from './local-runtime.js';
export { RENDER_CONFIG_KEYS, renderConfigIssues } from './render-config-keys.js';
export type { RenderConfigIssue, RenderConfigKeySpec } from './render-config-keys.js';
export { assertNativeRadarBudgets, NATIVE_RADAR_MIN_RAYS_PER_FRAME } from './engine.js';
