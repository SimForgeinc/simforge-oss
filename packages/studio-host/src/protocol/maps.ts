import type {
  IndexedArtifact,
  ScenarioArtifactDto,
  ScenarioArtifactIdentityDto,
  ScenarioMapCoverageDto,
  ScenarioMapDescriptorDto,
  ScenarioMapFootprintDto,
  ScenarioRenderArtifactDto,
} from "../contracts";
import { endpoint } from "./endpoint";
import { array, nullable, number, object, oneOf, optional, passthrough, record, string, tuple, type Shape } from "./schema";

// ── DTO decoders ─────────────────────────────────────────────────────────────

export const ScenarioMapDescriptorSchema = object<ScenarioMapDescriptorDto>({
  mapVersionId: string(),
  sourceMapId: string(),
  label: string(),
  locality: nullable(string()),
  browserAssetRootUrl: string(),
  browserManifestUrl: string(),
  browserClosureSha256: string(),
  artifacts: object({
    xodrSha256: string(),
    topologySha256: string(),
    derivedTopologySha256: string(),
    locationsSha256: string(),
    signalsSha256: string(),
    lanePolygonsSha256: string(),
  }),
  sumoNetworkSha256: nullable(string()),
  sumoStatus: optional(nullable(object({ state: string(), reason: nullable(string()) }))),
  ambientTurnVerdicts: optional(nullable(object({ engineSemVer: string(), closureDigest: string(), sha256: string() }))),
  ground: optional(nullable(object({
    sha256: string(),
    status: oneOf(['ok', 'flagged', 'no-xodr', 'unreported'] as const),
    flags: array(string()),
    warnings: array(string()),
  }))),
  topologyArtifactUrl: string(),
  derivedTopologyUrl: nullable(string()),
  locationsUrl: nullable(string()),
  sumoNetworkUrl: nullable(string()),
  thumbnailUrl: nullable(string()),
  signalsArtifactUrl: nullable(string()),
  xodr: object({ artifactId: string(), sha256: string() }),
  coordinateSystem: object({ id: string(), sha256: string() }),
});

const lonLat = tuple([number(), number()]);

export const ScenarioMapFootprintSchema = object<ScenarioMapFootprintDto>({
  mapVersionId: string(),
  sourceMapId: string(),
  polygon: array(lonLat),
  center: lonLat,
});

export const ScenarioMapCoverageSchema = object<ScenarioMapCoverageDto>({
  footprints: array(ScenarioMapFootprintSchema),
  unprojected: array(object({ mapVersionId: string(), sourceMapId: string(), reason: string() })),
});

export const ScenarioArtifactSchema = object<ScenarioArtifactDto>({
  id: string(),
  revisionId: nullable(string()),
  kind: string(),
  mediaType: string(),
  sha256: string(),
  sizeBytes: number(),
  metadata: record(passthrough<unknown>()),
  downloadUrl: string(),
  downloadExpiresAt: string(),
  createdAt: string(),
});

export const ScenarioArtifactIdentitySchema = object<ScenarioArtifactIdentityDto>({
  role: string(),
  actorId: nullable(string()),
  sensorId: nullable(string()),
  modality: nullable(string()),
});

/** Shared by `artifact-index`, `[jobId]/detail` and `[jobId]/downloads` rows. */
export const renderArtifactShape: Shape<ScenarioRenderArtifactDto> = {
  id: string(),
  artifactKind: string(),
  mediaType: string(),
  byteLength: number(),
  sha256: string(),
  artifactState: string(),
  relationship: nullable(string()),
  renderAttemptId: nullable(string()),
  identity: nullable(ScenarioArtifactIdentitySchema),
  sensorLabel: optional(nullable(string())),
  durationSeconds: optional(nullable(number())),
  createdAt: string(),
  verifiedAt: nullable(string()),
};

export const ScenarioRenderArtifactSchema = object(renderArtifactShape);

export const IndexedArtifactSchema = object<IndexedArtifact>({
  ...renderArtifactShape,
  renderJobId: nullable(string()),
});

// ── Endpoints ────────────────────────────────────────────────────────────────

export type GetArtifactQuery = { download?: 1 };
export type ListArtifactIndexQuery = { artifactKind?: string | null; limit?: number };

/**
 * `maps` group, protocol v1: the editor map catalog, coverage footprints and
 * artifact metadata/URL resolution. Map bytes (`maps/:id/browser-assets/*`,
 * `semantic-assets/*`, `thumbnail`) are streaming endpoints addressed by the
 * URLs these descriptors carry; they are deliberately not schematized here.
 */
export const mapsProtocol = {
  list: endpoint<void, void, void, { maps: ScenarioMapDescriptorDto[] }>({
    method: "GET",
    path: "/api/simforge/maps",
    response: object({ maps: array(ScenarioMapDescriptorSchema) }),
  }),
  footprints: endpoint<void, void, void, ScenarioMapCoverageDto>({
    method: "GET",
    path: "/api/simforge/maps/footprints",
    response: ScenarioMapCoverageSchema,
  }),
  /** Resolve one artifact to a short-lived URL; `download=1` asks for an attachment disposition. */
  getArtifact: endpoint<{ artifactId: string }, GetArtifactQuery, void, ScenarioArtifactDto>({
    method: "GET",
    path: ({ artifactId }) => `/api/simforge/artifacts/${encodeURIComponent(artifactId)}`,
    response: ScenarioArtifactSchema,
  }),
  /** The workspace's render artifacts, metadata only — no URLs by design. */
  artifactIndex: endpoint<void, ListArtifactIndexQuery, void, { items: IndexedArtifact[] }>({
    method: "GET",
    path: "/api/simforge/render-jobs/artifact-index",
    response: object({ items: array(IndexedArtifactSchema) }),
  }),
} as const;
