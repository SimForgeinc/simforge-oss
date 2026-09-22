import { sha256BytesAsync } from '@simforge-oss/engine/hash';
import { externalModelDiagnostics } from './externalModel';
import {
  AgXToneMapping,
  Box3,
  Color,
  DirectionalLight,
  Frustum,
  Group,
  MathUtils,
  Matrix4,
  Mesh,
  Object3D,
  PCFSoftShadowMap,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { InstancedMesh, Material, Texture } from 'three';
import { CameraRig, type CameraMode } from './camera-controls';
import type { CameraView } from './camera-controls';
import type { CameraControlPreferences } from './camera-drag';
import { cameraEnvelopeFromBounds, constrainCameraToEnvelope, initialEditorCameraPose, initialEditorFocus } from './camera-envelope';
import { FrameStats, jsHeapMB } from './frame-stats';
import { AssetDownloadTracker, readResponseBufferWithProgress } from './download-progress';
import { disposeAlbedoInspection, isMaskOnlyAlbedo, registerAlbedoTexture } from './albedo-color';
import {
  collectResources,
  disposeResources,
  estimateResourceBytes,
  getGLTFLoader,
  parseMapGLTF,
  trackedTextureStats,
  type MapTextureSource,
  resourceDirectory,
  disposeTrackedLoader,
} from './gltf';
import { createSun } from './environment';
import {
  VIEWER_ENVIRONMENT_INTENSITY,
  VIEWER_EXPOSURE,
  VIEWER_SUN_INTENSITY,
} from './lighting-calibration';
import { LuminaireLightingController, type LuminaireLightingStats } from './luminaire-lighting';
import { GroundIndex, type GroundIndexOptions } from './ground-index';
import { boundsToBox3, normalizeLods, resolveUrl } from './manifest';
import { patchTree, setBakedSuppression, type ShadowPatchOptions } from './materials';
import { SurfaceMaterialRegistry, type SurfaceMaterialProfile } from './surface-materials';
import { SnowCoverController } from './snow-cover';
import { WeatherController, type CityWeatherAppearance } from './weather';
import { ShadowAtlas } from './shadow-atlas';
import { allowsSourceAssetFallback, isCityAssetVariantManifest, probeTextureCapabilities, resolveSnowCoverVariant, selectAssetVariant, selectTextureTier } from './asset-variants';
import type { CityAssetVariant, CityAssetVariantId, CityAssetVariantManifest, TextureTierIndex, TextureVariantId } from './asset-variants';
import {
  ATMOSPHERE_LAYER,
  CLEAR_SKY,
  SkyDome,
  skyAppearanceForWeather,
  sunElevationFalloff,
} from './sky';
import {
  BAKED_SUPPRESSION_OFF,
  applySunShadowFit,
  bakedSuppressionRadii,
  fitSunShadow,
  shadowBakeIsStale,
  shadowRadiusForScene,
} from './sun-shadow';
import {
  applyStaticSemantics,
  parseStaticSemantics,
  staticSemanticsCapabilities,
  type StaticSemantics,
} from './static-semantics';
import {
  TileStreamLayer,
  boxOf,
  type EvictionCandidate,
  type LayerStats,
  type PreparedAsset,
  RequiredAssetBudgetError,
  type StreamTileDef,
} from './streaming';
import { ViewerOverlayLayer, type ViewerOverlayState, type ViewerPoint3 } from './overlays';
import { buildVegetation, type VegPrototypeGroup } from './vegetation';
import { ViewerInputError, requireMapReference, requirePositive, requireRenderableGeometry, requireRenderableManifest, requireTextureTier } from './render-input';
import type {
  BenchResult,
  CameraDiagnostics,
  CityManifest,
  CityViewerLiveQuality,
  CityViewerOptions,
  CityViewerStats,
  FramePhaseStats,
  FrameTimeCounts,
  LayerCoverage,
  RendererCapability,
  VegetationInstanceFile,
  MapTextureTier,
  TierSelection,
} from './types';

export interface CityViewerLayers {
  city: boolean;
  vegetation: boolean;
}

function layerCoverage(stats: LayerStats | undefined): LayerCoverage | null {
  if (!stats) return null;
  return {
    wantedTiles: stats.wantedTiles,
    missingTiles: stats.missingTiles,
    missingInViewTiles: stats.missingInViewTiles,
    budgetBlockedTiles: stats.budgetBlockedTiles,
    failedTiles: stats.failedTiles,
  };
}

const DEFAULTS = {
  vegetation: true,
  maxPixelRatio: 2,
  antialias: true,
  /**
   * Pixel threshold for the LOD selector. The Yale Street geometric errors are
   * a 4x chain (4.6 / 18.2 / 72.9 m for a 76 m cell), so at a 1600 px tall
   * buffer this puts LOD0 inside ~23 m, LOD1 inside ~93 m and LOD2 inside
   * ~370 m — which is what keeps the resident set near the byte budget, since
   * LOD here is really texture resolution (2048 -> 256 px) and one LOD0 tile
   * can cost 900 MB of RGBA.
   */
  maxScreenSpaceError: 300,
  /**
   * Vegetation errors in this manifest are ~16x the city's for the same cell,
   * so they need their own threshold or every tree tile would pin to LOD0.
   */
  vegetationScreenSpaceError: 2000,
  /**
   * Estimated GPU bytes. 1.5 GB, not the 2.5 GB the textures would happily
   * fill: Chrome's GPU process on an M-series MacBook kills the tab somewhere
   * above ~2 GB of live RGBA8 + mips, and the in-flight decode queue adds its
   * own copy on top of whatever is already resident.
   */
  byteBudget: 1.5 * 1024 * 1024 * 1024,
  textureMaxDimension: Infinity,
  mapTextureTier: 'medium' as MapTextureTier,
  resolveMapAssetUrls: null,
  resolveAssetUrls: null,
  maxConcurrentLoads: 12,
  uploadBudgetMs: 5,
  /** ~one 2048px texture per frame; the pacer stops as soon as this is spent. */
  uploadPixelsPerFrame: 4.2e6,
  /**
   * Sun vs sky balance. The lightmap only removes *direct* light, so a
   * sky-dominant balance makes the baked shadows invisible. Values come from
   * the shared lighting spec (docs/lighting-calibration.md, §Three-viewer
   * working units).
   */
  sunIntensity: VIEWER_SUN_INTENSITY,
  environmentIntensity: VIEWER_ENVIRONMENT_INTENSITY,
  exposure: VIEWER_EXPOSURE,
  vegetationMaxDistance: 260,
  shadowAtlasCellSize: 512,
  shadowStrength: 1,
  debugShadowProjection: false,
  cinematicLighting: true,
  realtimeShadows: true,
  /**
   * 2048 over a 120 m radius is ~12 cm per texel, which resolves the contact
   * shadow under a vehicle without the acne a coarser map produces on curbs.
   */
  shadowMapSize: 2048,
  shadowRadiusM: 120,
  cameraBoundsInset: 2,
  assetVariant: 'auto' as const,
  variantManifestUrl: '',
  ktx2TranscoderPath: '',
};

/**
 * Distance bands for vegetation density, and the `lodKeepCounts` row each band
 * uses. Row 1 is skipped on purpose: this dataset ships it identical to row 0,
 * so bands map to rows 0 / 2 / 3 to actually thin the instances out.
 */
/**
 * Readiness and prefetch policy.
 *
 * A scene is ready when everything the camera can see NEARBY is on screen: the
 * road, every city tile within `READY_DISTANCE_M` that the frustum touches,
 * and every tile within `READY_RADIUS_M` of the viewpoint (so a vehicle is
 * never sitting inside an empty block, whatever way it is facing).
 *
 * The frustum alone is unbounded in depth — a camera looking down a street
 * intersects tiles kilometres away — and a block resolving 800 m off across
 * the skyline is not what a driver notices; a building appearing 40 m ahead
 * is. So readiness is bounded by distance as well, and the far field keeps
 * filling behind it. It is deliberately NOT "every tile in the map":
 * preloading a whole city before showing anything is the wait this replaces.
 *
 * Streaming continues after that, but invisibly. Tiles are wanted while they
 * are within `PREFETCH_MARGIN_M` of the view frustum or `PREFETCH_RADIUS_M` of
 * the viewpoint, which at city driving speeds is several seconds of travel, so
 * a tile is resident well before it can enter the frame.
 */
const READY_RADIUS_M = 150;
const READY_DISTANCE_M = 350;
/** A slow-start diagnostic, not proof that the required footprint can never load. */
const VIEW_RESIDENT_TIMEOUT_MS = 60_000;
/** A fetch or driver promise that never settles must not keep loadMap pending forever. */
const VIEW_RESIDENT_HARD_TIMEOUT_MS = 10 * VIEW_RESIDENT_TIMEOUT_MS;

class ResidencyTimeoutError extends Error {
  readonly code = 'view_residency_stalled';
  constructor(readonly diagnostics: { requiredPendingAssets: number; missingInViewTiles: number;
    residentBytes: number; pendingBytes: number; byteBudget: number }) {
    super(`Required residency stalled for ${VIEW_RESIDENT_HARD_TIMEOUT_MS} ms: ${diagnostics.requiredPendingAssets} required assets pending, ${diagnostics.missingInViewTiles} missing in view; resident ${diagnostics.residentBytes}, pending ${diagnostics.pendingBytes}, budget ${diagnostics.byteBudget} bytes`);
    this.name = 'ResidencyTimeoutError';
  }
}
/**
 * How much more texture upload per frame is allowed while the first view is
 * still being assembled, when no interactive frame is at stake.
 */
const LOAD_UPLOAD_BUDGET_FACTOR = 8;
const PREFETCH_MARGIN_M = 250;
const PREFETCH_RADIUS_M = 400;

const VEG_BAND_DISTANCES = [80, 170];
const VEG_BAND_KEEP_ROW = [0, 2, 3];

const _rayOrigin = new Vector3();
const _down = new Vector3(0, -1, 0);
const _cameraPos = new Vector3();
// React StrictMode reuses the canvas across effect teardown/setup. Its new
// renderer gets the SAME WebGL context while the old compile polls drain.
const canvasRendererOwners = new WeakMap<HTMLCanvasElement, WebGLRenderer>();
const releasedCanvasContexts = new WeakMap<HTMLCanvasElement, WebGLRenderingContext | WebGL2RenderingContext>();

const _sunTravel = new Vector3();

/**
 * Sun movement that is worth rebuilding the image-based light and the shadow
 * bake for. Below this the ambient term does not visibly change, and a scene
 * clock scrubbed continuously would otherwise rebuild both every tick.
 */
const SUN_SYNC_TOLERANCE_RAD = MathUtils.degToRad(0.25);

export function isRendererOwnedVisualRoot(object: Object3D): boolean {
  const role = object.userData.simforgeRole;
  return role === 'city-weather'
    || role === 'city-snow-cover'
    || role === 'city-sky'
    || role === 'city-luminaires';
}

export function snowStreamingContribution(stats: import('./snow-cover').SnowCoverStats): {
  loading: number;
  queued: number;
} {
  return {
    loading: stats.pendingDerivatives,
    queued: stats.queuedDerivatives + stats.queuedFallbacks,
  };
}

export function admitSnowWithinBudget(
  bytes: number,
  byteBudget: number,
  admit: (bytes: number) => boolean,
): boolean {
  return Number.isFinite(bytes) && bytes > 0 && bytes <= byteBudget
    ? admit(bytes)
    : false;
}

function smoothStep(value: number): number {
  const clamped = Math.max(0, Math.min(1, value));
  return clamped * clamped * (3 - 2 * clamped);
}

/** A reversible, multi-angle orbit path expressed in map-span units. */
function benchmarkOrbitPose(progress: number): { angle: number; radius: number; height: number } {
  if (progress < 0.4) {
    const t = smoothStep(progress / 0.4);
    return {
      angle: (-120 + 240 * t) * Math.PI / 180,
      radius: 0.62 - 0.06 * Math.sin(Math.PI * t),
      height: 0.32,
    };
  }
  if (progress < 0.75) {
    const t = smoothStep((progress - 0.4) / 0.35);
    return {
      angle: (120 - 200 * t) * Math.PI / 180,
      radius: 0.5,
      height: 0.22 + 0.2 * Math.sin(Math.PI * t),
    };
  }
  const t = smoothStep((progress - 0.75) / 0.25);
  return {
    angle: (-80 + 115 * t) * Math.PI / 180,
    radius: 0.38 + 0.17 * t,
    height: 0.2 + 0.08 * t,
  };
}

/**
 * Streaming 3D city viewer.
 *
 * Owns the renderer, the scene, both streaming layers (city tiles + vegetation)
 * and the camera rig. Framework free — see `./react` for the React wrapper.
 */
export class CityViewer {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly controls: CameraRig;

  /** Static road/ground layer, also the ground-sampling target. */
  readonly roadGroup = new Group();
  readonly cityGroup = new Group();
  readonly vegetationGroup = new Group();

  private readonly canvas: HTMLCanvasElement;
  private readonly options: Required<CityViewerOptions>;
  private readonly defaulted: readonly string[];
  private mapAdmitted = false;
  private inputError: ViewerInputError | null = null;
  private readonly frameStats = new FrameStats(150);
  private readonly downloadTracker = new AssetDownloadTracker();
  private readonly cityFrustum = new Frustum();
  private readonly cityViewProjection = new Matrix4();
  private textureLoadAbort = new AbortController();
  private effectiveTextureMaxDimension = Infinity;
  private tierSelection!: TierSelection;
  private lastLoadError: CityViewerStats['loadDiagnostics']['lastError'] = null;
  private streamingErrorOrigin: 'deadline' | 'terminal' | null = null;
  private residencyDeadline: CityViewerStats['loadDiagnostics']['residencyDeadline'] = null;
  private terminalError: Error | null = null;
  private readonly textureCapabilities: CityViewerStats['loadDiagnostics']['capabilities'];
  private textureTierIndex: TextureTierIndex | null = null;
  private textureSources: ReadonlyMap<string, MapTextureSource> = new Map();
  private sourceManifestSha256 = '';
  private textureBudgetRecovery: Promise<void> | null = null;
  private pendingTextureBudgetError: RequiredAssetBudgetError | null = null;
  private readonly phaseStats = {
    controls: new FrameStats(150),
    streaming: new FrameStats(150),
    uploads: new FrameStats(150),
    render: new FrameStats(150),
    integration: new FrameStats(150),
  };
  private readonly raycaster = new Raycaster();
  private readonly abort = new AbortController();
  private mapLoadQueue: Promise<void> = Promise.resolve();
  private mapLoaded = false;
  /** Callers waiting for the view to be on screen; see `whenViewResident`. */
  private readonly viewResidentWaiters: { resolve: () => void; deadline: number; terminalDeadline: number; progress: number }[] = [];

  private manifest: CityManifest | null = null;
  private variantManifest: CityAssetVariantManifest | null = null;
  private staticSemantics: StaticSemantics | null = null;
  private capabilities: readonly string[] = [];
  private assetBase = '';
  private atlas: ShadowAtlas | null = null;
  private cityLayer: TileStreamLayer | null = null;
  private vegLayer: TileStreamLayer | null = null;
  private roadLayer: TileStreamLayer | null = null;
  private sun: DirectionalLight | null = null;
  private readonly sky = new SkyDome();
  private readonly luminaires = new LuminaireLightingController();
  private realtimeShadows = false;
  /**
   * Whether the generated sky, its image-based light and the sun's shadow map
   * are active. Off leaves the flat clear colour and the bare direct sun, which
   * is what the reduced authoring presets ask for.
   */
  private cinematicLighting = false;
  private shadowRadius = 0;
  private shadowBake: { focus: Vector3; radius: number; sun: Vector3 } | null = null;
  private environmentFromSky = false;
  private visualResourcesPromise: Promise<void> | null = null;
  private visualResourcesStarted = false;
  private vegetationData = new Map<string, VegetationInstanceFile>();
  private sceneBox = new Box3();
  private cameraGroundIndex: GroundIndex | null = null;
  private cameraConstraintRefresh = 0;
  private readonly overlays: ViewerOverlayLayer;
  private localEnvelopeBounds: Box3 | null = null;
  private localBuildingMax = 0;
  private localGroundY = 0;
  private localHeadroom = 0;
  private localMaxAltitude = 0;
  private readonly cameraClampFlags = {
    eyeX: false, eyeY: false, eyeZ: false,
    targetX: false, targetY: false, targetZ: false,
  };

  private rafHandle = 0;
  private lastFrameTime = 0;
  private lastStreamUpdate = 0;
  private resizeObserver: ResizeObserver | null = null;
  private disposed = false;
  private benchmarkActive = false;
  private uploadSkips = 0;
  private lastDrawCalls = 0;
  private lastTriangles = 0;
  private fps = 0;
  private renderingSuspended = false;
  private canvasVisibility = '';
  private benchmarkFrameHook: (() => void) | null = null;
  private readonly surfaceMaterials = new SurfaceMaterialRegistry();
  private readonly snowCover: SnowCoverController;
  private readonly weather: WeatherController;
  private weatherAppearance: CityWeatherAppearance | null = null;
  private activityHeld = false;
  private readonly variantLoads: Record<CityAssetVariantId | 'original', number> = {
    original: 0, 'geometry-only': 0, ktx2: 0, 'textures-256-uastc': 0,
    'textures-512-uastc': 0, 'textures-512-bc7': 0, 'textures-512-astc': 0,
  };
  private variantFallbacks = 0;
  private assetVariantReloadGeneration = 0;
  private streamingError: string | null = null;
  /**
   * Optional detail that gave up, kept apart from `streamingError`.
   *
   * A city or vegetation tile that cannot be decoded costs that tile's detail;
   * roads, semantics and the map load itself are what make a map usable. Both
   * used to land in `streamingError`, so one unreadable texture reported the
   * whole map as failed while the rest of it was already on screen.
   */
  private detailFailures = 0;
  private detailError: string | null = null;
  private mapLoadActive = false;
  private presetTransitions = 0;
  private auxiliaryLoads = 0;

  private phaseSnapshot(): FramePhaseStats {
    return {
      controlsMsAvg: this.phaseStats.controls.avg(),
      streamingMsAvg: this.phaseStats.streaming.avg(),
      uploadsMsAvg: this.phaseStats.uploads.avg(),
      renderMsAvg: this.phaseStats.render.avg(),
      integrationMsAvg: this.phaseStats.integration.avg(),
    };
  }

  private frameTimeCounts(stats = this.frameStats): FrameTimeCounts {
    return {
      over16_7: stats.countAbove(16.7),
      over25: stats.countAbove(25),
      over33_3: stats.countAbove(33.3),
      over50: stats.countAbove(50),
    };
  }

  constructor(canvas: HTMLCanvasElement, options: CityViewerOptions = {}) {
    if (releasedCanvasContexts.get(canvas)?.isContextLost()) {
      const error = new Error("This canvas's WebGL context was released by a previous renderer; create a new canvas");
      error.name = 'CanvasContextReleasedError';
      throw error;
    }
    releasedCanvasContexts.delete(canvas);
    this.canvas = canvas;
    // Explicit undefined must not clobber a default (callers routinely spread
    // partially-filled option objects).
    const provided = Object.fromEntries(
      Object.entries(options).filter(([, value]) => value !== undefined),
    ) as CityViewerOptions;
    this.options = { ...DEFAULTS, baseUrl: '', ...provided };
    this.defaulted = Object.freeze(['sunIntensity', 'environmentIntensity', 'exposure', 'mapTextureTier', 'cinematicLighting']
      .filter(key => options[key as keyof CityViewerOptions] === undefined));
    requirePositive(this.options.sunIntensity, 'sunIntensity');
    requirePositive(this.options.environmentIntensity, 'environmentIntensity');
    requirePositive(this.options.exposure, 'exposure');
    requireTextureTier(this.options.mapTextureTier);
    this.effectiveTextureMaxDimension = this.options.textureMaxDimension;

    this.renderer = new WebGLRenderer({
      canvas,
      antialias: this.options.antialias,
      powerPreference: 'high-performance',
      alpha: false,
      stencil: false,
    });
    canvasRendererOwners.set(canvas, this.renderer);
    const gl = this.renderer.getContext();
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    this.textureCapabilities = { ...probeTextureCapabilities(gl),
      vendor: debugInfo ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) as string : null,
      renderer: debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) as string : null };
    this.tierSelection = selectTextureTier(this.options.mapTextureTier, this.textureCapabilities);
    this.renderer.debug.onShaderError = (gl, program, vertexShader, fragmentShader) => {
      const error = new Error(`WebGL shader compilation/linking failed: ${gl.getProgramInfoLog(program) || 'no program log'}\nVertex: ${gl.getShaderInfoLog(vertexShader) || ''}\nFragment: ${gl.getShaderInfoLog(fragmentShader) || ''}`);
      console.error(error);
      this.recordStreamingError(error);
    };
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.options.maxPixelRatio));
    this.renderer.toneMapping = AgXToneMapping;
    this.renderer.toneMappingExposure = this.options.exposure;
    this.cinematicLighting = this.options.cinematicLighting;
    this.realtimeShadows = this.cinematicLighting && this.options.realtimeShadows;
    this.renderer.shadowMap.enabled = this.realtimeShadows;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    this.renderer.info.autoReset = false;

    this.scene.name = 'city';
    // Behind the sky dome; only visible if the atmosphere is ever disabled.
    this.scene.background = new Color(0x14181e);
    this.scene.environmentIntensity = this.options.environmentIntensity;
    this.cityGroup.name = 'city-tiles';
    this.vegetationGroup.name = 'vegetation';
    this.roadGroup.name = 'road';
    this.overlays = new ViewerOverlayLayer((x, z) => this.sampleGroundHeight(x, z));
    this.scene.add(
      this.roadGroup,
      this.cityGroup,
      this.vegetationGroup,
      this.luminaires.group,
      this.overlays.group,
    );

    this.camera = new PerspectiveCamera(55, this.aspect(), 0.5, 6000);
    this.camera.position.set(0, 200, 400);
    // Sized inside the far plane or it clips away entirely, and drawn on its
    // own layer so sensor depth/LiDAR/id passes, which build their own
    // cameras, never see the dome.
    this.sky.fitToCamera(this.camera.far);
    this.sky.follow(this.camera.position);
    this.camera.layers.enable(ATMOSPHERE_LAYER);
    this.scene.add(this.sky.mesh);
    this.sky.mesh.visible = this.cinematicLighting;
    this.snowCover = new SnowCoverController(this.scene, {
      admit: (bytes) => admitSnowWithinBudget(
        bytes,
        this.options.byteBudget,
        (admittedBytes) => this.memory.admit(admittedBytes, -Infinity),
      ),
      maxConcurrentDerivatives: 2,
      loadDerivative: async (derivative, signal) => {
        const loader = getGLTFLoader(this.renderer, this.options.ktx2TranscoderPath, this.downloadTracker, this.textureLoadAbort.signal, this.effectiveTextureMaxDimension, this.options.resolveAssetUrls, this.textureSources);
        const derivativeUrl = resolveUrl(this.assetBase, derivative.file);
        const buffer = await this.fetchBuffer(derivativeUrl, signal, derivative.bytes);
        const gltf = await parseMapGLTF(loader, buffer, resourceDirectory(derivativeUrl));
        const root = gltf.scene;
        this.prepareTree(root);
        const resources = collectResources(root);
        return {
          root,
          bytes: estimateResourceBytes(resources) || derivative.bytes,
          dispose: () => disposeResources(resources),
        };
      },
    });
    this.weather = new WeatherController(
      this.scene,
      this.camera,
      this.renderer,
      (positions) => positions.map((position) => this.manifest
        ? (this.cameraGroundIndex?.sample(position.x, position.z) ?? this.localGroundY)
        : null),
    );
    this.controls = new CameraRig(this.camera, canvas);
    this.controls.setPoseConstraint((camera, target) => this.constrainCameraPose(camera, target));

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();

    this.lastFrameTime = performance.now();
    this.rafHandle = requestAnimationFrame(this.tick);
  }

  private aspect(): number {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    return w / h;
  }

  /** Stable viewpoint API for editors; callers never retain mutable Three.js vectors. */
  captureView(): CameraView {
    return this.controls.getView();
  }

  applyView(view: CameraView): void {
    this.controls.applyView(view);
  }

  private resize(): void {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.options.maxPixelRatio));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ---------------------------------------------------------------- loading

  loadMap(manifestUrl: string): Promise<void> {
    try { requireMapReference(manifestUrl); } catch (error) { return Promise.reject(error); }
    const load = this.mapLoadQueue.catch(() => undefined).then(async () => {
      if (this.disposed) return;
      this.mapAdmitted = false;
      this.assetVariantReloadGeneration++;
      this.textureBudgetRecovery = null;
      if (this.mapLoaded) this.releaseMapResources();
      this.mapLoaded = true;
      this.textureLoadAbort.abort();
      disposeTrackedLoader(this.downloadTracker);
      this.textureLoadAbort = new AbortController();
      this.effectiveTextureMaxDimension = this.options.textureMaxDimension;
      this.pendingTextureBudgetError = null;
      this.downloadTracker.reset();
      this.streamingError = null;
      this.lastLoadError = null;
      this.streamingErrorOrigin = null;
      this.residencyDeadline = null;
      this.terminalError = null;
      this.inputError = null;
      this.detailFailures = 0;
      this.detailError = null;
      this.mapLoadActive = true;
      try {
        await this.loadMapInner(manifestUrl);
      } catch (err) {
        // dispose() aborts every in-flight request; that is not a failure.
        if (this.disposed || (err as { name?: string } | null)?.name === 'AbortError') return;
        const error = err instanceof ViewerInputError || err instanceof ResidencyTimeoutError || err instanceof RequiredAssetBudgetError ? err
          : new Error(`Map bootstrap downloading/decoding failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
        this.recordStreamingError(error);
        throw error;
      } finally {
        this.mapLoadActive = false;
      }
    });
    this.mapLoadQueue = load;
    return load;
  }

  getCapabilities(): readonly string[] {
    return this.capabilities;
  }

  /** Scene metadata already parsed by loadMap; consumers must not refetch it. */
  getMapManifest(): Readonly<CityManifest> | null {
    return this.manifest;
  }

  /** Applied base defaults plus current physical lighting; never infers quality from pixel brightness. */
  getRenderConfiguration() {
    return {
      defaulted: this.defaulted,
      sunIntensity: this.sun?.intensity ?? this.options.sunIntensity,
      sunColor: this.sun?.color.getHex() ?? null,
      environmentIntensity: this.scene.environmentIntensity,
      exposure: this.renderer.toneMappingExposure,
      mapTextureTier: this.options.mapTextureTier,
      skyEnabled: this.sky.mesh.visible,
      environmentAvailable: this.scene.environment !== null,
      mapAdmitted: this.mapAdmitted,
      warnings: this.cinematicLighting ? [] : [{
        code: 'cinematic_lighting_disabled' as const,
        field: 'cinematicLighting',
        reason: 'Explicit opt-out disables generated sky and image-based lighting',
      }],
    };
  }

  /**
   * Whether the sun is currently casting a real shadow map.
   *
   * Hosts that paint their own stand-in contact shadows use this to switch
   * them off, so an actor never carries both.
   */
  castsRealtimeShadows(): boolean {
    return this.realtimeShadows && this.sun?.castShadow === true;
  }

  private async loadMapInner(manifestUrl: string): Promise<void> {
    const url = this.options.baseUrl ? resolveUrl(this.options.baseUrl, manifestUrl) : manifestUrl;
    this.assetBase = url.replace(/[^/]*$/, '');
    const manifestBuffer = await this.fetchBuffer(url, this.abort.signal);
    let manifest: CityManifest;
    try { manifest = JSON.parse(new TextDecoder().decode(manifestBuffer)) as CityManifest; }
    catch { throw new ViewerInputError('map.manifest', 'expected a nonblank JSON manifest'); }
    requireRenderableManifest(manifest);
    this.sourceManifestSha256 = await sha256BytesAsync(manifestBuffer);
    if (this.disposed) return;
    this.manifest = manifest;
    const [staticSemantics, variantManifest] = await Promise.all([
      this.loadStaticSemantics(manifest),
      this.loadVariantManifest(),
    ]);
    this.staticSemantics = staticSemantics;
    this.variantManifest = variantManifest;
    this.capabilities = staticSemanticsCapabilities(this.staticSemantics);
    if (this.disposed) return;

    this.sceneBox = boundsToBox3(manifest.scene.bounds);
    const center = this.sceneBox.getCenter(new Vector3());
    const size = this.sceneBox.getSize(new Vector3());
    this.frameCamera(initialEditorFocus(center, manifest.tiles), size);
    await this.configureTextureTier();

    const sunDir = manifest.shadowLightmap?.sunDirection ?? [-0.5, -0.6, -0.6];
    const sunTravel = new Vector3(sunDir[0] ?? -0.5, sunDir[1] ?? -0.6, sunDir[2] ?? -0.6);
    this.sun = createSun({
      direction: sunTravel,
      intensity: this.options.sunIntensity,
      target: center,
    });
    this.sky.setSunTravelDirection(sunTravel);
    this.scene.add(this.sun, this.sun.target);
    this.shadowRadius = shadowRadiusForScene(this.sceneBox, this.options.shadowRadiusM);
    this.configureSunShadow();

    this.atlas = new ShadowAtlas(manifest, this.options.shadowAtlasCellSize, this.textureCapabilities.maxTextureSize);
    this.snowCover.setShadowOptions(this.shadowOptions(this.sceneBox, 20, 40));

    const visualResourcesPromise = this.ensureVisualResources();
    if (this.sun) this.sun.visible = true;
    // A zero vegetation distance is the preset-level contract for Balanced. Do
    // not download every instance sidecar merely to hide the resulting layer
    // after the React settings effect runs.
    const vegetationPromise = this.options.vegetationMaxDistance <= 0 || !this.options.vegetation
      ? Promise.resolve()
      : this.loadVegetationInstances(manifest);

    this.createRoadLayer(manifest);
    this.createCityLayer(manifest);
    if (this.disposed) return;
    if (this.options.vegetation && this.options.vegetationMaxDistance > 0) {
      void vegetationPromise.then(() => {
        if (!this.disposed && !this.vegLayer) {
          this.createVegetationLayer(manifest);
          this.lastStreamUpdate = 0;
        }
      });
    }

    void visualResourcesPromise.catch((error: unknown) => {
      if (!this.disposed) this.recordStreamingError(error);
    });
    this.refreshWeatherAppearance();
    this.mapAdmitted = true;
    // "Loaded" has to mean "on screen". Until this waited, `loadMap` resolved
    // as soon as the layers existed, so every consumer announced a ready scene
    // with nothing in it and the buildings appeared seconds later.
    await this.whenViewResident();
    if (this.streamingError) throw this.terminalError ?? this.inputError ?? new Error(this.streamingError);
  }

  /**
   * Resolves once the road and every in-view city tile are displayed.
   *
   * The frame loop drives streaming. A soft deadline remains observable while
   * required assets continue preparing, and late residency resolves normally.
   * Real errors, teardown, suspension, or the hard stall bound settle the wait.
   */
  private whenViewResident(): Promise<void> {
    if (this.viewResidentNow()) return Promise.resolve();
    // The viewer package targets a library without `Promise.withResolvers`.
    let settle: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => { settle = resolve; });
    this.viewResidentWaiters.push({
      resolve: settle,
      deadline: performance.now() + VIEW_RESIDENT_TIMEOUT_MS,
      terminalDeadline: performance.now() + VIEW_RESIDENT_HARD_TIMEOUT_MS,
      progress: this.residencyProgress(performance.now()),
    });
    return promise;
  }

  private residencyProgress(now: number): number {
    const downloads = this.downloadTracker.snapshot(now, false);
    let progress = downloads.transferredBytes + downloads.cachedBytes + this.downloadTracker.decodedAssets;
    for (const layer of [this.roadLayer, this.cityLayer]) {
      const stats = layer?.stats();
      if (stats) progress += stats.decodedAssets + stats.uploadedTextures + stats.compiledAssets;
    }
    return progress;
  }

  private viewResidentNow(): boolean {
    if (this.disposed || (this.streamingError !== null && this.streamingErrorOrigin !== 'deadline') || this.renderingSuspended) return true;
    if (!this.mapAdmitted) return false;
    if (this.roadLayer && (!this.roadLayer.ready || this.roadLayer.stats().requiredPendingAssets > 0)) return false;
    const city = this.cityLayer;
    if (!city) return true;
    return city.ready && city.missingInView === 0 && city.stats().requiredPendingAssets === 0;
  }

  /** Called from the frame loop, after streaming has had its turn. */
  private settleViewResidentWaiters(now: number): void {
    if (this.viewResidentWaiters.length === 0) return;
    const resident = this.viewResidentNow();
    const progress = this.residencyProgress(now);
    if (resident && this.streamingErrorOrigin === 'deadline' && !this.disposed && !this.renderingSuspended) {
      this.streamingError = null;
      this.streamingErrorOrigin = null;
      if (this.residencyDeadline) this.residencyDeadline.recoveredAtMs = now;
    }
    for (let i = this.viewResidentWaiters.length - 1; i >= 0; i--) {
      const waiter = this.viewResidentWaiters[i];
      if (!waiter) continue;
      if (progress > waiter.progress) {
        waiter.progress = progress;
        waiter.terminalDeadline = now + VIEW_RESIDENT_HARD_TIMEOUT_MS;
      }
      if (!resident) {
        if (now >= waiter.terminalDeadline) {
          const stats = this.getStats();
          this.recordStreamingError(new ResidencyTimeoutError({
            requiredPendingAssets: stats.requiredPendingAssets ?? 0,
            missingInViewTiles: (stats.coverage.city?.missingInViewTiles ?? 0) + (stats.coverage.roads?.missingInViewTiles ?? 0),
            residentBytes: stats.residentBytes, pendingBytes: stats.pendingBytes, byteBudget: stats.byteBudget,
          }));
        } else {
          if (now >= waiter.deadline && this.streamingErrorOrigin === null) {
            this.streamingError = 'Required geometry and selected texture tier did not become resident before the readiness deadline';
            this.streamingErrorOrigin = 'deadline';
            this.residencyDeadline = { missedAtMs: now, recoveredAtMs: null };
          }
          continue;
        }
      }
      this.viewResidentWaiters.splice(i, 1);
      waiter.resolve();
    }
  }

  private ensureVisualResources(): Promise<void> {
    if (this.visualResourcesPromise) return this.visualResourcesPromise;
    const manifest = this.manifest;
    const atlas = this.atlas;
    if (!manifest || !atlas) return Promise.resolve();
    this.visualResourcesStarted = true;
    this.refreshSkyEnvironment();
    this.visualResourcesPromise = atlas
      .load(manifest, this.assetBase, this.abort.signal, this.downloadTracker)
      .then(() => undefined);
    return this.visualResourcesPromise;
  }

  /**
   * Installs the sky's image-based light.
   *
   * The environment is convolved from the dome itself, so a map that ships no
   * HDRI is still lit by its own sky, and moving the sun moves the ambient
   * light with it. Rebuilds are gated inside `SkyDome`.
   */
  private refreshSkyEnvironment(): void {
    if (!this.cinematicLighting) return;
    this.scene.environment = this.sky.environmentTexture(this.renderer);
    this.environmentFromSky = true;
  }

  /**
   * Points the shadow-casting sun at the camera's neighbourhood.
   *
   * A map fitted to the whole footprint would spend all its texels on ground
   * the camera cannot resolve, so the frustum tracks the view and is re-baked
   * when it drifts. Below civil twilight the sun contributes nothing, so the
   * pass is skipped outright rather than baking an all-lit map.
   */
  private configureSunShadow(): void {
    const sun = this.sun;
    if (!sun) return;
    const lit = sunElevationFalloff(this.sky.sunElevationDeg()) > 0;
    sun.castShadow = this.realtimeShadows && lit;
    if (!sun.castShadow) {
      setBakedSuppression({ x: 0, z: 0 }, BAKED_SUPPRESSION_OFF.start, BAKED_SUPPRESSION_OFF.end);
      this.shadowBake = null;
      return;
    }
    const size = this.options.shadowMapSize;
    sun.shadow.mapSize.set(size, size);
    // Tuned against the 0.15 m/texel curb geometry in the road layer: enough
    // to kill acne on near-tangent surfaces without detaching contact shadows.
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    // The sun is static while the camera is not, so the map is re-baked on
    // demand instead of every frame.
    sun.shadow.autoUpdate = false;
    sun.shadow.needsUpdate = true;
    this.updateSunShadowFocus(true);
  }

  /**
   * Re-fits and re-bakes the shadow map when the camera has left the region the
   * current bake covers.
   */
  private updateSunShadowFocus(force = false): void {
    const sun = this.sun;
    if (!sun?.castShadow) return;
    const focus = this.shadowFocusPoint();
    const live = { focus, radius: this.shadowRadius, sun: this.sky.sunDirection() };
    if (!force && !shadowBakeIsStale(this.shadowBake, live)) return;

    const travel = this.sky.sunDirection().negate();
    const span = Math.max(40, this.sceneBox.max.y - this.sceneBox.min.y);
    applySunShadowFit(sun, fitSunShadow(focus, travel, this.shadowRadius, span));
    sun.shadow.needsUpdate = true;
    this.shadowBake = { focus: focus.clone(), radius: this.shadowRadius, sun: live.sun.clone() };

    const radii = bakedSuppressionRadii(this.shadowRadius);
    setBakedSuppression({ x: focus.x, z: focus.z }, radii.start, radii.end);
  }

  /** Ground point the shadow frustum is centred on. */
  private shadowFocusPoint(): Vector3 {
    this.camera.getWorldPosition(_cameraPos);
    const groundY = this.cameraGroundIndex?.sample(_cameraPos.x, _cameraPos.z) ?? this.localGroundY;
    // Biased along the view so the covered region sits in front of the camera
    // rather than half behind it.
    const [targetX, , targetZ] = this.controls.getView().target;
    return new Vector3(
      (_cameraPos.x + targetX) * 0.5,
      Number.isFinite(groundY) ? groundY : 0,
      (_cameraPos.z + targetZ) * 0.5,
    );
  }

  /** Neighborhood framing close enough to read houses, roads and actors. */
  private frameCamera(center: Vector3, size: Vector3): void {
    this.updateLocalCameraEnvelope(center.x, center.z);
    const pose = initialEditorCameraPose(
      center,
      size,
      this.localGroundY,
      this.localBuildingMax,
      this.localMaxAltitude || center.y + 45,
    );
    this.controls.minDistance = 3;
    this.controls.maxDistance = pose.maxDistance;
    this.controls.setView(pose.position, pose.target);
  }

  private updateLocalCameraEnvelope(x: number, z: number): void {
    const cached = this.localEnvelopeBounds;
    if (!cached || x < cached.min.x || x > cached.max.x || z < cached.min.z || z > cached.max.z) {
      const tile = this.manifest?.tiles.find((candidate) => {
        const bounds = candidate.bounds;
        return x >= (bounds.min[0] ?? -Infinity) && x <= (bounds.max[0] ?? Infinity)
          && z >= (bounds.min[2] ?? -Infinity) && z <= (bounds.max[2] ?? Infinity);
      });
      this.localEnvelopeBounds = tile ? boundsToBox3(tile.bounds) : this.sceneBox.clone();
    }
    this.localGroundY = this.cameraGroundIndex?.sample(x, z) ?? this.localEnvelopeBounds?.min.y ?? this.sceneBox.min.y;
    this.localBuildingMax = Math.max(this.localGroundY, this.localEnvelopeBounds?.max.y ?? this.sceneBox.max.y);
    const localHeight = Math.max(0, this.localBuildingMax - this.localGroundY);
    this.localHeadroom = Math.max(6, Math.min(20, localHeight * 0.15));
    this.localMaxAltitude = Math.max(this.localGroundY + 12, this.localBuildingMax + this.localHeadroom);
  }

  private constrainCameraPose(camera: PerspectiveCamera, target: Vector3): void {
    if (!this.cameraPoseConstraintsEnabled) return;
    if (!this.manifest || this.sceneBox.isEmpty()) return;
    // First bring an arbitrary/imported target into the global footprint. This
    // must happen before selecting its local tile envelope; otherwise an
    // out-of-bounds target would cache the whole-city height range forever.
    const coarseFlags = constrainCameraToEnvelope(
      camera,
      target,
      cameraEnvelopeFromBounds(
        this.sceneBox,
        this.options.cameraBoundsInset,
        -Number.MAX_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER,
      ),
    );
    this.updateLocalCameraEnvelope(target.x, target.z);
    const localFlags = constrainCameraToEnvelope(
      camera,
      target,
      cameraEnvelopeFromBounds(
        this.sceneBox,
        this.options.cameraBoundsInset,
        this.localGroundY,
        this.localMaxAltitude,
      ),
    );
    for (const key of Object.keys(this.cameraClampFlags) as (keyof typeof this.cameraClampFlags)[]) {
      this.cameraClampFlags[key] = coarseFlags[key] || localFlags[key];
    }
  }

  private cameraPoseConstraintsEnabled = true;

  /** Sensor rigs may temporarily own the exact physical eye pose below editor navigation limits. */
  setCameraPoseConstraintsEnabled(enabled: boolean): void {
    this.cameraPoseConstraintsEnabled = enabled;
    if (!enabled) {
      for (const key of Object.keys(this.cameraClampFlags) as (keyof typeof this.cameraClampFlags)[]) {
        this.cameraClampFlags[key] = false;
      }
    }
  }

  resetCamera(): void {
    if (!this.manifest || this.sceneBox.isEmpty()) return;
    this.frameCamera(initialEditorFocus(this.sceneBox.getCenter(new Vector3()), this.manifest.tiles), this.sceneBox.getSize(new Vector3()));
  }

  /** Frame a neighborhood and leave a persistent ground marker at its center. */
  focusOnLocation(position: ViewerPoint3, radius = 20): void {
    const center = new Vector3(position.x, position.y, position.z);
    const diameter = Math.max(4, radius * 2);
    this.frameCamera(center, new Vector3(diameter, diameter * 0.5, diameter));
    this.setOverlays({
      markers: [{ id: 'location-focus', position, color: '#f97316' }],
    });
  }

  /** Replace all transient editor/search overlays in one atomic scene update. */
  setOverlays(state: ViewerOverlayState): void {
    this.overlays.set(state);
  }

  clearOverlays(): void {
    this.overlays.clear();
  }

  getCameraDiagnostics(): CameraDiagnostics {
    const ready = Boolean(this.manifest) && !this.sceneBox.isEmpty();
    const position: [number, number, number] = [this.camera.position.x, this.camera.position.y, this.camera.position.z];
    const target: [number, number, number] = [this.controls.target.x, this.controls.target.y, this.controls.target.z];
    const viewDistance = this.camera.position.distanceTo(this.controls.target);
    if (!ready) {
      return { ready: false, position, target, groundY: null, altitudeAgl: null, minAltitude: null, maxAltitude: null,
        viewDistance, fov: this.camera.fov, bounds: null, localBuildingMax: null, headroom: null,
        clamps: { ...this.cameraClampFlags } };
    }
    this.updateLocalCameraEnvelope(this.controls.target.x, this.controls.target.z);
    return {
      ready: true, position, target,
      groundY: this.localGroundY,
      altitudeAgl: this.camera.position.y - this.localGroundY,
      minAltitude: this.localGroundY + 2,
      maxAltitude: this.localMaxAltitude,
      viewDistance,
      fov: this.camera.fov,
      bounds: { minX: this.sceneBox.min.x, maxX: this.sceneBox.max.x, minZ: this.sceneBox.min.z,
        maxZ: this.sceneBox.max.z, width: this.sceneBox.max.x - this.sceneBox.min.x,
        height: this.sceneBox.max.z - this.sceneBox.min.z },
      localBuildingMax: this.localBuildingMax,
      headroom: this.localHeadroom,
      clamps: { ...this.cameraClampFlags },
    };
  }

  private shadowOptions(box: Box3, fadeFrom: number, fadeTo: number): ShadowPatchOptions {
    const atlas = this.atlas;
    if (!atlas) throw new Error('shadow atlas not ready');
    return {
      atlas: atlas.texture,
      rect: atlas.rect,
      strength: this.options.shadowStrength,
      wallWeight: 0.5,
      debug: this.options.debugShadowProjection,
      fadeStartY: box.min.y + fadeFrom,
      fadeEndY: box.min.y + fadeTo,
      maskOnlyAlbedo: true,
    };
  }

  private async fetchBuffer(
    url: string,
    signal: AbortSignal,
    expectedBytes?: number | null,
  ): Promise<ArrayBuffer> {
    const sessionId = this.downloadTracker.sessionId;
    const resolved = this.options.resolveMapAssetUrls
      ? (await this.options.resolveMapAssetUrls([url], signal)).get(url) ?? url
      : url;
    const res = await fetch(resolved, { signal });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return readResponseBufferWithProgress(res, this.downloadTracker, expectedBytes, sessionId);
  }

  private async fetchAssetResponse(url: string, signal: AbortSignal): Promise<Response> {
    const resolved = this.options.resolveMapAssetUrls
      ? (await this.options.resolveMapAssetUrls([url], signal)).get(url) ?? url
      : url;
    return fetch(resolved, { signal });
  }

  private async readJsonResponse(response: Response): Promise<unknown> {
    const decoded = this.downloadTracker.trackDecode();
    const buffer = await readResponseBufferWithProgress(response, this.downloadTracker);
    const value: unknown = JSON.parse(new TextDecoder().decode(buffer));
    decoded();
    return value;
  }

  private async loadVariantManifest(): Promise<CityAssetVariantManifest | null> {
    const relative = this.options.variantManifestUrl || 'variants/manifest.json';
    try {
      const response = await this.fetchAssetResponse(resolveUrl(this.assetBase, relative), this.abort.signal);
      if (!response.ok) return null;
      const value = await this.readJsonResponse(response);
      return isCityAssetVariantManifest(value) ? value : null;
    } catch (error) {
      if ((error as { name?: string } | null)?.name === 'AbortError') throw error;
      return null;
    }
  }

  private async loadStaticSemantics(manifest: CityManifest): Promise<StaticSemantics | null> {
    const reference = manifest.staticSemantics;
    if (!reference) return null;
    try {
      if (typeof reference.file !== 'string' || reference.file.length === 0) {
        throw new Error('Static semantics manifest reference requires a non-empty file');
      }
      const response = await this.fetchAssetResponse(resolveUrl(this.assetBase, reference.file), this.abort.signal);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return parseStaticSemantics(await this.readJsonResponse(response));
    } catch (error) {
      if ((error as { name?: string } | null)?.name === 'AbortError') throw error;
      console.warn('[CityViewer] Static semantics unavailable:', error);
      return null;
    }
  }

  private async configureTextureTier(forceLowReason?: string): Promise<void> {
    const capabilities = probeTextureCapabilities(this.renderer.getContext());
    capabilities.maxTextureSize = Math.min(capabilities.maxTextureSize, this.options.textureMaxDimension);
    let selection = selectTextureTier(this.options.mapTextureTier, capabilities);
    if (forceLowReason) {
      selection = { ...selectTextureTier('low', capabilities), requested: this.options.mapTextureTier, downgradeReason: forceLowReason };
    }
    for (;;) {
      let id = selection.variantId as TextureVariantId;
      let reference = this.variantManifest?.variants[id];
      if (!reference && selection.actual === 'medium' && selection.codec !== 'uastc') {
        id = 'textures-512-uastc';
        selection = { ...selection, codec: 'uastc', variantId: id, downgradeReason: `Published ${selection.codec} derivative unavailable; using portable UASTC` };
        reference = this.variantManifest?.variants[id];
      }
      if (!reference) throw new ViewerInputError(`mapTextureTier.${id}`, `expected published ${id} derivative; publish texture-tiers before loading this map`);
      if (this.variantManifest?.sourceManifestSha256 !== this.sourceManifestSha256
        || reference.sourceManifestSha256 !== this.sourceManifestSha256 || reference.schemaVersion !== 1
        || !/^[a-z0-9-]+\.json$/.test(reference.file)) throw new Error('Texture derivative is not bound to this source manifest');
      const bytes = await this.fetchBuffer(resolveUrl(this.assetBase, `variants/${reference.file}`), this.abort.signal, reference.bytes);
      const digest = await sha256BytesAsync(bytes);
      if (digest !== reference.outputSha256 || reference.digest !== `sha256-${digest}`) throw new Error(`Texture index digest mismatch: ${id}`);
      const index = JSON.parse(new TextDecoder().decode(bytes)) as TextureTierIndex;
      if (index.schemaVersion !== 1 || index.id !== id || index.codec !== selection.codec
        || index.longestEdgePx !== selection.longestEdgePx || index.sourceManifestSha256 !== this.sourceManifestSha256
        || !index.images || !index.assets) throw new Error(`Invalid texture index: ${id}`);
      const sources = new Map<string, MapTextureSource>();
      for (const [source, image] of Object.entries(index.images)) {
        if (!/^\.\.\/images\/[^/]+\.ktx2$/.test(source)
          || !/^variants\/objects\/[a-f0-9]{64}\.ktx2$/.test(image.file)
          || !/^[a-f0-9]{64}$/.test(image.outputSha256)
          || !Number.isFinite(image.residentBytes) || image.residentBytes < 0
          || !(image.width > 0 && image.height > 0) || Math.max(image.width, image.height) > index.longestEdgePx
          || image.width > image.sourceWidth || image.height > image.sourceHeight
          || ![selection.codec, 'rgba'].includes(image.codec)) throw new Error(`Invalid texture index image: ${source}`);
        sources.set(new URL(source, new URL(this.assetBase, document.baseURI)).href, {
          url: new URL(image.file, new URL(this.assetBase, document.baseURI)).href, digest: image.outputSha256, codec: image.codec,
          authoredWidth: image.sourceWidth, authoredHeight: image.sourceHeight,
        });
      }
      // Demand is the union of images used by the actual readiness footprint,
      // not an equal slice of budget for every tile anywhere in the map.
      this.updateCityFrustum();
      const requiredImages = new Set<string>();
      const add = (file: string): void => {
        const asset = index.assets[file];
        if (!asset) throw new ViewerInputError(`mapTextureTier.${id}.${file}`, 'texture index omits required asset');
        for (const source of asset.images) {
          if (!index.images[source]) throw new ViewerInputError(`mapTextureTier.${id}.${source}`, 'texture index omits required image');
          requiredImages.add(source);
        }
      };
      for (const layer of this.manifest?.staticLayers ?? []) if (layer.file.endsWith('.glb')) add(layer.file);
      for (const tile of this.manifest?.tiles ?? []) {
        const box = boxOf(tile.bounds.min, tile.bounds.max);
        const distance = box.distanceToPoint(this.camera.position);
        if (distance <= READY_RADIUS_M || (distance <= READY_DISTANCE_M && this.cityFrustum.intersectsBox(box))) {
          for (const lod of tile.lods) add(lod.file);
        }
      }
      const gl = this.renderer.getContext();
      const rgbaOnly = selection.codec === 'uastc' && !capabilities.bc7 && !capabilities.astc
        && !gl.getExtension('WEBGL_compressed_texture_s3tc') && !gl.getExtension('WEBGL_compressed_texture_etc');
      let requiredBytes = 0;
      for (const source of requiredImages) {
        const image = index.images[source]!;
        const needsRgba = rgbaOnly && image.width % 4 === 0 && image.height % 4 === 0;
        requiredBytes += image.residentBytes * (needsRgba ? 4 : 1);
      }
      if (requiredBytes > this.options.byteBudget * 0.5) {
        if (selection.actual === 'low') throw new Error(`Low texture working set (${requiredBytes} bytes) exceeds the resident texture budget`);
        selection = { ...selectTextureTier('low', capabilities), requested: this.options.mapTextureTier,
          downgradeReason: `Visible unique-image demand (${requiredBytes} bytes) exceeds the Medium texture budget (${this.options.byteBudget * 0.5} bytes)` };
        continue;
      }
      this.tierSelection = selection;
      this.textureTierIndex = index;
      this.textureSources = sources;
      this.effectiveTextureMaxDimension = selection.longestEdgePx ?? Infinity;
      return;
    }
  }

  /** Switch representations without changing the editor camera or geometry. */
  async setMapTextureTier(tier: MapTextureTier): Promise<void> {
    requireTextureTier(tier);
    if (tier === this.options.mapTextureTier) return;
    this.options.mapTextureTier = tier;
    await this.mapLoadQueue;
    if (!this.manifest || this.disposed) return;
    await this.runPresetTransition(async () => {
      await this.configureTextureTier();
      await this.reloadAssetVariant();
    });
    await this.whenViewResident();
  }

  /** Tier image bindings are immutable; failed texture tiers never fall back to full downloads. */
  private async parseAsset(sourceFile: string, signal: AbortSignal, sourceBytes?: number | null) {
    const declaredKtxPath = this.variantManifest?.variants.ktx2?.runtime?.ktx2TranscoderPath ?? '';
    const ktx2TranscoderPath = this.options.ktx2TranscoderPath
      || (declaredKtxPath ? resolveUrl(this.assetBase, declaredKtxPath) : '');
    const preference = this.options.assetVariant === 'geometry-only' ? 'geometry-only' : this.tierSelection.variantId as TextureVariantId;
    const selected = selectAssetVariant(this.variantManifest, sourceFile, preference, {
      ktx2Ready: true,
    });
    const selectedBytes = selected.variant === 'original'
      ? sourceBytes
      : (this.variantManifest?.variants[selected.variant] as CityAssetVariant | undefined)?.files?.[sourceFile]?.bytes ?? sourceBytes;
    const loader = getGLTFLoader(this.renderer, ktx2TranscoderPath, this.downloadTracker, this.textureLoadAbort.signal, this.effectiveTextureMaxDimension, this.options.resolveAssetUrls, this.textureSources);
    try {
      const selectedUrl = resolveUrl(this.assetBase, selected.file);
      const buffer = await this.fetchBuffer(selectedUrl, signal, selectedBytes);
      const parsed = await parseMapGLTF(loader, buffer, resourceDirectory(selectedUrl));
      requireRenderableGeometry(parsed.scene, sourceFile);
      this.variantLoads[selected.variant]++;
      this.canvas.dataset.assetVariant = selected.variant;
      return parsed;
    } catch (error) {
      if (error instanceof ViewerInputError || !allowsSourceAssetFallback(selected.variant)
        || (error as { name?: string } | null)?.name === 'AbortError') throw error;
      this.variantFallbacks++;
      const sourceUrl = resolveUrl(this.assetBase, sourceFile);
      const source = await this.fetchBuffer(sourceUrl, signal, sourceBytes);
      const parsed = await parseMapGLTF(loader, source, resourceDirectory(sourceUrl));
      requireRenderableGeometry(parsed.scene, sourceFile);
      this.variantLoads.original++;
      this.canvas.dataset.assetVariant = 'original-fallback';
      return parsed;
    }
  }

  /** Parse a manifest-resolved derivative without running variant selection twice. */
  private async parseResolvedAsset(
    file: string,
    signal: AbortSignal,
    variant: 'geometry-only' | 'ktx2',
    expectedBytes?: number | null,
  ) {
    const declaredKtxPath = this.variantManifest?.variants.ktx2?.runtime?.ktx2TranscoderPath ?? '';
    const ktx2TranscoderPath = this.options.ktx2TranscoderPath
      || (declaredKtxPath ? resolveUrl(this.assetBase, declaredKtxPath) : '');
    const loader = getGLTFLoader(this.renderer, ktx2TranscoderPath, this.downloadTracker, this.textureLoadAbort.signal, this.effectiveTextureMaxDimension, this.options.resolveAssetUrls, this.textureSources);
    const fileUrl = resolveUrl(this.assetBase, file);
    const buffer = await this.fetchBuffer(fileUrl, signal, expectedBytes);
    const parsed = await parseMapGLTF(loader, buffer, resourceDirectory(fileUrl));
    requireRenderableGeometry(parsed.scene, file);
    this.variantLoads[variant]++;
    this.canvas.dataset.assetVariant = variant;
    return parsed;
  }

  /**
   * Shared per-asset preparation: static matrices, bounds, anisotropy, and
   * shadow participation.
   *
   * Streamed world geometry both casts and receives: a building has to throw a
   * shadow across the street it stands on. The flags are set unconditionally
   * rather than behind `realtimeShadows`, because the option can be toggled
   * after tiles are already resident and three ignores them when the shadow map
   * is off.
   */
  private prepareTree(root: Object3D): void {
    const maxAnisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    root.matrixAutoUpdate = false;
    root.traverse((obj) => {
      obj.matrixAutoUpdate = false;
      const mesh = obj as Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      // EXT_mesh_gpu_instancing batches: frustum culling must cover every
      // instance, not the prototype's own bounds.
      const instanced = mesh as unknown as InstancedMesh & { isInstancedMesh?: boolean };
      if (instanced.isInstancedMesh) {
        instanced.computeBoundingSphere();
        instanced.computeBoundingBox();
      }
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of mats) {
        const albedo = (mat as Material & { map?: Texture | null }).map;
        if (albedo?.isTexture) registerAlbedoTexture(albedo);
        for (const value of Object.values(mat as unknown as Record<string, unknown>)) {
          const tex = value as Texture | null;
          if (tex && (tex as unknown as { isTexture?: boolean }).isTexture) {
            tex.anisotropy = maxAnisotropy;
          }
        }
      }
    });
    root.updateMatrixWorld(true);
  }

  private createRoadLayer(manifest: CityManifest): void {
    const road = manifest.staticLayers?.find((layer) => layer.id === 'road');
    if (!road) return;
    const geometryBootstrap = selectAssetVariant(this.variantManifest, road.file, 'geometry-only', {
      ktx2Ready: false,
    });
    const geometryVariantFile = geometryBootstrap?.variant === 'geometry-only'
      ? this.variantManifest?.variants['geometry-only']?.files[road.file]
      : undefined;
    const progressiveRoad = geometryBootstrap?.variant === 'geometry-only' && geometryVariantFile
      ? [{
          // A texture-free, geometry-identical road is the usable bootstrap.
          // Its deliberately huge error makes the source road the desired
          // refinement as soon as the bootstrap is visible.
          level: -1,
          file: geometryBootstrap.file,
          triangles: road.triangles,
          fileSize: geometryVariantFile.bytes,
          geometricError: Number.MAX_SAFE_INTEGER,
        }, {
          level: 0,
          file: road.file,
          triangles: road.triangles,
          fileSize: road.fileSize,
          geometricError: 0,
        }]
      : [{
          level: 0,
          file: road.file,
          triangles: road.triangles,
          fileSize: road.fileSize,
          geometricError: 0,
        }];
    const def: StreamTileDef = {
      id: 'road',
      box: this.sceneBox.clone(),
      lods: progressiveRoad,
    };
    this.roadLayer = new TileStreamLayer({
      name: 'road-layer',
      renderer: this.renderer,
      scene: this.scene,
      onError: (error) => this.recordStreamingError(error),
      defs: [def],
      maxConcurrent: 1,
      memory: this.memory,
      pinCoarsest: true,
      essentialCoarsest: true,
      essentialAll: true,
      maxDesiredIndex: () => progressiveRoad.length - 1,
      build: async (tileDef, lod, signal) => {
        const gltf = lod.level === -1
          ? await this.parseResolvedAsset(lod.file, signal, 'geometry-only', lod.fileSize)
          : await this.parseAsset(road.file, signal, road.fileSize);
        const root = gltf.scene;
        applyStaticSemantics(root, this.staticSemantics);
        root.name = tileDef.id;
        this.prepareTree(root);
        const box = new Box3().setFromObject(root);
        // The road is the ground: it takes the shadow term everywhere, and only
        // the electric towers reaching above ~20 m fade out of it.
        if (this.visualResourcesStarted) patchTree(root, this.shadowOptions(box, 20, 40));
        this.surfaceMaterials.registerTree(root, 'road');
        // Street-light props ship in the road static layer on Datasmith-derived
        // maps, so practical-light discovery must see these trees too.
        this.luminaires.registerTree(root);
        const resources = collectResources(root);
        this.snowCover.registerTree(
          root,
          'road',
          resolveSnowCoverVariant(this.variantManifest, road.file),
          'road',
        );
        return {
          object: root,
          resources,
          bytes: estimateResourceBytes(resources),
          pendingTextures: [...resources.textures],
          dispose: () => {
            this.snowCover.unregisterTree(root);
            this.surfaceMaterials.unregisterTree(root);
            this.luminaires.unregisterTree(root);
          },
        } satisfies PreparedAsset;
      },
    });
    this.roadGroup.add(this.roadLayer.group);
  }

  private createCityLayer(manifest: CityManifest): void {
    this.updateCityFrustum();
    const defs: StreamTileDef[] = manifest.tiles.map((tile) => ({
      id: tile.id,
      box: boxOf(tile.bounds.min, tile.bounds.max),
      lods: normalizeLods(tile.lods),
    }));
    // One dilated copy per tile, built once: testing the frustum against a box
    // grown by the prefetch margin is how tiles become resident before they
    // are visible, and allocating it per frame would cost more than it saves.
    const prefetchBoxes = new Map<string, Box3>(
      defs.map((def) => [def.id, def.box.clone().expandByScalar(PREFETCH_MARGIN_M)]),
    );
    this.cityLayer = new TileStreamLayer({
      name: 'city-layer',
      renderer: this.renderer,
      scene: this.scene,
      // City detail: a tile that will not decode costs that tile, not the map.
      onError: (error) => this.recordDetailFailure(error),
      defs,
      maxConcurrent: this.options.maxConcurrentLoads,
      memory: this.memory,
      pinCoarsest: true,
      want: (def, distance) => distance <= PREFETCH_RADIUS_M
        || this.cityFrustum.intersectsBox(prefetchBoxes.get(def.id) ?? def.box),
      // What "ready" is judged on: what is actually on screen, plus the block
      // the viewpoint stands in.
      required: (def, distance) => distance <= READY_RADIUS_M
        || (distance <= READY_DISTANCE_M && this.cityFrustum.intersectsBox(def.box)),
      build: async (def, lod, signal) => {
        const gltf = await this.parseAsset(lod.file, signal, lod.fileSize);
        const root = gltf.scene;
        applyStaticSemantics(root, this.staticSemantics);
        root.name = `${def.id}.lod${lod.level}`;
        this.prepareTree(root);
        const box = new Box3().setFromObject(root);
        if (this.visualResourcesStarted) patchTree(root, this.shadowOptions(box, 20, 40));
        this.surfaceMaterials.registerTree(root, 'city');
        this.luminaires.registerTree(root);
        const resources = collectResources(root);
        this.snowCover.registerTree(
          root,
          'city',
          resolveSnowCoverVariant(this.variantManifest, lod.file),
          `city:${def.id}`,
        );
        return {
          object: root,
          resources,
          bytes: estimateResourceBytes(resources),
          pendingTextures: [...resources.textures],
          dispose: () => {
            this.snowCover.unregisterTree(root);
            this.surfaceMaterials.unregisterTree(root);
            this.luminaires.unregisterTree(root);
          },
        } satisfies PreparedAsset;
      },
    });
    this.cityGroup.add(this.cityLayer.group);
  }

  private async loadVegetationInstances(manifest: CityManifest): Promise<void> {
    const tiles = (manifest.vegetationTiles ?? []).values();
    await Promise.all(Array.from({ length: 4 }, async () => {
      for (const tile of tiles) {
        if (this.disposed || this.abort.signal.aborted) return;
        if (!tile.instanceFile) continue;
        try {
          const res = await this.fetchAssetResponse(resolveUrl(this.assetBase, tile.instanceFile), this.abort.signal);
          if (!res.ok) continue;
          this.vegetationData.set(tile.id, (await this.readJsonResponse(res)) as VegetationInstanceFile);
        } catch {
          /* a tile without instance data simply renders no vegetation */
        }
      }
    }));
  }

  private createVegetationLayer(manifest: CityManifest): void {
    if (this.vegLayer) return;
    const tiles = manifest.vegetationTiles ?? [];
    if (tiles.length === 0) return;
    // Two shapes of vegetation tile: prototype GLBs placed through an
    // `instances.json` sidecar (bands thin the instances by distance), and
    // web-tier cells whose GLB already carries the placed batches
    // (EXT_mesh_gpu_instancing) and needs no sidecar.
    const defs: StreamTileDef[] = tiles.map((tile) => ({
      id: tile.id,
      box: boxOf(tile.bounds.min, tile.bounds.max),
      lods: normalizeLods(tile.lods),
    }));

    this.vegLayer = new TileStreamLayer({
      name: 'vegetation-layer',
      renderer: this.renderer,
      scene: this.scene,
      // Vegetation is never required for a usable map and must remain
      // evictable under the shared byte budget.
      required: () => false,
      onError: (error) => this.recordDetailFailure(error),
      defs,
      maxConcurrent: 2,
      memory: this.memory,
      priorityBias: 1_000_000,
      pinCoarsest: false,
      // Vegetation stands down while the first view is being assembled, for
      // the same reason the upload pacer does: nothing here is promised by the
      // readiness contract, and this layer is 32 tiles / 286 MB competing with
      // the ~17 MB of road and city the view actually needs, through one
      // 2-wide decode pipe and one byte ledger.
      want: (_def, distance) => this.viewResidentWaiters.length === 0 && distance <= this.options.vegetationMaxDistance,
      build: async (def, lod, signal) => {
        const data = this.vegetationData.get(def.id);
        const gltf = await this.parseAsset(lod.file, signal, lod.fileSize);
        this.prepareTree(gltf.scene);
        const built = data ? buildVegetation(gltf.scene, data, VEG_BAND_KEEP_ROW) : { object: gltf.scene, prototypes: [] as VegPrototypeGroup[] };
        applyStaticSemantics(built.object, this.staticSemantics);
        built.object.name = `${def.id}.lod${lod.level}`;
        built.object.userData.prototypes = data ? built.prototypes : null;
        if (this.visualResourcesStarted) patchTree(built.object, this.shadowOptions(def.box, 6, 14));
        this.surfaceMaterials.registerTree(built.object, 'vegetation');
        const resources = collectResources(built.object);
        return {
          object: built.object,
          resources,
          bytes: estimateResourceBytes(resources),
          pendingTextures: [...resources.textures],
          dispose: () => {
            this.surfaceMaterials.unregisterTree(built.object);
            if (data) {
              for (const proto of built.prototypes) for (const mesh of proto.meshes) mesh.dispose();
              built.object.clear();
            } else {
              disposeResources(resources);
            }
          },
        } satisfies PreparedAsset;
      },
      onTick: (_def, asset, distance) => {
        const visible = distance <= this.options.vegetationMaxDistance;
        asset.object.visible = visible;
        const prototypes = (asset.object.userData.prototypes ?? null) as VegPrototypeGroup[] | null;
        if (!visible || !prototypes) return;
        let band = VEG_BAND_DISTANCES.length;
        for (let i = 0; i < VEG_BAND_DISTANCES.length; i++) {
          if (distance <= (VEG_BAND_DISTANCES[i] ?? 0)) {
            band = i;
            break;
          }
        }
        for (const proto of prototypes) {
          const count = proto.keepPerBand[band] ?? proto.keepPerBand[proto.keepPerBand.length - 1];
          for (const mesh of proto.meshes) mesh.count = count ?? mesh.instanceMatrix.count;
        }
      },
    });
    this.vegetationGroup.add(this.vegLayer.group);
  }

  // ------------------------------------------------------------------ frame

  private tick = (): void => {
    if (this.disposed) return;
    this.rafHandle = requestAnimationFrame(this.tick);
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastFrameTime) / 1000);
    this.lastFrameTime = now;

    if (!this.cameraGroundIndex && ++this.cameraConstraintRefresh % 60 === 0 && this.roadReady) {
      this.cameraGroundIndex = this.buildGroundIndex();
      this.localEnvelopeBounds = null;
    }

    let phaseStart = performance.now();
    if (!this.renderingSuspended && !this.benchmarkActive) this.controls.update(dt);
    this.phaseStats.controls.push(performance.now() - phaseStart);

    if (!this.renderingSuspended) {
      this.camera.updateMatrixWorld();
      this.camera.getWorldPosition(_cameraPos);
      // The dome is smaller than the map, so it rides along with the camera.
      this.sky.follow(_cameraPos);
    }

    // Streaming decisions are cheap but not free: 10 Hz is plenty responsive.
    if (!this.renderingSuspended && now - this.lastStreamUpdate > 100) {
      phaseStart = performance.now();
      this.lastStreamUpdate = now;
      this.updateStreaming(_cameraPos);
      // Shares the streaming cadence: all three answer "where are the camera
      // and the sun now", and a re-bake is far too expensive per frame.
      this.syncSunFromLight();
      this.updateSunShadowFocus();
      this.luminaires.update(this.camera);
      this.phaseStats.streaming.push(performance.now() - phaseStart);
    } else {
      this.phaseStats.streaming.push(0);
    }
    this.settleViewResidentWaiters(now);
    if (!this.renderingSuspended) this.vegLayer?.tickDisplayed();
    if (!this.renderingSuspended) this.snowCover.tick();

    // Adaptive upload backoff: a 2048px texture costs ~30 ms of GPU time on
    // this class of machine, so after a frame that already ran long we skip the
    // pacer entirely and let the pipeline drain instead of stacking stalls.
    // The counter guarantees forward progress if frames stay heavy.
    const ceiling = Math.max(14, this.frameStats.percentile(0.5) * 2);
    phaseStart = performance.now();
    // While the first view is still being assembled there is no interactive
    // frame to protect, so the adaptive backoff below does not apply either.
    const assembling = this.viewResidentWaiters.length > 0;
    if (!this.renderingSuspended && (assembling || dt * 1000 <= ceiling || this.uploadSkips >= 4)) {
      this.uploadSkips = 0;
      // Budget the upload phase, not the whole frame. Controls and streaming
      // can already have spent this budget; using `now` then starves every
      // queued asset even on the forced-progress frame after upload backoff.
      // The upload pacer exists so a 140 MB tile cannot stall an interactive
      // frame. While the first view is still being assembled there is no
      // interactive frame to protect — the viewer is showing a loading state —
      // and pacing one 2048px texture per frame is what turned a 269 MB first
      // view into a minute of waiting. Open it up until the view is resident,
      // then return to the interactive budget.
      const deadline = phaseStart
        + (assembling ? this.options.uploadBudgetMs * LOAD_UPLOAD_BUDGET_FACTOR : this.options.uploadBudgetMs);
      const pixelBudget = {
        remaining: assembling
          ? this.options.uploadPixelsPerFrame * LOAD_UPLOAD_BUDGET_FACTOR
          : this.options.uploadPixelsPerFrame,
      };
      this.roadLayer?.pumpUploads(deadline, pixelBudget, this.camera);
      this.cityLayer?.pumpUploads(deadline, pixelBudget, this.camera);
      this.vegLayer?.pumpUploads(deadline, pixelBudget, this.camera);
    } else {
      this.uploadSkips++;
    }
    this.phaseStats.uploads.push(performance.now() - phaseStart);

    if (!this.renderingSuspended && this.mapAdmitted && !this.streamingError
      && ((this.roadLayer?.group.children.length ?? 0) + (this.cityLayer?.group.children.length ?? 0) > 0)) {
      try {
        if (!this.sun || this.sun.parent !== this.scene || !this.sun.visible) {
          throw new ViewerInputError('sun', 'the admitted scene requires its visible directional light');
        }
        requirePositive(this.sun.intensity, 'sunIntensity');
        requirePositive(this.sun.position.distanceToSquared(this.sun.target.position), 'sun.direction');
        requirePositive(this.sun.color.r + this.sun.color.g + this.sun.color.b, 'sun.color');
        requirePositive(this.scene.environmentIntensity, 'environmentIntensity');
        requirePositive(this.renderer.toneMappingExposure, 'exposure');
        if (this.cinematicLighting && (this.sky.mesh.parent !== this.scene || !this.sky.mesh.visible || !this.scene.environment)) {
          throw new ViewerInputError('environment', 'cinematic lighting requires its sky and environment');
        }
      } catch (error) {
        this.recordStreamingError(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      this.renderer.info.reset();
      phaseStart = performance.now();
      this.renderer.render(this.scene, this.camera);
      this.phaseStats.render.push(performance.now() - phaseStart);
      this.lastDrawCalls = this.renderer.info.render.calls;
      this.lastTriangles = this.renderer.info.render.triangles;
    } else {
      this.phaseStats.render.push(0);
      this.lastDrawCalls = 0;
      this.lastTriangles = 0;
    }

    // Wall-clock frame delta (not just our CPU slice) so the HUD reports what
    // the display actually did, including time lost to the compositor.
    this.frameStats.push(Math.min(1000, dt * 1000));
    this.fps = 1000 / Math.max(0.001, this.frameStats.avg());
    phaseStart = performance.now();
    this.onFrame?.(dt);
    this.phaseStats.integration.push(performance.now() - phaseStart);
    this.benchmarkFrameHook?.();
  };

  /** Optional per-frame hook (used by the benchmark and by integrations). */
  onFrame: ((dt: number) => void) | null = null;

  private updateCityFrustum(): void {
    this.camera.updateMatrixWorld();
    this.cityViewProjection.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.cityFrustum.setFromProjectionMatrix(this.cityViewProjection);
  }

  private updateStreaming(cameraPos: Vector3): void {
    this.updateCityFrustum();
    const height = this.renderer.domElement.height || 1;
    const sseScale = height / (2 * Math.tan(MathUtils.degToRad(this.camera.fov) / 2));
    this.roadLayer?.update(cameraPos, sseScale, this.options.maxScreenSpaceError);
    this.cityLayer?.update(cameraPos, sseScale, this.options.maxScreenSpaceError);
    this.vegLayer?.update(cameraPos, sseScale, this.options.vegetationScreenSpaceError);
    this.enforceBudget();
  }

  /**
   * Shared ledger for both layers. In-flight decodes count against the budget
   * too — a parsed-but-not-yet-uploaded LOD0 tile holds its whole texture set
   * as ImageBitmaps, and three concurrent ones are what took the tab down
   * before this existed.
   */
  private readonly memory = {
    admit: (bytes: number, priority: number): boolean => {
      const budget = this.options.byteBudget;
      if (this.totalBytes() + bytes <= budget) return true;
      return this.freeSpace(budget - bytes, priority);
    },
    maxAssetBytes: (): number => this.options.byteBudget * 0.45,
    pendingBytes: (): number => Math.max(0, this.totalBytes() - this.residentBytes()),
  };

  private enforceBudget(): void {
    this.freeSpace(this.options.byteBudget, -Infinity);
  }

  /**
   * Evicts until `this.totalBytes() <= limit`, touching only assets that score
   * worse than `priority`. Returns whether the limit was reached.
   */
  private freeSpace(limit: number, priority: number): boolean {
    let total = this.totalBytes();
    if (total <= limit) return true;
    const candidates: EvictionCandidate[] = [];
    this.cityLayer?.evictionCandidates(candidates);
    this.vegLayer?.evictionCandidates(candidates);
    // Worst score first: out-of-range tiles, then overshoot, then distance.
    candidates.sort((a, b) => b.score - a.score);
    for (const candidate of candidates) {
      if (total <= limit) break;
      if (candidate.score <= priority) break; // nothing cheaper left to give up
      total -= candidate.layer.evict(candidate);
    }
    return total <= limit;
  }

  private residentBytes(): number {
    return (
      (this.cityLayer?.residentBytes ?? 0) +
      (this.vegLayer?.residentBytes ?? 0) +
      (this.roadLayer?.residentBytes ?? 0) +
      this.snowCover.stats().residentBytes +
      (this.atlas?.diagnostics.residentBytes ?? 0)
    );
  }

  private totalBytes(): number {
    return (
      this.residentBytes() +
      (this.cityLayer?.pendingBytes ?? 0) +
      (this.vegLayer?.pendingBytes ?? 0) +
      (this.roadLayer?.pendingBytes ?? 0) +
      this.snowCover.stats().pendingBytes
    );
  }

  // ------------------------------------------------------------- public API

  getStats(): CityViewerStats {
    const city = this.cityLayer?.stats();
    const veg = this.vegLayer?.stats();
    const road = this.roadLayer?.stats();
    const snow = this.snowCover.stats();
    const snowStreaming = snowStreamingContribution(snow);
    const sum = (pick: (s: NonNullable<typeof city>) => number): number =>
      (city ? pick(city) : 0) + (veg ? pick(veg) : 0) + (road ? pick(road) : 0);
    const auxiliaryPending = Number(this.mapLoadActive) + this.presetTransitions
      + this.auxiliaryLoads + snowStreaming.loading + snowStreaming.queued;
    const streamingError = this.renderer.getContext().isContextLost()
      ? 'WebGL context was lost; reload the map to recreate its GPU resources'
      : this.streamingError;
    // Body-reader gaps are not completion: queued GLBs can still reveal textures.
    // Scope can reopen as camera selection or a preset changes.
    const scopeSettled = this.mapLoaded && !this.disposed && !streamingError
      && auxiliaryPending === 0
      && sum((s) => s.loading + s.queued + s.uploading + s.pendingTextureUploads
        + s.compiling + s.requiredPendingAssets) === 0;
    const downloads = this.downloadTracker.snapshot(performance.now(), scopeSettled);
    const stage = streamingError ? 'error'
      : downloads.active > 0 ? 'downloading'
      : sum((s) => s.pendingTextureUploads) > 0 ? 'uploading'
      : sum((s) => s.compiling) > 0 ? 'compiling'
      : sum((s) => s.loading + s.queued + s.uploading) + auxiliaryPending > 0 ? 'decoding'
      : 'ready';
    const dimensions: Record<string, number> = {};
    const textureFormats: Record<string, number> = {};
    const rgbaFallbacks: Record<string, number> = {};
    const contentWarnings: Record<string, number> = {};
    if (this.atlas?.diagnostics.downgradeReason) contentWarnings['shadow-atlas-gpu-limit'] = 1;
    const sources = new Set<object>();
    for (const layer of [this.roadLayer, this.cityLayer, this.vegLayer]) {
      for (const entry of layer?.entries.values() ?? []) for (const asset of entry.resident.values()) {
        for (const texture of asset.resources.textures) {
          if (sources.has(texture.source) || !texture.userData.mapTexture) continue;
          sources.add(texture.source);
          const image = texture.image as { width: number; height: number };
          const key = `${image.width}x${image.height}`;
          dimensions[key] = (dimensions[key] ?? 0) + 1;
          const format = String(texture.format);
          textureFormats[format] = (textureFormats[format] ?? 0) + 1;
          const reason = texture.userData.mapTexture.rgbaFallbackReason as string | undefined;
          if (reason) rgbaFallbacks[reason] = (rgbaFallbacks[reason] ?? 0) + 1;
          if (isMaskOnlyAlbedo(texture)) contentWarnings['albedo-rgb-missing'] = (contentWarnings['albedo-rgb-missing'] ?? 0) + 1;
        }
      }
    }
    const usable = this.mapAdmitted && !this.disposed && !this.renderingSuspended && !streamingError
      && ((this.roadLayer?.group.children.length ?? 0) + (this.cityLayer?.group.children.length ?? 0) > 0)
      && (!this.roadLayer || this.roadReady)
      && (city?.missingInViewTiles ?? 0) === 0;
    const targetQualityReady = usable && Boolean(this.textureTierIndex) && this.viewResidentNow()
      && this.presetTransitions === 0;
    return {
      tierSelection: this.tierSelection,
      loadDiagnostics: {
        capabilities: this.textureCapabilities,
        availableVariantIds: Object.keys(this.variantManifest?.variants ?? {}),
        lastError: this.lastLoadError, textureFormats, rgbaFallbacks, contentWarnings,
        shadowAtlas: this.atlas?.diagnostics ?? null,
        admissionUnderestimates: { city: city?.largestAdmissionUnderestimate ?? null,
          roads: road?.largestAdmissionUnderestimate ?? null, vegetation: veg?.largestAdmissionUnderestimate ?? null },
        admissionRefusals: { city: city?.lastAdmissionRefusal ?? null,
          roads: road?.lastAdmissionRefusal ?? null, vegetation: veg?.lastAdmissionRefusal ?? null },
        residencyBytes: {
          city: { resident: city?.bytes ?? 0, pending: city?.pendingBytes ?? 0 },
          roads: { resident: road?.bytes ?? 0, pending: road?.pendingBytes ?? 0 },
          vegetation: { resident: veg?.bytes ?? 0, pending: veg?.pendingBytes ?? 0 },
        },
        residencyDeadline: this.residencyDeadline,
        actorModels: externalModelDiagnostics(),
      },
      usable,
      targetQualityReady,
      mapTextures: { dimensions, ...trackedTextureStats(this.downloadTracker) },
      fps: this.fps,
      frameMsAvg: this.frameStats.avg(),
      frameMsP50: this.frameStats.percentile(0.5),
      frameMsP95: this.frameStats.percentile(0.95),
      frameMsP99: this.frameStats.percentile(0.99),
      frameMsMax: this.frameStats.max(),
      frameTimeCounts: this.frameTimeCounts(),
      phases: this.phaseSnapshot(),
      drawCalls: this.lastDrawCalls,
      triangles: this.lastTriangles,
      programs: this.renderer.info.programs?.length ?? 0,
      residentTiles: sum((s) => s.residentTiles),
      residentAssets: sum((s) => s.residentAssets),
      residentBytes: this.residentBytes(),
      pendingBytes: this.totalBytes() - this.residentBytes(),
      byteBudget: this.options.byteBudget,
      loading: sum((s) => s.loading) + Number(this.mapLoadActive) + this.presetTransitions
        + this.auxiliaryLoads + snowStreaming.loading,
      queued: sum((s) => s.queued) + snowStreaming.queued,
      uploading: sum((s) => s.uploading),
      pendingTextureUploads: sum((s) => s.pendingTextureUploads),
      downloads,
      requiredPendingAssets: sum((s) => s.requiredPendingAssets) + auxiliaryPending,
      loadProgress: {
        decodedAssets: sum((s) => s.decodedAssets) + this.downloadTracker.decodedAssets,
        uploadedTextures: sum((s) => s.uploadedTextures),
        compiledAssets: sum((s) => s.compiledAssets),
        stage,
        textureMaxDimension: this.effectiveTextureMaxDimension,
      },
      jsHeapMB: jsHeapMB(),
      cameraMode: this.controls.mode,
      renderingSuspended: this.renderingSuspended,
      roadVisible: this.roadReady && this.roadGroup.visible,
      streamingError,
      requiredError: streamingError,
      detailFailures: this.detailFailures,
      detailError: this.detailError,
      uiTicksPerSecond: this.fps,
      surfaceMaterials: this.surfaceMaterials.report(),
      snowCover: snow,
      assetVariants: { manifest: Boolean(this.variantManifest), loaded: { ...this.variantLoads }, fallbacks: this.variantFallbacks },
      coverage: { roads: layerCoverage(road), city: layerCoverage(city), vegetation: layerCoverage(veg) },
    };
  }

  /**
   * Suspend the complete visual pipeline while keeping requestAnimationFrame and
   * `onFrame` alive for simulation, timeline and metrics consumers.
   */
  setRenderingSuspended(suspended: boolean): void {
    if (suspended === this.renderingSuspended) return;
    this.renderingSuspended = suspended;
    if (suspended) {
      this.canvasVisibility = this.canvas.style.visibility;
      this.canvas.style.visibility = 'hidden';
      this.controls.setEnabled(false);
      this.lastDrawCalls = 0;
      this.lastTriangles = 0;
    } else {
      this.canvas.style.visibility = this.canvasVisibility;
      this.controls.setEnabled(true);
      this.lastStreamUpdate = 0;
      this.frameStats.reset();
    }
  }

  get isRenderingSuspended(): boolean {
    return this.renderingSuspended;
  }

  /** Activity owns no simulation while hidden; unlike visual suspension, stop RAF and onFrame too. */
  setActivityHeld(held: boolean): void {
    if (held === this.activityHeld || this.disposed) return;
    this.activityHeld = held;
    this.setRenderingSuspended(held);
    if (held) cancelAnimationFrame(this.rafHandle);
    else {
      this.lastFrameTime = performance.now();
      this.rafHandle = requestAnimationFrame(this.tick);
    }
  }
  getLiveQuality(): CityViewerLiveQuality {
    const {
      maxPixelRatio,
      maxScreenSpaceError,
      vegetationScreenSpaceError,
      byteBudget,
      uploadBudgetMs,
      uploadPixelsPerFrame,
      vegetationMaxDistance,
      exposure,
    } = this.options;
    return {
      maxPixelRatio,
      maxScreenSpaceError,
      vegetationScreenSpaceError,
      byteBudget,
      uploadBudgetMs,
      uploadPixelsPerFrame,
      vegetationMaxDistance,
      exposure,
    };
  }

  getRendererCapability(): RendererCapability {
    const gl = this.renderer.getContext();
    const debug = gl.getExtension('WEBGL_debug_renderer_info') as { UNMASKED_RENDERER_WEBGL: number; UNMASKED_VENDOR_WEBGL: number } | null;
    const renderer = String(gl.getParameter(debug?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER) ?? 'unknown');
    const vendor = String(gl.getParameter(debug?.UNMASKED_VENDOR_WEBGL ?? gl.VENDOR) ?? 'unknown');
    const identity = `${renderer} ${vendor}`.toLowerCase();
    return {
      renderer,
      vendor,
      webgl2: typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext,
      software: /swiftshader|llvmpipe|software|basic render|mesa offscreen/.test(identity),
    };
  }

  /** Atomically change related modes so one preference switch causes one asset reset. */
  setAuthoringFidelity(modes: {
    cinematicLighting?: boolean;
    textureMaxDimension?: number;
  }): void {
    if (modes.cinematicLighting !== undefined) {
      this.setCinematicLighting(modes.cinematicLighting);
    }
    if (modes.textureMaxDimension !== undefined) this.setTextureMaxDimension(modes.textureMaxDimension);
  }

  /**
   * Turns the generated sky, its image-based light and the sun's shadow map on
   * or off without rebuilding the viewer.
   *
   * A quality change usually remounts the canvas, because pixel ratio and
   * antialias are context-creation options — but the persistent world host
   * switches presets on a live viewer, so this has to be reversible.
   */
  setCinematicLighting(enabled: boolean): void {
    const next = enabled;
    if (next === this.cinematicLighting) return;
    this.cinematicLighting = next;
    this.sky.mesh.visible = next;
    this.realtimeShadows = next && this.options.realtimeShadows;
    this.renderer.shadowMap.enabled = this.realtimeShadows;
    if (next) {
      this.refreshSkyEnvironment();
    } else {
      this.scene.environment = null;
      this.environmentFromSky = false;
    }
    this.configureSunShadow();
  }

  /**
   * A texture-budget change is the one preset move that still rebuilds resident
   * assets: the streamed derivatives themselves depend on it.
   */
  private setTextureMaxDimension(requested: number): void {
    const textureDimension = Number.isFinite(requested)
      ? Math.max(128, Math.floor(requested)) : Infinity;
    if (textureDimension === this.options.textureMaxDimension) return;
    this.options.textureMaxDimension = textureDimension;
    // Explicit limits are device constraints, never a silent quality ratchet.
    // Restore the unweathered scene before renderer-owned resources are
    // swapped. The desired appearance is reapplied at the end of the
    // transition.
    this.weather.clear();
    if (this.weatherAppearance) {
      this.surfaceMaterials.setWeatherAppearance({ wetness: 0, snowCoverage: 0 });
    }
    this.streamingError = null;
    this.streamingErrorOrigin = null;
    this.terminalError = null;
    this.detailFailures = 0;
    this.detailError = null;
    void this.runPresetTransition(async () => { await this.configureTextureTier(); await this.reloadAssetVariant(); });
    this.refreshWeatherAppearance();
  }

  private async runPresetTransition(operation: () => Promise<void>): Promise<void> {
    this.presetTransitions++;
    try {
      await operation();
    } catch (error) {
      this.recordStreamingError(error);
    } finally {
      this.presetTransitions = Math.max(0, this.presetTransitions - 1);
    }
  }


  /**
   * A detail tile gave up after its retries. The map stays usable, so this is
   * counted and reported as reduced detail instead of failing the load; a
   * budget error still goes through `recordStreamingError`, which knows how to
   * refit the texture budget and retry.
   */
  private recordDetailFailure(error: unknown): void {
    if (this.disposed || (error as { name?: string } | null)?.name === 'AbortError') return;
    if (error instanceof RequiredAssetBudgetError || error instanceof ViewerInputError) {
      this.recordStreamingError(error);
      return;
    }
    this.detailFailures += 1;
    this.detailError = error instanceof Error ? error.message : String(error);
    console.warn('[city-renderer] detail tile unavailable', error);
  }

  private recordStreamingError(error: unknown): void {
    if (this.disposed || (error as { name?: string } | null)?.name === 'AbortError') return;
    const detail = error as { code?: string; field?: string; cause?: unknown } | null;
    const causes: string[] = [];
    const seen = new Set<unknown>();
    for (let cause = detail?.cause; cause !== undefined && cause !== null && !seen.has(cause);) {
      seen.add(cause);
      causes.push(cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause));
      cause = cause instanceof Error ? cause.cause : undefined;
    }
    this.lastLoadError = {
      name: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error),
      code: detail?.code, field: detail?.field,
      cause: causes.length ? causes.join('\nCaused by: ') : undefined,
      ...(error instanceof RequiredAssetBudgetError
        ? { layer: error.layerName, assetId: error.assetId, estimatedBytes: error.estimatedBytes,
            required: error.layer.entries.get(error.assetId)?.required } : {}),
      residentBytes: this.residentBytes(), pendingBytes: this.totalBytes() - this.residentBytes(),
      ...(error instanceof ResidencyTimeoutError ? error.diagnostics : {}),
      byteBudget: this.options.byteBudget,
    };
    if (error instanceof RequiredAssetBudgetError && this.textureBudgetRecovery) {
      this.pendingTextureBudgetError = error;
      return;
    }
    if (error instanceof RequiredAssetBudgetError && this.tierSelection.actual === 'medium') {
      const recovery = this.runPresetTransition(async () => {
        await this.configureTextureTier('Required geometry and Medium textures exceed the resident budget; selected Low');
        await this.reloadAssetVariant();
      });
      this.textureBudgetRecovery = recovery;
      void recovery.then(() => {
        if (this.textureBudgetRecovery !== recovery) return;
        this.textureBudgetRecovery = null;
        const pending = this.pendingTextureBudgetError;
        this.pendingTextureBudgetError = null;
        if (pending && pending.layer.generationId === pending.generation) this.recordStreamingError(pending);
      });
      return;
    }
    if (error instanceof ViewerInputError) this.inputError = error;
    this.streamingError = error instanceof Error ? error.message : String(error);
    this.streamingErrorOrigin = 'terminal';
    this.terminalError = error instanceof Error ? error : new Error(String(error));
    console.error('[city-renderer] streaming failed', error);
  }

  private async ensureVegetationLayer(): Promise<void> {
    if (this.vegLayer || !this.manifest || this.disposed
      || !this.options.vegetation || this.options.vegetationMaxDistance <= 0) return;
    this.auxiliaryLoads++;
    try {
      await this.loadVegetationInstances(this.manifest);
      if (this.vegLayer || this.disposed) return;
      this.createVegetationLayer(this.manifest);
      this.lastStreamUpdate = 0;
    } finally {
      this.auxiliaryLoads = Math.max(0, this.auxiliaryLoads - 1);
    }
  }

  private async reloadAssetVariant(): Promise<void> {
    const generation = ++this.assetVariantReloadGeneration;
    const view = this.captureView();
    const layers = [this.roadLayer, this.cityLayer, this.vegLayer].filter(
      (layer): layer is TileStreamLayer => layer !== null,
    );
    await Promise.all(layers.map((layer) => layer.resetAssets()));
    if (this.disposed || generation !== this.assetVariantReloadGeneration) return;
    // Asset variants are a rendering-quality choice. Keep the editor viewpoint
    // byte-for-byte stable while the streamed scene graph is rebuilt.
    this.applyView(view);
    this.lastStreamUpdate = 0;
    this.camera.getWorldPosition(_cameraPos);
    this.updateStreaming(_cameraPos);
  }

  /** Select a reversible, visual-only material treatment for streamed map surfaces. */
  setSurfaceMaterialProfile(profile: SurfaceMaterialProfile): ReturnType<SurfaceMaterialRegistry['report']> {
    return this.surfaceMaterials.apply(profile);
  }

  getSurfaceMaterialReport(): ReturnType<SurfaceMaterialRegistry['report']> {
    return this.surfaceMaterials.report();
  }

  /** Enable practical street lighting discovered from semantic map-furniture nodes. */
  setStreetLightsEnabled(enabled: boolean): void {
    this.luminaires.setEnabled(enabled);
    this.luminaires.update(this.camera);
  }

  getStreetLightingStats(): LuminaireLightingStats {
    return this.luminaires.stats();
  }

  /**
   * Apply one visual weather appearance to the complete streamed world.
   *
   * The controller owns fog, haze and precipitation while the surface registry
   * carries wetness and snow onto every tile that streams in later. Passing
   * `null` restores the exact pre-weather scene state.
   */
  setWeatherAppearance(appearance: CityWeatherAppearance | null): void {
    if (appearance) {
      for (const field of ['sunIntensityScale', 'environmentIntensityScale', 'exposureScale', 'backgroundIntensityScale'] as const) {
        requirePositive(appearance[field], `weather.${field}`);
      }
    }
    this.weatherAppearance = appearance === null ? null : {
      ...appearance,
      fog: appearance.fog ? { ...appearance.fog } : null,
      precipitation: appearance.precipitation ? { ...appearance.precipitation } : null,
      surface: { ...appearance.surface },
    };
    this.refreshWeatherAppearance();
  }

  /**
   * Pin animated weather to an explicit scenario time during fixed-step capture.
   * Pass `null` to resume interactive wall-clock animation.
   */
  setWeatherTimeSeconds(timeSeconds: number | null): void {
    this.weather.setTimeSeconds(timeSeconds);
  }

  private refreshWeatherAppearance(): void {
    this.weather.clear();
    const appearance = this.weatherAppearance;
    if (!appearance) {
      this.surfaceMaterials.setWeatherAppearance({ wetness: 0, snowCoverage: 0 });
      this.snowCover.setAppearance({ coverage: 0 });
      this.applySkyWeather(null);
      return;
    }
    const effective = appearance;
    this.surfaceMaterials.setWeatherAppearance(effective.surface);
    this.snowCover.setAppearance({
      coverage: effective.surface.snowCoverage,
      depthM: effective.surface.snowDepthM,
      compaction: effective.surface.snowCompaction,
    });
    this.weather.apply(effective, this.sun);
    this.applySkyWeather(effective);
  }

  /**
   * Matches the atmosphere to the weather.
   *
   * `WeatherController` also assigns `scene.background`, which sits behind the
   * dome and is therefore invisible; the authored colour has to reach the sky
   * itself or an overcast scenario would keep a clear blue sky.
   */
  private applySkyWeather(appearance: CityWeatherAppearance | null): void {
    this.sky.setAppearance(appearance === null
      ? CLEAR_SKY
      : skyAppearanceForWeather({
        haze: appearance.fog?.haze ?? 0,
        backgroundColor: appearance.backgroundColor,
      }));
    this.syncSunFromLight(true);
  }

  /**
   * Adopts the light's own orientation as the sun direction.
   *
   * The consuming editor moves the `sun` object directly to place time of day,
   * and it does so *after* pushing weather, so the sky cannot rely on being
   * told. Reading the light back on the streaming cadence keeps the atmosphere,
   * the image-based light and the shadow frustum consistent with whoever moved
   * it last.
   */
  private syncSunFromLight(force = false): void {
    const sun = this.sun;
    if (!sun) return;
    _sunTravel.copy(sun.target.position).sub(sun.position);
    if (_sunTravel.lengthSq() === 0) return;
    const previous = this.sky.sunDirection();
    this.sky.setSunTravelDirection(_sunTravel);
    if (!force && this.sky.sunDirection().angleTo(previous) <= SUN_SYNC_TOLERANCE_RAD) return;
    if (this.environmentFromSky) this.refreshSkyEnvironment();
    this.configureSunShadow();
  }

  /** Apply authoring quality without rebuilding the renderer or reloading the map. */
  setLiveQuality(next: Partial<CityViewerLiveQuality>): CityViewerLiveQuality {
    if (next.exposure !== undefined) requirePositive(next.exposure, 'exposure');
    if (this.weatherAppearance) this.weather.clear();
    const finite = (value: number | undefined, fallback: number, min: number, max: number) =>
      value === undefined || !Number.isFinite(value)
        ? fallback
        : Math.min(max, Math.max(min, value));
    this.options.maxPixelRatio = finite(next.maxPixelRatio, this.options.maxPixelRatio, 0.5, 3);
    this.options.maxScreenSpaceError = finite(
      next.maxScreenSpaceError,
      this.options.maxScreenSpaceError,
      25,
      5000,
    );
    this.options.vegetationScreenSpaceError = finite(
      next.vegetationScreenSpaceError,
      this.options.vegetationScreenSpaceError,
      100,
      10000,
    );
    const previousByteBudget = this.options.byteBudget;
    const previousVegetationDistance = this.options.vegetationMaxDistance;
    this.options.byteBudget = finite(next.byteBudget, this.options.byteBudget, 256e6, 4e9);
    this.options.uploadBudgetMs = finite(
      next.uploadBudgetMs,
      this.options.uploadBudgetMs,
      0.25,
      20,
    );
    this.options.uploadPixelsPerFrame = finite(
      next.uploadPixelsPerFrame,
      this.options.uploadPixelsPerFrame,
      128e3,
      16.8e6,
    );
    this.options.vegetationMaxDistance = finite(
      next.vegetationMaxDistance,
      this.options.vegetationMaxDistance,
      0,
      2000,
    );
    this.options.exposure = next.exposure ?? this.options.exposure;
    if (this.options.byteBudget !== previousByteBudget) {
      this.roadLayer?.clearBudgetBlocks();
      this.cityLayer?.clearBudgetBlocks();
      this.vegLayer?.clearBudgetBlocks();
      if (this.options.byteBudget > previousByteBudget) this.snowCover.retryRejected();
    }
    if (previousVegetationDistance <= 0 && this.options.vegetationMaxDistance > 0) {
      void this.ensureVegetationLayer();
    }
    this.renderer.toneMappingExposure = this.options.exposure;
    if (this.weatherAppearance) this.refreshWeatherAppearance();
    this.resize();
    this.camera.getWorldPosition(_cameraPos);
    this.updateStreaming(_cameraPos);
    return this.getLiveQuality();
  }

  setCameraMode(mode: CameraMode): void {
    this.controls.setMode(mode);
  }

  setCameraControlPreferences(preferences: CameraControlPreferences): void {
    this.controls.setControlPreferences(preferences);
  }

  toggleCameraMode(): CameraMode {
    return this.controls.toggleMode();
  }

  setLayerVisible(layer: keyof CityViewerLayers | 'road', visible: boolean): void {
    if (layer === 'city') this.cityGroup.visible = visible;
    else if (layer === 'vegetation') {
      this.options.vegetation = visible;
      this.vegetationGroup.visible = visible;
      if (visible) void this.ensureVegetationLayer();
    } else this.roadGroup.visible = visible;
  }

  setExposure(exposure: number): void {
    requirePositive(exposure, 'exposure');
    if (this.weatherAppearance) this.weather.clear();
    this.options.exposure = exposure;
    this.renderer.toneMappingExposure = exposure;
    if (this.weatherAppearance) this.refreshWeatherAppearance();
  }

  /**
   * Ground height under a world XZ, or null if nothing is there.
   *
   * Rays are cast downward against the road layer first (it is the actual
   * ground surface and always resident) and fall back to the city tiles for
   * points that sit on a plaza or a building. This is the hook lane overlays
   * will drape on.
   */
  sampleGroundHeight(x: number, z: number): number | null {
    const top = this.sceneBox.max.y + 50;
    _rayOrigin.set(x, top, z);
    this.raycaster.set(_rayOrigin, _down);
    this.raycaster.far = top - this.sceneBox.min.y + 200;
    const targets: Object3D[] = [];
    if (this.roadLayer) targets.push(this.roadLayer.group);
    if (this.cityLayer) targets.push(this.cityLayer.group);
    if (targets.length === 0) return null;
    const hits = this.raycaster.intersectObjects(targets, true);
    for (const hit of hits) {
      if (hit.object.visible) return hit.point.y;
    }
    return null;
  }

  /** True once the road layer has geometry, i.e. ground sampling can work. */
  get roadReady(): boolean {
    let found = false;
    this.roadGroup.traverse((obj) => {
      if (!found && (obj as Mesh).isMesh) found = true;
    });
    return found;
  }

  /**
   * Bake the road layer into a {@link GroundIndex} for bulk height queries.
   *
   * {@link sampleGroundHeight} is the right tool for one-off picks; it is ~9.5 ms
   * a call on Yale Street, so anything draping thousands of points (lane
   * overlays, actor placement, path snapping) wants this instead — ~30 ms to
   * build, ~0.2 µs a query, and identical answers over the road surface.
   *
   * The result is a snapshot. The road layer is pinned with a single LOD so it
   * never changes after load, but callers must wait for {@link roadReady};
   * building early returns `null`.
   *
   * Street furniture baked into the road glTF (mast arms, lamp posts, signal
   * heads, insulators — 783 of Yale Street's 807 road meshes) is filtered out
   * by `isGroundSurfaceMesh`; without that, anything draped under a lamp post
   * drapes onto the lamp. Pass `meshFilter` to override.
   */
  buildGroundIndex(options?: GroundIndexOptions): GroundIndex | null {
    const index = GroundIndex.build(this.roadGroup, options);
    if (index) return index;
    // The filter matched nothing. That means this map does not export its
    // ground as large sheets, not that it has no ground — an unfiltered index
    // is far better than none.
    return GroundIndex.build(this.roadGroup, { ...options, meshFilter: () => true });
  }

  /**
   * Return the reusable road/ground height index, building it once on demand.
   * Editor overlays and actor placement use this instead of repeating expensive
   * whole-scene raycasts for every sampled point.
   */
  getGroundIndex(): GroundIndex | null {
    if (this.cameraGroundIndex) return this.cameraGroundIndex;
    this.cameraGroundIndex = this.buildGroundIndex();
    if (this.cameraGroundIndex) this.localEnvelopeBounds = null;
    return this.cameraGroundIndex;
  }

  /** Exercise reversible multi-angle editor orbits and report frame pacing. */
  async runBenchmark(durationMs = 15000): Promise<BenchResult> {
    const center = this.sceneBox.getCenter(new Vector3());
    const size = this.sceneBox.getSize(new Vector3());
    const span = Math.max(size.x, size.z);
    const savedPosition = this.camera.position.clone();
    const savedTarget = this.controls.target.clone();
    const savedMode = this.controls.mode;
    const benchmarkPosition = new Vector3();

    this.benchmarkActive = true;
    this.controls.setEnabled(false);
    for (const phase of Object.values(this.phaseStats)) phase.reset();
    const stats = new FrameStats(Math.ceil(durationMs / 4));
    const start = performance.now();
    let frames = 0;
    let worstFrameMs = 0;
    let drawCallTotal = 0;
    let last = start;

    await new Promise<void>((resolve) => {
      this.benchmarkFrameHook = () => {
        const now = performance.now();
        const elapsed = now - start;
        const frameMs = now - last;
        last = now;
        if (frames > 2) {
          stats.push(frameMs);
          worstFrameMs = Math.max(worstFrameMs, frameMs);
          drawCallTotal += this.lastDrawCalls;
        }
        frames++;

        const t = Math.min(1, elapsed / durationMs);
        const pose = benchmarkOrbitPose(t);
        benchmarkPosition.set(
          center.x + Math.cos(pose.angle) * span * pose.radius,
          center.y + span * pose.height,
          center.z + Math.sin(pose.angle) * span * pose.radius,
        );
        this.controls.setView(benchmarkPosition, center);
        if (elapsed >= durationMs) resolve();
      };
    });

    this.benchmarkFrameHook = null;
    this.benchmarkActive = false;
    this.controls.setEnabled(!this.renderingSuspended);
    this.controls.setMode(savedMode);
    this.controls.setView(savedPosition, savedTarget);

    const durationSeconds = (performance.now() - start) / 1000;
    const phases = this.phaseSnapshot();
    const phaseMs = phases.controlsMsAvg + phases.streamingMsAvg + phases.uploadsMsAvg + phases.renderMsAvg + phases.integrationMsAvg;
    return {
      avgFps: frames / durationSeconds,
      p50FrameMs: stats.percentile(0.5),
      p95FrameMs: stats.percentile(0.95),
      p99FrameMs: stats.percentile(0.99),
      maxFrameMs: worstFrameMs,
      minFps: worstFrameMs > 0 ? 1000 / worstFrameMs : 0,
      drawCalls: frames > 3 ? Math.round(drawCallTotal / (frames - 3)) : this.lastDrawCalls,
      residentBytes: this.residentBytes(),
      frames,
      durationMs: durationSeconds * 1000,
      frameTimeCounts: this.frameTimeCounts(stats),
      orbit: {
        frames: stats.count,
        durationMs: durationSeconds * 1000,
        p50FrameMs: stats.percentile(0.5),
        p95FrameMs: stats.percentile(0.95),
        p99FrameMs: stats.percentile(0.99),
        maxFrameMs: stats.max(),
        over33_3: stats.countAbove(33.3),
        over50: stats.countAbove(50),
      },
      phases,
      capturedAt: new Date().toISOString(),
      renderingSuspended: this.renderingSuspended,
      displayFps: frames / durationSeconds,
      uiFrameP95Ms: stats.percentile(0.95),
      simulationTicksPerSecond: null,
      cpuUtilizationProxy: Math.min(100, 100 * phaseMs / Math.max(0.001, stats.avg())),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.rafHandle);
    this.abort.abort();
    this.textureLoadAbort.abort();
    disposeTrackedLoader(this.downloadTracker);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.controls.dispose();
    this.canvas.style.visibility = this.canvasVisibility;
    const layers = [this.cityLayer, this.vegLayer, this.roadLayer].filter(
      (layer): layer is TileStreamLayer => layer !== null,
    );
    for (const layer of layers) layer.dispose();
    this.atlas?.dispose();
    this.weather.dispose();
    this.snowCover.dispose();
    this.sky.dispose();
    this.luminaires.dispose();
    this.overlays.dispose();
    this.vegetationData.clear();
    this.surfaceMaterials.dispose();
    disposeAlbedoInspection(this.renderer);
    if (this.sun) this.scene.remove(this.sun, this.sun.target);
    this.scene.clear();
    // Three's compileAsync() owns an internal requestAnimationFrame readiness
    // poll and offers no cancellation API. Disposing WebGLRenderer first clears
    // the material program table underneath that poll, producing
    // `currentProgram is undefined` / `isReady` page errors on cross-map swaps.
    // The stream layers already refuse all new work once disposed, so keep only
    // the old renderer alive until the finite set of in-flight polls settles.
    void Promise.all(layers.map((layer) => layer.whenCompilationIdle())).then(() => {
      this.renderer.dispose();
      if (canvasRendererOwners.get(this.canvas) === this.renderer) {
        canvasRendererOwners.delete(this.canvas);
        // Activity keeps hidden DOM connected and later runs effects again on
        // that very canvas. Losing its context now makes the next renderer
        // constructor fail before it can report an error or draw a frame.
        // Renderer/map resources above are disposed in either case.
        if (!this.canvas.isConnected) {
          releasedCanvasContexts.set(this.canvas, this.renderer.getContext());
          this.renderer.forceContextLoss();
        }
      }
      // The one observable proof that leaving a 3D surface actually gave the GPU
      // resources back, rather than leaving a detached context alive behind the
      // next screen. Logged after the renderer is gone, not when dispose starts.
      console.info('[city-renderer]', 'cityviewer.disposed');
    });
  }

  private releaseMapResources(): void {
    // Release scene-owned weather first so its baseline textures/lights are
    // restored before the map environment itself is disposed.
    this.weather.clear();
    this.snowCover.setShadowOptions(null);
    const layers = [this.cityLayer, this.vegLayer, this.roadLayer].filter(
      (layer): layer is TileStreamLayer => layer !== null,
    );
    for (const layer of layers) layer.dispose();
    this.cityLayer = null;
    this.vegLayer = null;
    this.roadLayer = null;
    this.cityGroup.clear();
    this.vegetationGroup.clear();
    this.roadGroup.clear();
    this.atlas?.dispose();
    this.atlas = null;
    this.scene.environment = null;
    this.environmentFromSky = false;
    this.shadowBake = null;
    this.visualResourcesPromise = null;
    this.visualResourcesStarted = false;
    if (this.sun) this.scene.remove(this.sun, this.sun.target);
    this.sun = null;
    this.vegetationData.clear();
    this.manifest = null;
    this.variantManifest = null;
    this.staticSemantics = null;
    this.capabilities = [];
    this.luminaires.clear();
    this.cameraGroundIndex = null;
    this.localEnvelopeBounds = null;
    this.lastStreamUpdate = 0;
  }
}
