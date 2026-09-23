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
  { id: "low", label: "Low", guidance: "The same sky, lighting and vegetation with smaller compressed textures: 256 px target and a 640 MiB scene budget. Device-pressure downgrades are reported.", downloadGuidance: "Smaller 256 px UASTC textures; same sky, lighting and vegetation", gpuMemoryGuidance: "640 MiB scene budget · 2 GB GPU recommended", recommended: true },
  { id: "medium", label: "Medium", guidance: "512 px texture target with a 1.5 GiB scene budget. Weaker devices may select Low and report it.", downloadGuidance: "Published 512 px BC7 or ASTC textures when supported; portable UASTC otherwise", gpuMemoryGuidance: "1.5 GiB scene budget · 4 GB GPU recommended", recommended: false },
] as const satisfies ReadonlyArray<{ id: ScenarioAuthoringQuality; label: string; guidance: string; downloadGuidance: string; gpuMemoryGuidance: string; recommended: boolean }>;
