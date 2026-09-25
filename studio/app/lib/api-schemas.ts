/**
 * Zod schemas used for OpenAPI documentation.
 * Exported here so route files only export HTTP handlers (GET, POST, etc.) and stay valid Next.js routes.
 */
import {
  z } from "zod";
import {
  MapAssetSchema,
  CandidateLocationSchema,
} from "@simforge-oss/studio-shared";

// ---- Path params ----
export const MapAssetIdParams = z.object({ mapAssetId: z.string().describe("Map asset identifier") });

// ---- Query params ----
export const MediaQueryParams = z.object({
  key: z.string().describe("S3 object key, e.g. runs/{runId}/file.mp4 or maps/{id}/file.mp4"),
});

// ---- Map assets ----
export const MapAssetsListResponse = z.array(MapAssetSchema);
export const CreateMapAssetResponse = z.object({ mapAssetId: z.string() });
export const UpdateMapAssetResponse = z.object({ mapAssetId: z.string() });

// ---- Map assets: single-file upload URL ----
export const UploadUrlBody = z.object({
  mapAssetId: z.string().describe("Map asset identifier"),
  fileId: z.string().describe("File slot ID (e.g. 'geojson', 'xodr', 'rrdata_xml', 'artifact-0')"),
  filename: z.string().describe("Original filename with extension"),
  contentType: z.string().optional().describe("MIME type (default application/octet-stream)"),
});
export const UploadUrlResponse = z.object({
  url: z.string().describe("Presigned S3 PUT URL (valid 15 min)"),
  key: z.string().describe("S3 object key"),
});

// ---- Map assets: upload-urls (initial upload with all required files) ----
export const UploadUrlsBody = z.object({
  mapAssetId: z.string().describe("Map asset identifier"),
  name: z.string().describe("Display name for the map asset"),
  description: z.string().optional().describe("Optional description"),
  crs: z.string().optional().describe("Coordinate reference system (default EPSG:4326)"),
  tags: z.array(z.string()).optional().describe("Optional tags"),
  mapCenter: z.object({ lat: z.number(), lng: z.number() }).optional().describe("Map center point"),
  bbox: z.object({ min_lat: z.number(), min_lng: z.number(), max_lat: z.number(), max_lng: z.number() }).optional().describe("Bounding box"),
  files: z.array(z.object({
    id: z.string().describe("File slot ID"),
    filename: z.string().describe("Original filename"),
    contentType: z.string().optional().describe("MIME type"),
  })).describe("Files to upload"),
});
export const UploadUrlsResponse = z.object({
  uploads: z.array(z.object({
    id: z.string(),
    url: z.string().describe("Presigned S3 PUT URL"),
    key: z.string().describe("S3 object key"),
  })),
  mapAssetId: z.string(),
});

// ---- Map assets: complete (finalize after upload) ----
export const CompleteMapAssetBody = z.object({
  mapAssetId: z.string().describe("Map asset identifier"),
  name: z.string().describe("Display name"),
  description: z.string().optional().describe("Optional description"),
  carlaMapName: z.string().nullish().describe("CARLA simulator map name for this asset"),
  crs: z.string().optional().describe("Coordinate reference system (default EPSG:4326)"),
  tags: z.array(z.string()).optional().describe("Optional tags"),
  mapCenter: z.object({ lat: z.number(), lng: z.number() }).describe("Map center point"),
  bbox: z.object({ min_lat: z.number(), min_lng: z.number(), max_lat: z.number(), max_lng: z.number() }).describe("Bounding box"),
  artifacts: z.array(z.object({
    key: z.string().describe("S3 object key"),
    artifact_type: z.string().describe("Type: geojson, xodr, rrdata_xml, fbx, mp4, image"),
    sha256: z.string().describe("SHA-256 hash of the uploaded file"),
  })).describe("Uploaded artifact metadata"),
});

// ---- Map assets: media upload URLs (add videos/images to existing map) ----
export const MediaUploadUrlsBody = z.object({
  files: z.array(z.object({
    id: z.string().describe("File identifier"),
    filename: z.string().describe("Original filename"),
    contentType: z.string().optional().describe("MIME type"),
  })).describe("Media files to upload"),
});
export const MediaUploadUrlsResponse = z.object({
  uploads: z.array(z.object({
    id: z.string(),
    url: z.string().describe("Presigned S3 PUT URL"),
    key: z.string().describe("S3 object key"),
  })),
});

// ---- Map assets: 3D tile upload URLs ----
export const Upload3dUrlsBody = z.object({
  files: z.array(z.object({
    id: z.string().describe("File identifier"),
    relativePath: z.string().describe("Relative path preserving folder structure"),
    contentType: z.string().optional().describe("MIME type"),
  })).describe("3D tile files to upload"),
});
export const Upload3dUrlsResponse = z.object({
  uploads: z.array(z.object({
    id: z.string(),
    url: z.string().describe("Presigned S3 PUT URL"),
    key: z.string().describe("S3 object key"),
    contentType: z.string(),
  })),
});

// ---- Map assets: search ----
export const MapSearchRequestBody = z.object({
  query: z.string().describe("Free-text search query"),
  limit: z.number().int().positive().max(200).optional().describe("Max results to return (default 50)"),
});
export const MapSearchSuggestionsQuery = z.object({
  q: z.string().describe("In-progress query fragment"),
  limit: z.number().int().positive().max(50).optional().describe("Max suggestions to return (default 6)"),
});
const SearchFilterChipSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(["subject", "relation"]).optional(),
  operatorLabel: z.string().optional(),
  objectLabel: z.string().optional(),
});
const MapSearchDocumentGeometryRefSchema = z.object({
  kind: z.enum(["candidate", "geojson_feature", "overlay_feature", "road_aggregate"]),
  candidateId: z.string().optional(),
  geojsonFeatureId: z.number().optional(),
  geojsonFeatureIds: z.array(z.number()).optional(),
  overlayLayerId: z.string().optional(),
  overlayFeatureId: z.string().optional(),
});
const CentroidSchema = z.tuple([z.number(), z.number()]);
const TopologyPathStepSchema = z.object({
  objectId: z.string(),
  cumulativeM: z.number(),
  title: z.string().optional(),
  kind: z.string().optional(),
  centroid: CentroidSchema.optional(),
});
const RelatedObjectRefSchema = z.object({
  objectId: z.string(),
  relation: z.enum([
    "near",
    "adjacent_to",
    "within",
    "leads_to",
    "connected_to",
    "upstream_of",
    "downstream_of",
  ]),
  distance_m: z.number().optional(),
  title: z.string().optional(),
  subtype: z.string().optional(),
  objectFamily: z.enum(["junction", "street", "poi"]).optional(),
  geometryReference: MapSearchDocumentGeometryRefSchema.optional(),
  centroid: CentroidSchema.optional(),
  path: z.array(TopologyPathStepSchema).optional(),
  pathTruncated: z.boolean().optional(),
});
const MapSearchResultSchema = z.object({
  id: z.string(),
  candidateId: z.string(),
  objectFamily: z.enum(["junction", "street", "poi"]),
  subtype: z.string(),
  title: z.string(),
  description: z.string(),
  exactMapAttributes: z.array(z.string()),
  relatedObjects: z.array(z.string()),
  relatedObjectRefs: z.array(RelatedObjectRefSchema).optional(),
  scenarioTags: z.array(z.string()),
  candidateConfidence: z.number(),
  matchReasons: z.array(z.string()),
  geometryReference: MapSearchDocumentGeometryRefSchema.optional(),
  centroid: CentroidSchema.optional(),
});
const MapSearchParseHintSchema = z.object({
  code: z.string(),
  message: z.string(),
});
export const MapSearchResponse = z.object({
  query: z.string(),
  chips: z.array(SearchFilterChipSchema),
  results: z.array(MapSearchResultSchema),
  /** Leftover tokens after family + semantic aliases consume their matches.
   *  Surfaced for the in-panel debug view while search features are iterated. */
  freeText: z.array(z.string()),
  /** Diagnostics surfaced when a relation operator couldn't be fully resolved. */
  parseHints: z.array(MapSearchParseHintSchema).optional(),
});
export const MapSearchSuggestionsResponse = z.object({
  suggestions: z.array(z.object({
    id: z.string(),
    label: z.string(),
    applyValue: z.string(),
  })),
});

// ---- Map assets: reverse-geocode ----
export const ReverseGeocodeQuery = z.object({
  lat: z.number().describe("Latitude"),
  lon: z.number().describe("Longitude"),
});
export const ReverseGeocodeResponse = z.object({
  city: z.string().optional(),
  state: z.string().optional(),
  country: z.string().optional(),
  country_code: z.string().optional(),
});

// ---- Candidate locations ----
export const CandidateLocationsResponse = z.object({
  mapAssetId: z.string(),
  locations: z.array(CandidateLocationSchema),
  count: z.number(),
});
export const CandidateLocationsDeleteResponse = z.object({
  ok: z.literal(true),
  mapAssetId: z.string(),
});
