/**
 * Wire DTOs of the Studio host-service boundary.
 *
 * These are the shapes the `/api/simforge/*` routes return to the shared React
 * workflows, whether the host is local Studio (Next/Node/PGlite/filesystem) or
 * SimCloud (accounts, organizations, managed capacity). The host apps validate
 * inbound request bodies with their own zod schemas; the shared client only
 * needs the response shapes, so they are plain TypeScript here and have no
 * runtime footprint.
 */

import type { RenderSpecV3, ScenarioTemplateV2 } from "@simforge-oss/scenario";

// ── Enumerations shared by request validation and the UI ─────────────────────

export const SCENARIO_AUTHORING_QUALITY_IDS = [
  "low",
  "medium",
] as const;
export type ScenarioAuthoringQuality = (typeof SCENARIO_AUTHORING_QUALITY_IDS)[number];
/**
 * Texture tier a new document starts with: the tier of the default browser
 * rendering profile (studio-ui `DEFAULT_RENDERING_PREFERENCE`, "Low · no
 * foliage"), so a fresh scenario never asks for sharper textures than the
 * default profile downloads.
 */
export const DEFAULT_SCENARIO_AUTHORING_QUALITY_ID = "low" satisfies ScenarioAuthoringQuality;

export const SCENARIO_DATASET_VISIBILITIES = ["workspace", "organization", "public"] as const;
export type ScenarioDatasetVisibility = (typeof SCENARIO_DATASET_VISIBILITIES)[number];

export const SCENARIO_RATING_REVIEWED_VIA = ["queue", "browser"] as const;
export type ScenarioRatingReviewedVia = (typeof SCENARIO_RATING_REVIEWED_VIA)[number];

/**
 * Render job modes a row may carry. `full_render` and `browser_render` execute
 * the same immutable render intent through the registered worker lane;
 * `interaction_2d` is the sensor-free control mode.
 */
export const SCENARIO_JOB_MODES = ["interaction_2d", "full_render", "browser_render"] as const;
export type ScenarioJobMode = (typeof SCENARIO_JOB_MODES)[number];

export const OPENSCENARIO_NATIVE_PROFILE = "ASAM OpenSCENARIO XML 1.4";

/** The only product-facing operational job vocabulary. */
export const SCENARIO_JOB_FAMILIES = [
  "openscenario_compile",
  "openscenario_validate",
  "openscenario_render",
  "artifact_postprocess",
] as const;
export type ScenarioJobFamily = (typeof SCENARIO_JOB_FAMILIES)[number];

export const SCENARIO_RENDERER_ENGINES = ["browser", "carla", "native"] as const;
export type ScenarioRendererEngine = (typeof SCENARIO_RENDERER_ENGINES)[number];

// ── Projects: datasets, documents, tags, ratings, revisions ─────────────────

export type ScenarioDocumentDto = {
  id: string;
  workspaceId: string;
  title: string;
  draftVersion: number;
  schemaVersion: string;
  /**
   * Server-computed digest of the draft's canonical content, from the same
   * `canonicalContentSha256` a revision is frozen with. The render tab compares
   * it against a render's `revisionContentSha256` to decide whether that render
   * is outdated; the client's own `contentHash` uses a different serializer and
   * MUST NOT be compared against either.
   */
  contentSha256: string;
  content: ScenarioTemplateV2;
  mapVersionId: string | null;
  /** Canonical source identity; the version above records geometry provenance. */
  mapSourceMapId?: string | null;
  /** OpenDRIVE digest of the bound version, used to refuse unsafe forward resolution. */
  mapXodrSha256?: string | null;
  /**
   * Browser closure digest of the pinned map version, captured when the draft
   * was pinned. A revision commit refuses the draft if the version's closure
   * has changed since (`scenario_map_pin_mismatch`).
   */
  mapClosureSha256?: string | null;
  /** Asset catalog version pinned with the map version. */
  assetCatalogVersionId?: string | null;
  datasetId: string;
  authoringQualityId: ScenarioAuthoringQuality;
  createdAt: string;
  updatedAt: string;
  latestRevisionId: string | null;
};

export type ScenarioDatasetDto = {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  visibility: ScenarioDatasetVisibility;
  isSystemManaged: boolean;
  systemSlug: string | null;
  isDefault: boolean;
  /** Pinned revision × render-job pairs. Zero until someone pins a revision. */
  itemCount: number;
  /** Live documents in the dataset — the number the list actually wants. */
  documentCount: number;
  renderSubmittedCount: number;
  renderCompletedCount: number;
  exportCompletedCount: number;
  createdByUserName: string | null;
  updatedByUserName: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ScenarioDatasetReadinessDto = {
  summary: { total: number; rendered: number; cosmosed: number; vlmed: number };
  scenarios: Array<{ id: string; has_render: boolean }>;
};

/**
 * The per-row shape for the document list.
 *
 * Deliberately carries NO `content`. Everything here that comes from the
 * template comes from stored generated projections, so it can never disagree
 * with `content_sha256`. `contentTags` is the template's authored `meta.tags`
 * (hashed content); `tags` is the workspace's organizational catalog.
 */
export type ScenarioDocumentSummaryDto = {
  id: string;
  workspaceId: string;
  title: string;
  description: string | null;
  datasetId: string;
  datasetSortOrder: number;
  mapVersionId: string | null;
  mapLabel: string | null;
  /** Canonical map-assets identity shared by immutable versions of the same source map. */
  mapSourceMapId?: string | null;
  /** Stable first-party preview route for the exact immutable map version used by this document. */
  mapThumbnailUrl?: string | null;
  latestRevisionId: string | null;
  revisionCount: number;
  archetype: string | null;
  author: string | null;
  contentTags: string[];
  tags: Array<{ id: string; label: string; color: string | null }>;
  roleCount: number;
  /** Whether at least one actor has an authored sensor configuration. */
  hasSensorProfile: boolean;
  propCount: number;
  variantCount: number;
  clipSeconds: number | null;
  negativeControl: boolean;
  derivationKind: "copy" | "variation" | "cross_map_variation" | "import" | null;
  derivedFromDocumentId: string | null;
  hasRender: boolean;
  createdByUserName: string | null;
  updatedByUserName: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ScenarioDocumentSummaryPageDto = {
  documents: ScenarioDocumentSummaryDto[];
  nextCursor: string | null;
};

/**
 * A workspace organizational tag. Strictly separate from the template's
 * authored `meta.tags`; nothing here reaches `canonical_content`, so renaming
 * or recolouring a tag can never change a document digest.
 */
export type ScenarioTagDto = {
  id: string;
  workspaceId: string;
  slug: string;
  label: string;
  color: string | null;
  isSystemDefault: boolean;
  /** Live documents carrying this tag, for the filter dropdown's counts. */
  documentCount: number;
};

export type ScenarioDocumentRatingDto = {
  documentId: string;
  revisionId: string | null;
  renderJobId: string | null;
  raterUserId: string;
  score: number;
  comment: string | null;
  reviewedVia: ScenarioRatingReviewedVia;
  createdAt: string;
  updatedAt: string;
};

export type ScenarioRatingAggregateDto = {
  documentId: string;
  ratingCount: number;
  averageScore: number;
  minimumScore: number | null;
  reviewState: "pending" | "accepted" | "rejected";
  viewerScore: number | null;
};

export type ScenarioSimulationPreviewDto = {
  artifactId: string;
  draftVersion: number;
  sha256: string;
  sizeBytes: number;
  mediaType: string;
  downloadUrl: string;
  createdAt: string;
};

/** How a scenario's traffic is produced for its authoritative simulation. */
export type ScenarioSimulationTrafficProvider = "off" | "native" | "sumo";

/**
 * One authoritative, content-addressed simulation result. `simKey` is
 * H(resolvedInputDigest, mapClosureDigest, engineSemVer, solverVer,
 * traceSchema); `traceSha256` is the engine's canonical trace digest. The
 * trace bytes are immutable and keyed by digest, so any consumer (editor
 * cache, Evaluation, renders) can hold them under `traceSha256`.
 */
export type ScenarioSimulationResultDto = {
  simKey: string;
  traceSha256: string;
  /** Trace of the authored actors alone; equals `traceSha256` unless external traffic (SUMO) was merged. */
  authoredTraceSha256: string;
  engineSemVer: string;
  solverVer: string;
  traceSchema: string;
  resolvedInputDigest: string;
  mapClosureDigest: string;
  mapVersionId: string;
  trafficProvider: ScenarioSimulationTrafficProvider;
  trace: { mediaType: string; sizeBytes: number; gzipSha256: string; downloadUrl: string };
  /**
   * The resolution record (the exact input the trace was simulated from, its
   * materialization manifest and ambient provenance): what a replayer builds
   * the playback instance from. Content-addressed by `sha256` (gzip bytes).
   */
  resolution: { sizeBytes: number; sha256: string; downloadUrl: string };
  /** Render timeline (scene-state + baked heights) once derived; null until then. */
  timelineSha256: string | null;
  /** Byte length of the timeline's canonical JSON (the `render.timeline` render input). */
  timelineSizeBytes: number | null;
  producer: string;
  createdAt: string;
};

/** Where the authoritative simulation for a document version (or revision) stands. */
export type ScenarioSimulationStatusDto =
  | { state: "succeeded"; requestKey: string; result: ScenarioSimulationResultDto }
  | { state: "queued" | "running"; requestKey: string }
  | { state: "failed"; requestKey: string; failureCode: string; message: string | null };

/**
 * Where a render's motion comes from (`RenderIntentV1.motionSource`):
 * `original` is the revision's active simulation (its original result, under
 * whatever engine produced it), `resimulated` an explicitly chosen
 * re-simulation, `original-xosc` the labelled legacy OpenSCENARIO replay for
 * revisions that have no stored trace.
 */
export type ScenarioMotionSource = "original" | "resimulated" | "original-xosc";

/** Why a revision's active simulation is the one it is. */
export type ScenarioActiveSimulationReason = "commit" | "backfill-commit" | "backfill-resimulated" | "user";

/**
 * Motion difference between two stored traces of one scenario: presence and
 * world pose at matching ticks, within the render parity tolerance.
 */
export type ScenarioMotionDiffDto = {
  schema: "simforge.motion-diff/v1";
  identical: boolean;
  tolerance: { positionM: number; headingDeg: number };
  comparedTicks: number;
  /** Ticks present in only one of the two traces (different clip or step). */
  unmatchedTicks: number;
  maxPositionDeltaM: number;
  maxHeadingDeltaDeg: number;
  worst: { actorId: string; t: number } | null;
  firstDivergenceS: number | null;
  actorsChanged: string[];
  actorsOnlyInBase: string[];
  actorsOnlyInCandidate: string[];
  base: { traceSha256: string; engineSemVer: string };
  candidate: { traceSha256: string; engineSemVer: string };
};

/** One stored simulation result bound to a revision. */
export type ScenarioRevisionSimulationEntryDto = {
  simKey: string;
  engineSemVer: string;
  traceSha256: string;
  /** `commit`: simulated when the revision was committed; `lazy`: re-simulated later. */
  origin: "commit" | "lazy";
  createdAt: string;
  active: boolean;
};

/**
 * Which motion a revision's renders replay. Renders replay `active` by
 * default, under any engine version; nothing re-simulates implicitly.
 * `active` is null when the revision has no stored result (committed before
 * worker simulation): its original motion survives only as the legacy
 * OpenSCENARIO export (`legacyXoscAvailable`), and the user chooses between
 * that and an explicit re-simulation.
 */
export type ScenarioRevisionMotionDto = {
  revisionId: string;
  currentEngineSemVer: string;
  active: null | {
    simKey: string;
    engineSemVer: string;
    traceSha256: string;
    reason: ScenarioActiveSimulationReason;
    /** True when the active result is the one simulated at commit (the original motion). */
    original: boolean;
    setAt: string;
  };
  results: ScenarioRevisionSimulationEntryDto[];
  legacyXoscAvailable: boolean;
};

/** An explicit re-simulation under the current engine, with its motion diff against the active result. */
export type ScenarioRevisionResimulationDto = {
  status: ScenarioSimulationStatusDto;
  motion: ScenarioRevisionMotionDto;
  /** Null until the re-simulation succeeded, or when the revision has no active result to compare. */
  motionDiff: ScenarioMotionDiffDto | null;
};

/**
 * One map version by id, whether or not it is the newest publication of its
 * source: what an import needs to bind a scenario to the EXACT version it was
 * authored on. `pinnable` is false for a retired version or one whose
 * published closure is gone (a scenario can't be pinned to it).
 */
export type ScenarioMapVersionIdentityDto = {
  mapVersionId: string;
  sourceMapId: string | null;
  xodrSha256: string;
  retiredAt: string | null;
  pinnable: boolean;
};

/** The editor's comparison of its local preview against the authoritative trace. */
export type ScenarioSimulationVerificationDto = {
  documentId?: string | null;
  localTraceSha256: string;
  /** Which local runtime produced the preview (engine version, ABI, user agent). */
  localRuntime?: Record<string, string | number | boolean>;
};

export type ScenarioAmbientProvenanceDto =
  | {
      mode: "disabled";
      ambientConfig: Record<string, never>;
      configSha256: string;
      /** SHA-256 of the canonical materialized-traffic artifact, including disabled. */
      resultSha256: string;
    }
  | {
      mode: "native";
      runtimeVersion: string;
      seed: string | number;
      ambientConfig: Record<string, unknown>;
      configSha256: string;
      resultSha256: string;
    }
  | {
      mode: "sumo";
      sumoVersion: string;
      networkSha256: string;
      seed: string | number;
      ambientConfig: Record<string, unknown>;
      configSha256: string;
      resultSha256: string;
    };

export type ScenarioMaterializedTrafficReferenceDto = {
  artifactId: string;
  sha256: string;
  sizeBytes: number;
  sourceInputDigest: string;
  mapAssetId: string;
  mapVersionId: string;
};

export type ScenarioRevisionEvidenceDto = {
  ambient: ScenarioAmbientProvenanceDto;
  materializedTraffic: ScenarioMaterializedTrafficReferenceDto;
};

export type ScenarioRevisionDto = {
  id: string;
  workspaceId: string;
  documentId: string;
  revisionNumber: number;
  sourceDraftVersion: number;
  schemaVersion: string;
  contentSha256: string;
  mapVersionId: string | null;
  openScenarioProfile: typeof OPENSCENARIO_NATIVE_PROFILE;
  export: {
    id: string;
    format: "openscenario_xml_1_4";
    status: ScenarioExportStatus;
    artifactId: string | null;
  };
  createdAt: string;
};

// ── Simulation history (Versions panel) ──────────────────────────────────────

/**
 * `simforge.simulation-diff/v1`: two authoritative simulations of one scenario compared tick by tick
 * over the whole clip (`diffSimulationTraces`, packages/openscenario trace-diff), with the
 * strict-trajectory-v1 comparator's verdict. `summary` is the chip text ("Motion identical" or
 * "max 1.2 m · 2 actors · 1 event changed").
 */
export type SimulationMotionDiffDto = {
  format: "simforge.simulation-diff/v1";
  baseSimKey: string;
  candidateSimKey: string;
  identical: boolean;
  summary: string;
  maxPositionErrorM: number;
  maxHeadingErrorDeg: number;
  worst: { actorId: string; tS: number; positionErrorM: number } | null;
  actors: { compared: number; changedCount: number; changed: string[]; added: string[]; removed: string[] };
  eventsChanged: number;
  collisionsChanged: number;
  signalsChanged: number;
  durationS: { base: number; candidate: number };
  strict: {
    profile: "strict-trajectory-v1";
    verdict: "pass" | "fail" | "not-run";
    reportHash: string | null;
    errorFindings: number;
    reason: string | null;
  };
};

/** Why a simulation is in a revision's history. */
export type RevisionSimulationReason = "commit" | "engine_upgrade" | "resimulate" | "import" | "backfill";
/** Why a revision (a user-visible Version) exists. */
/** `map_move`: the draft as it was before it moved to another map version (kept for revert). */
export type ScenarioVersionCreatedFor = "render" | "save" | "engine_upgrade" | "import" | "map_move";

export type ScenarioVersionActorDto = { id: string; name: string | null } | null;

/** One simulation in a version's history. Users see its engine; the digests sit behind Details. */
export type ScenarioVersionSimulationDto = {
  simKey: string;
  engineSemVer: string;
  reason: RevisionSimulationReason;
  createdAt: string;
  createdBy: ScenarioVersionActorDto;
  active: boolean;
  previousSimKey: string | null;
  /** Against `previousSimKey`; null when there is none, or for a backfilled row not compared yet. */
  motionDiff: SimulationMotionDiffDto | null;
  details: {
    traceSha256: string;
    timelineSha256: string | null;
    mapClosureDigest: string;
    resolvedInputDigest: string;
    engineBuild: Record<string, unknown>;
    producer: string;
  };
};

/** One immutable revision, shown to users as "Version N". */
export type ScenarioVersionDto = {
  revisionId: string;
  revisionNumber: number;
  label: string | null;
  createdFor: ScenarioVersionCreatedFor;
  createdAt: string;
  createdBy: ScenarioVersionActorDto;
  sourceDraftVersion: number;
  contentSha256: string;
  /** "Map name · date": the map version the revision is pinned to. */
  map: { mapVersionId: string; name: string; publishedAt: string } | null;
  /** The result its renders replay (`revision_active_simulation`); null when it has none. */
  active: { simKey: string; setAt: string; setBy: ScenarioVersionActorDto } | null;
  /** Newest first. */
  simulations: ScenarioVersionSimulationDto[];
  /** True when the draft currently holds exactly this version's content on the same map. */
  matchesDraft: boolean;
};

export type ScenarioVersionsDto = {
  documentId: string;
  draftVersion: number;
  /** The engine this host simulates with now. */
  currentEngineSemVer: string;
  draft: { lastSimKey: string | null; lastSimEngineSemVer: string | null; lastSimDraftVersion: number | null };
  /** Newest first. */
  versions: ScenarioVersionDto[];
};

/**
 * The draft's authoritative result changed under an unchanged draft: the engine (or the simulation
 * pipeline) moved. `previous` is what the author last saw (`drafts.last_sim_key`); keeping it
 * freezes the draft into a version bound to that result.
 */
export type ScenarioEngineChangeDto = {
  previous: { simKey: string; engineSemVer: string };
  current: { simKey: string; engineSemVer: string };
  motionDiff: SimulationMotionDiffDto;
};

/** Both simulations side by side (frames in the `DualTracePlaybackData` shape: base = canonical). */
export type SimulationComparisonDto = {
  base: { simKey: string; engineSemVer: string };
  candidate: { simKey: string; engineSemVer: string };
  diff: SimulationMotionDiffDto;
  playback: {
    sampleHz: number;
    durationS: number;
    frames: Array<{
      t: number;
      actors: Record<string, {
        canonical: { x: number; y: number; z: number; headingRad: number; present: boolean } | null;
        external: { x: number; y: number; z: number; headingRad: number; present: boolean } | null;
        positionErrorM: number | null;
      }>;
    }>;
  };
};

/** The draft's map pin and whether a newer publication of the same map exists. */
export type ScenarioMapPinStatusDto = {
  pinned: { mapVersionId: string; name: string; publishedAt: string; retired: boolean } | null;
  /** A newer publication the author may explicitly move to (never automatic). */
  newer: { mapVersionId: string; name: string; publishedAt: string } | null;
  /** Why moving is not offered even though a newer publication exists (e.g. the road geometry differs). */
  newerUnavailable: { code: string; message: string } | null;
};

/** The draft simulated on another map version, compared with what it shows now. */
export type ScenarioMapRepinPreviewDto = {
  target: { mapVersionId: string; name: string; publishedAt: string };
  status: ScenarioSimulationStatusDto;
  /** Against the draft's current result; null until the target simulation succeeds. */
  motionDiff: SimulationMotionDiffDto | null;
};

export type CreateScenarioRevisionResultDto = {
  revisionId: string;
  exportId: string;
  exportStatus: ScenarioExportStatus;
  revision: ScenarioRevisionDto;
};

export type ScenarioConflictDto = {
  error: "draft_version_conflict";
  refetch: true;
  currentDraftVersion: number;
  current: ScenarioDocumentDto;
};

// ── Artifacts, exports, maps ─────────────────────────────────────────────────

export type ScenarioExportStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type ScenarioExportDto = {
  id: string;
  revisionId: string;
  format: "openscenario_xml_1_4";
  status: ScenarioExportStatus;
  artifactId: string | null;
  executionPackageId: string | null;
  compilerVersion: string;
  errorCode: string | null;
  errorDetail: unknown;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

/** Exact compiler evidence for one completed OpenSCENARIO export. */
export type ScenarioExportInspectionDto = {
  exportId: string;
  revisionId: string;
  executionPackageId: string;
  executionPackageSha256: string;
  compilerVersion: string;
  capabilityProfile: string;
  xoscArtifactId: string;
  xoscSha256: string;
  xsdValidation: {
    valid: boolean;
    standard: string;
    xsdSha256: string;
    diagnostics: string[];
  };
  capability: {
    contract: string;
    profile: string;
    intent: string;
    roundTrip: string;
    externalSimulatorValidation: string;
    summary: Record<string, number>;
    warningCount: number;
    /** Plain compiler-authored losses or approximations bound to this exact package. */
    warnings: Array<{ code: string; path: string; reason: string }>;
  };
};

export type ScenarioArtifactDto = {
  id: string;
  revisionId: string | null;
  kind: string;
  mediaType: string;
  sha256: string;
  sizeBytes: number;
  metadata: Record<string, unknown>;
  downloadUrl: string;
  downloadExpiresAt: string;
  createdAt: string;
};

export type ScenarioMapDescriptorDto = {
  mapVersionId: string;
  /** FK-backed `map_versions.source_map_asset_id`: full timestamped `public.map_assets.id`, never a logical display slug. */
  sourceMapId: string;
  label: string;
  locality: string | null;
  /** Stable route root for every member of this immutable browser bundle. */
  browserAssetRootUrl: string;
  browserManifestUrl: string;
  /** Identity of the complete published browser member closure. */
  browserClosureSha256: string;
  artifacts: {
    xodrSha256: string;
    topologySha256: string;
    derivedTopologySha256: string;
    locationsSha256: string;
    signalsSha256: string;
    lanePolygonsSha256: string;
  };
  /** Digest of the network bytes referenced by the optional SUMO manifest. */
  sumoNetworkSha256: string | null;
  /** SUMO derivative state and, when unavailable, the reason to show. */
  sumoStatus?: { state: string; reason: string | null } | null;
  /**
   * The published ambient turn-verdict table (`derived/ambient/turn-verdicts.json.gz`
   * in the browser closure), when this version ships one: the engine
   * semantics and simulation closure it was built for. Absent from older servers.
   */
  ambientTurnVerdicts?: { engineSemVer: string; closureDigest: string; sha256: string } | null;
  topologyArtifactUrl: string;
  /** Presigned gzipped derived topology; null when the map version has no available artifact. */
  derivedTopologyUrl: string | null;
  /** Presigned gzipped locations; null when the map version has no available artifact. */
  locationsUrl: string | null;
  /** Presigned SUMO network; null when the map version has no matching available artifact. */
  sumoNetworkUrl: string | null;
  /** Stable first-party route for the independently versioned preview artifact. */
  thumbnailUrl: string | null;
  /**
   * Presigned `signals.geojson`, or null when the map version publishes none.
   * Presigned per request like the other artifact URLs here, never cached
   * beyond the shared-read window.
   */
  signalsArtifactUrl: string | null;
  xodr: { artifactId: string; sha256: string };
  coordinateSystem: { id: string; sha256: string };
};

/**
 * Where an installed map sits on Earth: its OpenDRIVE extents rectangle
 * projected to WGS84, for drawing scenario coverage on a 2D basemap.
 */
export type ScenarioMapFootprintDto = {
  mapVersionId: string;
  sourceMapId: string;
  /** Closed ring of `[lon, lat]` degrees (first point repeated last). */
  polygon: Array<[number, number]>;
  /** Centre of the footprint, `[lon, lat]`. */
  center: [number, number];
};

/**
 * Scenario coverage: the maps that can be drawn, and the installed maps that
 * cannot, each with the reason. An installed map is never silently absent.
 */
export type ScenarioMapCoverageDto = {
  footprints: ScenarioMapFootprintDto[];
  /** Installed maps with no drawable footprint, e.g. `no georeference`. */
  unprojected: Array<{ mapVersionId: string; sourceMapId: string; reason: string }>;
};

// ── Jobs: render jobs, validation runs, operational jobs ────────────────────

export type ScenarioRenderJobStatus = "queued" | "leased" | "running" | "succeeded" | "failed" | "cancelled";

export type ScenarioRenderJobDto = {
  id: string;
  revisionId: string;
  executionPackageId: string;
  originRecordingJobId: string | null;
  mode: ScenarioJobMode;
  status: ScenarioRenderJobStatus;
  progress: number;
  billingMode: "free";
  estimatedCost: 0;
  /** The canonical render-spec/v3 the job was submitted with; null for sensor-free interaction jobs. */
  renderSpec: RenderSpecV3 | null;
  telemetry: { gpuSeconds?: number; wallSeconds?: number; storageBytes?: number; outputBytes?: number };
  parityResult: Record<string, unknown> | null;
  parityEvidence: Record<string, unknown> | null;
  resourceRequest: Record<string, unknown> | null;
  /** Sanitized product signal. Raw node, GPU and host attestation stays attempt-internal. */
  workerAttestation: Record<string, unknown> | null;
  failureCode: string | null;
  failureDetail: unknown;
  /**
   * The authoritative simulation this render replays: the trace (and render
   * timeline, once derived) every renderer samples. Absent on jobs submitted
   * before worker-authoritative simulation.
   */
  simulation?: {
    simKey: string;
    traceSha256: string;
    timelineSha256: string | null;
    /** The engine semantics the replayed motion was simulated under. */
    engineSemVer?: string | null;
  } | null;
  /** Which motion the render replayed; null on jobs submitted before this was recorded. */
  motionSource?: ScenarioMotionSource | null;
  createdAt: string;
  updatedAt: string;
};

export type ScenarioJobProvenanceDto = {
  documentId: string;
  revisionId: string;
  revisionNumber: number;
  sourceRevisionSha256: string;
  /** Canonical concrete simulation input hash bound into the XOSC and execution evidence. */
  sourceInputDigest: string | null;
  openScenarioProfile: typeof OPENSCENARIO_NATIVE_PROFILE;
  compilerVersion: string;
  validationStatus: string | null;
  xoscArtifactId: string;
  xoscSha256: string;
  executionPackageId: string;
  executionPackageSha256: string;
  mapVersionId: string;
  xodrSha256: string;
  assetCatalogSha256: string | null;
  coordinateSystemId: string;
  coordinateSystemSha256: string;
  ambient: Record<string, unknown>;
  capabilityWarnings: unknown[];
  artifacts: Array<{
    id: string;
    kind: string;
    sha256: string;
    sizeBytes: number;
    mediaType: string;
    metadata: Record<string, unknown>;
  }>;
  events: Array<{ sequence: number; type: string; occurredAt: string; payload: Record<string, unknown> }>;
};

/** One `validation_runs` row, as returned by `/api/simforge/validation-runs`. */
export type ScenarioValidationRunDto = {
  id: string;
  revision_id: string;
  validator_kind: string;
  validator_version: string;
  validation_state: string;
  report_artifact_id: string | null;
  trace_artifact_id: string | null;
  summary: Record<string, unknown> | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
};

export type ScenarioOperationalJobBase = {
  id: string;
  type: string;
  status: string;
  priority: number;
  progress: number;
  attemptCount: number;
  maxAttempts: number;
  cancelRequestedAt: string | null;
  failureCode: string | null;
  failureDetail: unknown;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

/**
 * One row of the product-facing operational job ledger (`/api/simforge/jobs`).
 *
 * Discriminated on `family` because `revisionId` is not optional data — it is
 * present or absent according to what a family is *about*, and the ledger is a
 * view (`simforge.operational_jobs`) assembled from four different relations.
 *
 * Three families are each one relation whose `revision_id` is `NOT NULL`, so
 * they always carry a revision: `openscenario_compile` from `exports`,
 * `openscenario_validate` from `validation_runs`, `openscenario_render` from
 * `render_jobs`. A job in those families is *produced from* one immutable
 * revision; that is what makes it that kind of job.
 *
 * `artifact_postprocess` is the one family the view assembles from two
 * relations, and the only one that can answer `null`:
 *   - `render_jobs` rows whose `job_mode` is `cosmos_augment`/`vlm_annotate` —
 *     a pass *over an existing render*, so still revision-bound (`NOT NULL`);
 *   - `artifact_postprocess_jobs`, whose `revision_id` has no `NOT NULL`,
 *     because the family also covers work whose subject is not a revision at
 *     all. An `editor_asset_release` job publishes an editor asset catalogue
 *     identified by a release-manifest digest (`simforge.editor-assets-release/v1`);
 *     it is not produced from a revision, so its insert omits the column
 *     entirely rather than leaving it to be filled in later. `dataset_export`
 *     is scoped to a dataset, for the same structural reason (historical
 *     `openscenario_import` rows, from the retired OpenSCENARIO import, also
 *     predate any revision).
 *
 * Not discriminated any deeper. `type` (the view's alias for
 * `postprocess_kind`) does decide whether a postprocess job has a revision,
 * but it is `TEXT` with no `CHECK` — an open vocabulary, nine values across the
 * family today. Closing it into a second union would make a host that adds a
 * postprocess kind fail decoding, and the protocol's rule is that adding is
 * compatible (see `protocol/schema`). So within this family `revisionId` is
 * genuinely unknown to the client, and `null` is the honest answer rather than
 * a nullable field standing in for a union.
 */
export type RevisionBoundJobFamily = Exclude<ScenarioJobFamily, "artifact_postprocess">;
export type ScenarioOperationalJobDto =
  | { [F in RevisionBoundJobFamily]: ScenarioOperationalJobBase & { family: F; revisionId: string } }[RevisionBoundJobFamily]
  | (ScenarioOperationalJobBase & { family: "artifact_postprocess"; revisionId: string | null });

/**
 * The body of `POST /api/simforge/render-jobs`. Each host validates the full
 * submission with its own render-wire schema; the shared client only needs the
 * identity fields to submit it.
 *
 * Identity is the caller's `idempotencyKey`, scoped to the workspace: the host
 * returns the existing job for a repeated key and rejects the key when the
 * revision, execution package, engine or render spec differ. The immutable
 * intent id is minted by the host when it materializes the intent, so it is
 * never part of the submission.
 */
export type ScenarioRenderIntentSubmission = {
  schema: string;
  revisionId: string;
  executionPackageId: string;
  engine: ScenarioRendererEngine;
  renderProfile?: "render" | "ml";
  nativeVramBudgetBytes?: number;
  idempotencyKey: string;
  /** Absent means `original`: the revision's active simulation, never an implicit re-simulation. */
  motionSource?: ScenarioMotionSource;
  /** With `motionSource: "resimulated"`: which of the revision's results to render. */
  simKey?: string;
  [key: string]: unknown;
};

// ── Render gallery, detail, artifacts, postprocess ──────────────────────────

/**
 * Stable artifact tuple identity. Sensor-scoped roles (`video`, `frames`,
 * `sensorArchive`, `sensorData`) carry actor/sensor/modality; global roles
 * (`manifest`, `trace`, `annotations`, `diagnostics`) carry nulls.
 */
export type ScenarioArtifactIdentityDto = {
  role: string;
  actorId: string | null;
  sensorId: string | null;
  modality: string | null;
};

export type ScenarioRenderStage = "downloading" | "preparing" | "rendering" | "encoding" | "uploading" | "finalizing";

type RenderProgressBase = {
  schema: string;
  jobId: string;
  attempt: number;
  sequence: number;
  timestamp: string;
};

/** One worker progress record as the detail route republishes it. */
export type ScenarioRenderProgressDto =
  | (RenderProgressBase & { event: "job.started" })
  | (RenderProgressBase & { event: "stage.started"; stage: ScenarioRenderStage })
  | (RenderProgressBase & {
      event: "stage.progress";
      stage: ScenarioRenderStage;
      completed: number;
      total: number;
      unit: "frames" | "bytes" | "items" | "seconds";
      downloadedBytes?: number;
      totalBytes?: number;
    })
  | (RenderProgressBase & {
      event: "artifact.ready";
      identity: ScenarioArtifactIdentityDto;
      sha256: string;
      sizeBytes: number;
      mediaType: string;
    })
  | (RenderProgressBase & { event: "warning"; code: string; message: string })
  | (RenderProgressBase & { event: "job.canceled"; reason: string });

/** Job states the worker control plane advances. Mirrors `render_jobs.job_state`. */
export type ScenarioRenderJobState = ScenarioRenderJobStatus;

/**
 * Every value `render_jobs.job_mode` may hold. The last two are postprocess
 * modes, which is why the view files them under `artifact_postprocess`.
 *
 * A runtime array rather than a bare union, because callers need to *test* a
 * string against this vocabulary — a query filter, a decoder — and every site
 * that re-spelled the list instead drifted from it. One such copy silently
 * dropped `browser_render`, turning `?jobMode=browser_render` into an
 * unfiltered gallery.
 */
export const SCENARIO_RENDER_JOB_MODES = [
  ...SCENARIO_JOB_MODES,
  "cosmos_augment",
  "vlm_annotate",
] as const;
export type ScenarioRenderJobMode = (typeof SCENARIO_RENDER_JOB_MODES)[number];

/** A gallery tile. Deliberately narrow: the list must not carry render specs or telemetry blobs. */
export type ScenarioGalleryItemDto = {
  id: string;
  revisionId: string;
  documentId: string | null;
  jobMode: ScenarioRenderJobMode;
  rendererEngine: ScenarioRendererEngine | null;
  jobState: ScenarioRenderJobState;
  /** 0-100 where the worker reports it, else null. Advanced by the worker; never cached. */
  progressPercent: number | null;
  failureCode: string | null;
  attemptCount: number;
  createdAt: string;
  completedAt: string | null;
  /** Postprocess lineage: set only for `cosmos_augment` / `vlm_annotate`. */
  parentRenderJobId: string | null;
  modelFamily: string | null;
  /**
   * Immutable content digest of the snapshot this render was produced from.
   * Compared against the open draft's digest to mark a tile outdated.
   */
  revisionContentSha256: string | null;
  /** The draft version the render's snapshot was frozen from. */
  revisionSourceDraftVersion: number | null;
  artifactCount: number;
  /** The preview artifact id, if one exists. Presigned separately, per request. */
  previewArtifactId: string | null;
  previewMediaType: string | null;
};

export type ScenarioRenderAttemptDto = {
  id: string;
  attemptNumber: number;
  /** Immutable digest of the exact execution controls issued with this attempt's lease. */
  executionPackageControlSha256: string;
  status: string;
  attemptState: string;
  workerNodeId: string;
  workerClass: string;
  runtimeVersion: string | null;
  rendererEngine: ScenarioRendererEngine | null;
  baseImageDigest: string | null;
  baseImagePlatformDigest: string | null;
  engineCapabilitiesSha256: string | null;
  imageDigest: string | null;
  leasedAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

export type ScenarioJobEventDto = {
  eventOrdinal: number;
  eventKind: string;
  attemptId: string | null;
  /** Public details never include the worker-controlled event payload. */
  detail: null;
  createdAt: string;
};

/** One artifact row. `url` is absent by design — only `[jobId]/downloads` signs. */
export type ScenarioRenderArtifactDto = {
  id: string;
  artifactKind: string;
  mediaType: string;
  byteLength: number;
  sha256: string;
  /** `pending` | `available` | `quarantined` | `deleted`. Advanced by the verification worker. */
  artifactState: string;
  relationship: string | null;
  renderAttemptId: string | null;
  identity: ScenarioArtifactIdentityDto | null;
  /** Human sensor name from the immutable render revision, never an identifier. */
  sensorLabel?: string | null;
  /** Simulated clip duration, absent for non-temporal evidence. */
  durationSeconds?: number | null;
  createdAt: string;
  verifiedAt: string | null;
};

/** An artifact paired with a freshly minted, short-lived URL. Never cached, never persisted. */
export type ScenarioPresignedArtifactDto = ScenarioRenderArtifactDto & {
  url: string;
  /** Seconds until the signature expires, from the moment this object was built. */
  expiresInSeconds: number;
};

export type ScenarioRenderJobDetailDto = {
  id: string;
  revisionId: string;
  executionPackageId: string;
  /** Immutable digest shared by every authoritative attempt issued for this job. */
  executionPackageControlSha256: string;
  renderProfileId: string | null;
  jobMode: ScenarioRenderJobMode;
  jobState: ScenarioRenderJobState;
  progressPercent: number | null;
  progressDetail: ScenarioRenderProgressDto | null;
  /** Latest durable record per worker stage for the current attempt. */
  progressRecords?: ScenarioRenderProgressDto[];
  rendererEngine: ScenarioRendererEngine | null;
  intentSha256: string | null;
  priority: number;
  attemptCount: number;
  maxAttempts: number;
  failureCode: string | null;
  failureDetail: string | null;
  billingMode: string;
  estimatedCostCents: number;
  renderSpecSha256: string;
  hiddenAt: string | null;
  hiddenByUserId: string | null;
  parentRenderJobId: string | null;
  sourceArtifactId: string | null;
  modelFamily: string | null;
  modelConfigSha256: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  cancelRequestedAt: string | null;
  /**
   * Where the rendered motion came from. `source` is null on jobs submitted
   * before it was recorded (those re-simulated under the engine current at
   * submission); `engineSemVer` is the engine that simulated the replayed
   * trace, null for the legacy OpenSCENARIO replay.
   */
  motion?: { source: ScenarioMotionSource | null; engineSemVer: string | null; simKey: string | null; traceSha256: string | null } | null;
  attempts: ScenarioRenderAttemptDto[];
  events: ScenarioJobEventDto[];
  artifacts: ScenarioRenderArtifactDto[];
};

export type ScenarioPostprocessInput = {
  parentRenderJobId: string;
  sourceArtifactId: string;
  jobMode: Extract<ScenarioRenderJobMode, "cosmos_augment" | "vlm_annotate">;
  modelFamily: string;
  modelConfig: Record<string, unknown>;
  idempotencyKey: string;
  priority?: number;
};

/** An artifact from `[jobId]/downloads` — the one route that signs. */
export type PresignedArtifact =
  | ScenarioPresignedArtifactDto
  | (ScenarioRenderArtifactDto & { url: null });

/** An artifact from `artifact-index` or `[jobId]/detail` — metadata only, no URL, by design. */
export type ArtifactMetadata = ScenarioRenderArtifactDto & {
  url?: undefined;
  expiresInSeconds?: undefined;
};

/** An artifact from `artifact-index` — the home's browse index, metadata only. */
export type IndexedArtifact = ScenarioRenderArtifactDto & { renderJobId: string | null };

/** Either shape. Components that only display metadata accept both. */
export type DisplayArtifact = PresignedArtifact | ArtifactMetadata | IndexedArtifact;

// ── Map version transition ───────────────────────────────────────────────────
//
// "Move to new map version": the plan the transition view draws before the draft moves
// (studio/app/lib/scenario/map-transition.ts). Every coordinate is xodr-local metres,
// `x` east and `y` north; a heading is radians CCW from +x (the scene heading).

export type ScenarioMapTransitionPoseDto = {
  x: number;
  y: number;
  headingRad: number;
  /** Ground height of the placement: authored before, from the new map's ground after. Null when not map-bound. */
  elevationM: number | null;
};

export type ScenarioMapTransitionPlacementStatus = "kept" | "moved" | "flagged" | "unplaced";

export type ScenarioMapTransitionPlacementDto = {
  roleId: string;
  label: string;
  /** The actor class (`car`, `pedestrian`, ...). */
  kind: string;
  /** The role the scenario measures. */
  isSubject: boolean;
  /** Compiled start pose on the current map version. */
  before: ScenarioMapTransitionPoseDto | null;
  /** Start pose on the new map version; null when it has none there. */
  after: ScenarioMapTransitionPoseDto | null;
  displacementM: number | null;
  /** Largest distance between the old and new route over its first metres; null without a route on both sides. */
  routeDeviationM: number | null;
  status: ScenarioMapTransitionPlacementStatus;
  /** Why it moved, was flagged or could not be placed, in the user's words; null when kept. */
  reason: string | null;
};

export type ScenarioMapTransitionRoadChange = "none" | "elevation" | "geometry" | "added" | "removed";

export type ScenarioMapTransitionRoadDto = {
  roadId: string;
  change: ScenarioMapTransitionRoadChange;
  /** Lane centrelines on the current version (empty for an added road). */
  before: Array<Array<[number, number]>>;
  /** Lane centrelines on the new version (empty for a removed road). */
  after: Array<Array<[number, number]>>;
};

export type ScenarioMapTransitionPlanDto = {
  /** `same`: byte-identical OpenDRIVE or equal `xodrGeometrySha256`; placements carry over as they are. */
  geometry: "same" | "changed";
  source: { mapVersionId: string; name: string; publishedAt: string };
  target: { mapVersionId: string; name: string; publishedAt: string };
  /** The draft content to save on the target version; null when blocked. */
  content: ScenarioTemplateV2 | null;
  placements: ScenarioMapTransitionPlacementDto[];
  /** Roads near the scenario (the placements' extent plus a margin), for drawing; nearest first. */
  roads: ScenarioMapTransitionRoadDto[];
  /** More roads were near the scenario than are listed. */
  roadsTruncated: boolean;
  /** The thresholds the statuses were judged by, metres. */
  tolerances: { keptM: number; movedM: number; laneSearchM: number; routeMatchM: number; siteMatchM: number };
  blocking: { code: string; message: string } | null;
};
