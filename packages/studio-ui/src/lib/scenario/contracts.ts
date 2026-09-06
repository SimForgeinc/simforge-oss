import { SCENARIO_TEMPLATE_VERSION } from "@simforge-oss/scenario";
import type {
  ScenarioAmbientProvenanceDto,
  ScenarioAuthoringQuality,
  ScenarioMaterializedTrafficReferenceDto,
} from "@simforge-oss/studio-host";

/**
 * Wire DTOs and enumerations are owned by `@simforge-oss/studio-host`; this
 * module carries the product-side constants every host and every shared screen
 * agree on. Request validation schemas stay with the host that serves them.
 */
export {
  DEFAULT_SCENARIO_AUTHORING_QUALITY_ID,
  OPENSCENARIO_NATIVE_PROFILE,
  SCENARIO_AUTHORING_QUALITY_IDS,
  SCENARIO_DATASET_VISIBILITIES,
  SCENARIO_JOB_MODES,
  SCENARIO_RATING_REVIEWED_VIA,
} from "@simforge-oss/studio-host";
export type {
  CreateScenarioRevisionResultDto,
  ScenarioArtifactDto,
  ScenarioAuthoringQuality,
  ScenarioConflictDto,
  ScenarioDatasetDto,
  ScenarioDatasetReadinessDto,
  ScenarioDatasetVisibility,
  ScenarioDocumentDto,
  ScenarioDocumentRatingDto,
  ScenarioDocumentSummaryDto,
  ScenarioDocumentSummaryPageDto,
  ScenarioExportDto,
  ScenarioJobMode,
  ScenarioJobProvenanceDto,
  ScenarioMapDescriptorDto,
  ScenarioRatingAggregateDto,
  ScenarioRenderJobDto,
  ScenarioRevisionDto,
  ScenarioSimulationPreviewDto,
  ScenarioTagDto,
} from "@simforge-oss/studio-host";

export type ScenarioAmbientProvenance = ScenarioAmbientProvenanceDto;
export type ScenarioMaterializedTrafficReference = ScenarioMaterializedTrafficReferenceDto;

export const SCENARIO_SCHEMA_VERSION = String(SCENARIO_TEMPLATE_VERSION);
export const SCENARIO_RENDER_CONTRACT_VERSION = "2.0.0";
export const EMPTY_AMBIENT_CONFIG_SHA256 = "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";
export const EMPTY_AMBIENT_RESULT_SHA256 = "1925590408012373ea3cc6b9d02703527531492efb52aa39689d541a0581f840";

export const DISABLED_AMBIENT_PROVENANCE = {
  mode: "disabled",
  ambientConfig: {},
  configSha256: EMPTY_AMBIENT_CONFIG_SHA256,
  resultSha256: EMPTY_AMBIENT_RESULT_SHA256,
} as const satisfies ScenarioAmbientProvenance;

export const SCENARIO_AUTHORING_QUALITY_CHOICES = [
  { id: "roads-only", label: "Roads Only", guidance: "CPU/software-rendering mode. Keeps 3D roads, every lane marking, signals and actors; city, vegetation and decorative street furniture are not downloaded.", downloadGuidance: "Measured cold load: 11–14 MB", gpuMemoryGuidance: "Resident estimate: 1–6 MB · 0 GB dedicated GPU required", recommended: false },
  { id: "ultra-low-3d", label: "Low", guidance: "Real navigable 3D roads, buildings and actors with flat unlit colors, no textures, lighting, environment, vegetation or nonessential overlays.", downloadGuidance: "Measured cold load: 18–58 MB", gpuMemoryGuidance: "Resident estimate: 11–47 MB · 1 GB GPU recommended", recommended: false },
  { id: "minimal", label: "Balanced", guidance: "Road and coarse city context only: no vegetation, low resolution, and very restrained streaming.", downloadGuidance: "Measured cold load: 45–534 MB", gpuMemoryGuidance: "Resident estimate: 370–640 MB · 2 GB GPU recommended", recommended: true },
  { id: "high", label: "High", guidance: "Sharper viewport with a larger resident scene.", downloadGuidance: "Measured cold load: 44–816 MB", gpuMemoryGuidance: "Resident estimate: 377–1,601 MB · 4 GB GPU recommended", recommended: false },
] as const satisfies ReadonlyArray<{ id: ScenarioAuthoringQuality; label: string; guidance: string; downloadGuidance: string; gpuMemoryGuidance: string; recommended: boolean }>;
