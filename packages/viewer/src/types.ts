import type { CityAssetVariantId, CityAssetVariantPreference } from './asset-variants';
import type { LayerStats } from './streaming';

/**
 * Types for the tiled 3D city manifest (schema version 1.x) plus the public
 * option/stat shapes of {@link CityViewer}.
 */

export interface ManifestBounds {
  min: number[];
  max: number[];
}

export interface ManifestLod {
  level: number;
  file: string;
  triangles: number;
  fileSize: number;
  /** Object-space error in metres this LOD introduces vs. LOD0. LOD0 is always 0. */
  geometricError: number;
}

export interface ManifestShadowLightmap {
  lod: number;
  file: string;
}

export interface ManifestTile {
  id: string;
  gridX: number;
  gridZ: number;
  bounds: ManifestBounds;
  lods: ManifestLod[];
  shadowLightmaps?: ManifestShadowLightmap[];
}

export interface ManifestVegPrototype {
  meshName: string;
  triangles: number;
  instanceCount: number;
}

export interface ManifestVegetationTile {
  id: string;
  gridX: number;
  gridZ: number;
  bounds: ManifestBounds;
  lods: ManifestLod[];
  /** Prototype-and-sidecar tiles only; web-tier cells carry placed batches in the GLB. */
  prototypes?: ManifestVegPrototype[];
  instanceFile?: string;
}

export interface ManifestStaticLayer {
  id: string;
  file: string;
  triangles: number;
  fileSize: number;
}

export interface ManifestScene {
  bounds: ManifestBounds;
  totalTriangles: number;
  gridDimensions: number[];
  cellSize: number[];
  origin: number[];
  lodLevels: number;
  coordinateSystem: string;
}

export interface StaticSemanticsReference {
  file: string;
}

export interface CityManifest {
  version: string;
  generator?: string;
  created?: string;
  scene: ManifestScene;
  tiles: ManifestTile[];
  staticLayers?: ManifestStaticLayer[];
  vegetationTiles?: ManifestVegetationTile[];
  shadowLightmap?: {
    /** Direction the sunlight *travels* (i.e. points away from the sun). */
    sunDirection: number[];
    bakedAt?: string;
    method?: string;
  };
  actorCounts?: Record<string, number>;
  /** Optional static semantic metadata for browser sensor passes. */
  staticSemantics?: StaticSemanticsReference;
}

/**
 * Payload of `tiles/veg_X_Z.instances.json`.
 *
 * `transforms` is a flat run of 16-float column-major matrices (translation at
 * offsets 12/13/14 — verified against the Yale Street data), grouped by
 * prototype in `prototypes` order with `counts[i]` entries per group.
 * `lodKeepCounts[lod][i]` is how many of group `i` to draw at that LOD.
 */
export interface VegetationInstanceFile {
  prototypes: string[];
  counts: number[];
  transforms: number[];
  lodKeepCounts?: number[][];
}
export type MapTextureTier = 'low' | 'medium' | 'render' | 'ml';
export type TextureCodec = 'uastc' | 'bc7' | 'astc';
export interface TierSelection {
  readonly requested: MapTextureTier;
  readonly actual: MapTextureTier;
  readonly codec: TextureCodec;
  readonly longestEdgePx: 256 | 512 | null;
  readonly variantId: string | null;
  readonly downgradeReason: string | null;
}


export interface CityViewerOptions {
  /** Base URL that manifest-relative asset paths resolve against. */
  baseUrl?: string;
  /** Device pixel ratio cap. Retina at 2.0 is ~4x the fill cost of 1.0. */
  maxPixelRatio?: number;
  /** WebGL multisample antialiasing. Requires a renderer recreation to change. */
  antialias?: boolean;
  /** Screen-space-error threshold in pixels; smaller = more aggressive streaming. */
  maxScreenSpaceError?: number;
  /** Separate threshold for vegetation tiles (their errors use a different scale). */
  vegetationScreenSpaceError?: number;
  /** Resident geometry+texture budget in bytes (estimated GPU footprint). */
  byteBudget?: number;
  /** Defaults to Medium. Browser selects Low/Medium; native-only tiers are explicitly downgraded. */
  mapTextureTier?: MapTextureTier;
  /** Maximum authored compressed-texture mip dimension; geometry is unaffected. */
  textureMaxDimension?: number;
  /** Resolve external image URLs in batches before a GLTF starts loading its textures. */
  resolveAssetUrls?: ((urls: readonly string[], signal: AbortSignal) => Promise<ReadonlyMap<string, string>>) | null;
  /** Concurrent tile fetch/parse slots. */
  maxConcurrentLoads?: number;
  /** Per-frame milliseconds spent pushing new textures to the GPU. */
  uploadBudgetMs?: number;
  /** Per-frame texel budget for GPU uploads. */
  uploadPixelsPerFrame?: number;
  /** Finite positive directional intensity; defaults to VIEWER_SUN_INTENSITY (5). */
  sunIntensity?: number;
  /** Finite positive IBL intensity; defaults to VIEWER_ENVIRONMENT_INTENSITY (0.6). */
  environmentIntensity?: number;
  /** Finite positive exposure; defaults to VIEWER_EXPOSURE (1). Authored weather scales it unchanged. */
  exposure?: number;
  /** Max distance (m) at which vegetation tiles are drawn. */
  vegetationMaxDistance?: number;
  /** Resolution (px) of one grid cell inside the stitched shadow atlas. */
  shadowAtlasCellSize?: number;
  /** 0 disables the baked shadow term entirely. */
  shadowStrength?: number;
  /** Render the baked shadow term instead of shading (projection QA). */
  debugShadowProjection?: boolean;
  /**
   * Generated sky, its image-based light, and the sun's shadow map.
   *
   * Explicit off leaves the flat clear colour and bare direct sun; diagnostics
   * report cinematic_lighting_disabled. Both browser texture tiers default on.
   */
  cinematicLighting?: boolean;
  /**
   * Cast a real-time sun shadow map. Maps that ship no baked lightmap have no
   * other source of ground contact, and the map also shadows actors, which a
   * bake can never contain.
   */
  realtimeShadows?: boolean;
  /** Shadow map resolution per side. */
  shadowMapSize?: number;
  /** Radius (m) around the camera the shadow map covers. */
  shadowRadiusM?: number;
  /** Horizontal metres kept between the camera and the map footprint edge. */
  cameraBoundsInset?: number;
  /** Local optimized asset preference. Ultra Low fails closed rather than fetching textured source. */
  assetVariant?: CityAssetVariantPreference;
  /** Variant manifest URL; defaults to `variants/manifest.json` beside the source manifest. */
  variantManifestUrl?: string;
  /** Required before KTX2 variants can be selected (for example `/basis/`). */
  ktx2TranscoderPath?: string;
}

export interface CameraDiagnostics {
  ready: boolean;
  position: [number, number, number];
  target: [number, number, number];
  groundY: number | null;
  altitudeAgl: number | null;
  minAltitude: number | null;
  maxAltitude: number | null;
  viewDistance: number;
  fov: number;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number; width: number; height: number } | null;
  localBuildingMax: number | null;
  headroom: number | null;
  clamps: { eyeX: boolean; eyeY: boolean; eyeZ: boolean; targetX: boolean; targetY: boolean; targetZ: boolean };
}

export interface FrameTimeCounts {
  over16_7: number;
  over25: number;
  over33_3: number;
  over50: number;
}

export interface FramePhaseStats {
  controlsMsAvg: number;
  streamingMsAvg: number;
  uploadsMsAvg: number;
  renderMsAvg: number;
  integrationMsAvg: number;
}

/** Quality controls that are safe to tune while a map remains loaded. */
export interface CityViewerLiveQuality {
  maxPixelRatio: number;
  maxScreenSpaceError: number;
  vegetationScreenSpaceError: number;
  byteBudget: number;
  uploadBudgetMs: number;
  uploadPixelsPerFrame: number;
  vegetationMaxDistance: number;
  exposure: number;
}

export interface CityViewerStats {
  tierSelection: TierSelection;
  loadDiagnostics: {
    capabilities: { maxTextureSize: number; bc7: boolean; astc: boolean; vendor: string | null; renderer: string | null };
    availableVariantIds: string[];
    lastError: {
      name: string; message: string; code?: string; field?: string; cause?: string;
      layer?: string; assetId?: string; required?: boolean; estimatedBytes?: number;
      residentBytes: number; pendingBytes: number; byteBudget: number;
    } | null;
    textureFormats: Record<string, number>;
    rgbaFallbacks: Record<string, number>;
    contentWarnings: Record<string, number>;
    shadowAtlas: {
      requestedCellPx: number; actualCellPx: number; width: number; height: number;
      residentBytes: number; downgradeReason: string | null;
    } | null;
    admissionUnderestimates: Record<string, LayerStats['largestAdmissionUnderestimate']>;
  };
  /** Required visible geometry is resident, independently of final texture quality. */
  usable: boolean;
  /** Required geometry AND the selected minimum texture tier are resident. */
  targetQualityReady: boolean;
  mapTextures: {
    dimensions: Record<string, number>;
    fetchedBytes: number;
    fetchedContainers: number;
    containerCacheHits: number;
  };
  fps: number;
  frameMsAvg: number;
  frameMsP50: number;
  frameMsP95: number;
  frameMsP99: number;
  frameMsMax: number;
  frameTimeCounts: FrameTimeCounts;
  phases: FramePhaseStats;
  drawCalls: number;
  triangles: number;
  programs: number;
  /** Tiles with at least one resident LOD. */
  residentTiles: number;
  /** Resident (tile, lod) assets across city + vegetation. */
  residentAssets: number;
  residentBytes: number;
  /** Decoded but not yet uploaded/swapped bytes; counts against the budget. */
  pendingBytes: number;
  byteBudget: number;
  loading: number;
  queued: number;
  /** Assets parsed and waiting on the paced GPU upload. */
  uploading: number;
  /** Remaining paced texture uploads; decreases while a large asset is still preparing. */
  pendingTextureUploads: number;
  /** Live byte-level network telemetry for the current map or preset load. */
  downloads: import('./download-progress').AssetDownloadStats;
  /** Required scene work only; optional LOD refinement may continue after zero. */
  requiredPendingAssets?: number;
  /** Terminal failure of required scene preparation, not optional refinement. */
  requiredError?: string | null;
  /**
   * Optional detail tiles that gave up after their retries. The map is usable
   * with them missing, so a consumer reports reduced detail rather than a
   * failed load; `requiredError` is the failure that makes a map unusable.
   */
  detailFailures?: number;
  /** The last optional-detail failure, for a "some detail is missing" line. */
  detailError?: string | null;
  /** Completion counters never decrease during a map load, including LOD eviction. */
  loadProgress?: {
    decodedAssets: number;
    uploadedTextures: number;
    compiledAssets: number;
    /** Effective map texture mip limit after fitting required geometry into the budget. */
    textureMaxDimension?: number;
    stage: 'downloading' | 'decoding' | 'uploading' | 'compiling' | 'ready' | 'error';
  };
  jsHeapMB: number | null;
  cameraMode: 'orbit' | 'fly';
  /** True when GPU rendering and scene streaming are bypassed but integrations still tick. */
  renderingSuspended: boolean;
  /** Road/ground geometry is resident and its layer is visible. */
  roadVisible: boolean;
  /** Latest map/preset streaming failure, including asynchronous mode switches. */
  streamingError: string | null;
  /** Browser UI loop frequency; deliberately not the simulation engine throughput. */
  uiTicksPerSecond: number;
  /** Runtime semantic material classification and shader-application telemetry. */
  surfaceMaterials: import('./surface-materials').SurfaceMaterialReport;
  /** Runtime snow-overlay residency and coverage telemetry. */
  snowCover: import('./snow-cover').SnowCoverStats;
  assetVariants: {
    manifest: boolean;
    loaded: Record<CityAssetVariantId | 'original', number>;
    fallbacks: number;
  };
  /** Per-layer residency against what the camera currently wants. */
  coverage: StreamingCoverage;
}

/** Whether a streamed layer has everything the camera wants resident. */
export interface LayerCoverage {
  /** Tiles the camera wants resident at any LOD. */
  wantedTiles: number;
  /** Wanted tiles with no LOD resident at all: visible holes. */
  missingTiles: number;
  /**
   * Tiles the camera can actually see that are displaying nothing. Zero is the
   * readiness contract: a scene that reports itself loaded shows no holes, and
   * nothing pops into the frame afterwards.
   */
  missingInViewTiles: number;
  /** Wanted tiles whose desired LOD is refused by the byte budget. */
  budgetBlockedTiles: number;
  /** Wanted tiles that failed terminally and will not retry. */
  failedTiles: number;
}

/** Per-layer coverage; `null` when the active fidelity does not stream that layer. */
export interface StreamingCoverage {
  roads: LayerCoverage | null;
  city: LayerCoverage | null;
  vegetation: LayerCoverage | null;
}

export interface BenchResult {
  avgFps: number;
  p50FrameMs: number;
  p95FrameMs: number;
  p99FrameMs: number;
  maxFrameMs: number;
  minFps: number;
  drawCalls: number;
  residentBytes: number;
  frames: number;
  durationMs: number;
  frameTimeCounts: FrameTimeCounts;
  /** Frame pacing while the camera reverses direction and changes pitch/radius. */
  orbit: {
    frames: number;
    durationMs: number;
    p50FrameMs: number;
    p95FrameMs: number;
    p99FrameMs: number;
    maxFrameMs: number;
    over33_3: number;
    over50: number;
  };
  phases: FramePhaseStats;
  /** ISO timestamp makes downloaded benchmark snapshots self-identifying. */
  capturedAt: string;
  renderingSuspended: boolean;
  displayFps: number;
  uiFrameP95Ms: number;
  /** Supplied by an integration benchmark; renderer-only benchmarks leave this null. */
  simulationTicksPerSecond: number | null;
  cpuUtilizationProxy: number;
}

export interface RendererCapability {
  readonly renderer: string;
  readonly vendor: string;
  readonly webgl2: boolean;
  readonly software: boolean;
}
