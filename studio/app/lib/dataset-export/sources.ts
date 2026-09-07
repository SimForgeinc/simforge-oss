import type { DatasetExportJob, DatasetExportScope } from "@simforge-oss/studio-shared";
import { queryRows, type SqlParams } from "@/app/lib/db/data-api";

/**
 * One artifact an export packages. Field names deliberately follow the
 * upstream export runtime's row shape so the ODVG/manifest builders and entry
 * naming stay byte-for-byte compatible with packages produced by SimCloud.
 */
export type ExportArtifact = {
  id: string;
  scenario_id: string | null;
  simulation_id: string | null;
  sensor_id: string | null;
  sequence_id: string | null;
  frame_index: number | null;
  s3_bucket: string;
  s3_key: string | null;
  s3_prefix: string | null;
  size_bytes: number | null;
  content_type: string | null;
  sensor_label: string | null;
  sensor_category: string | null;
  output_modality: string | null;
  artifact_type: string;
  /** `scenario` marks a canonical SimForge artifact; anything else is legacy. */
  artifact_family: string;
  metadata_json: string | null;
  created_at: string;
};

export type ExportScenarioDefinition = {
  id: string;
  display_name: string | null;
  status: string | null;
  source_kind: string;
  draft_json: string | null;
};

const ARTIFACT_PAGE_SIZE = 200;

/**
 * Export recipes describe artifacts with the CARLA-era class vocabulary
 * (`render_video`, `video_poster`, ...). Local renders register canonical
 * SimForge artifact kinds instead, so a class filter is widened to the local
 * kinds that carry the same content. Unknown classes keep matching kinds by
 * their literal name.
 */
const LOCAL_KIND_ALIASES: Record<string, { kinds: string[]; prefixes: string[] }> = {
  render_video: {
    kinds: ["video", "browser-threejs-recording-video-v1"],
    prefixes: ["sensorVideo:"],
  },
  video_poster: { kinds: ["browser-threejs-recording-poster-v1"], prefixes: [] },
  video_annotations: { kinds: ["annotations"], prefixes: [] },
  recording: {
    kinds: ["manifest", "browser-threejs-recording-manifest-v1"],
    prefixes: [],
  },
  render_manifest: { kinds: ["manifest"], prefixes: [] },
  metadata: { kinds: ["manifest"], prefixes: [] },
  derived: { kinds: ["manifest"], prefixes: [] },
  point_cloud: { kinds: [], prefixes: ["sensorData:"] },
};

function scopeValues(scope: DatasetExportScope | null, key: keyof DatasetExportScope): string[] {
  const raw = scope?.[key];
  return Array.isArray(raw)
    ? raw.map((value) => String(value).trim()).filter(Boolean)
    : [];
}

function expandArtifactClasses(classes: string[]) {
  const kinds = new Set<string>(classes);
  const prefixes: string[] = [];
  for (const artifactClass of classes) {
    const alias = LOCAL_KIND_ALIASES[artifactClass];
    if (!alias) continue;
    for (const kind of alias.kinds) kinds.add(kind);
    prefixes.push(...alias.prefixes);
  }
  return { kinds: [...kinds], prefixes };
}

async function pageAll<T>(
  sql: string,
  params: SqlParams,
  limitParam: string,
  offsetParam: string,
): Promise<T[]> {
  const rows: T[] = [];
  let offset = 0;
  for (;;) {
    const page = await queryRows<T>(sql, {
      ...params,
      [limitParam]: ARTIFACT_PAGE_SIZE,
      [offsetParam]: offset,
    });
    rows.push(...page);
    if (page.length < ARTIFACT_PAGE_SIZE) return rows;
    offset += page.length;
  }
}

type SourceJob = Pick<
  DatasetExportJob,
  "id" | "workspaceId" | "datasetId" | "datasetSnapshotId" | "scopeJson"
>;

/**
 * Every ready artifact the job's dataset and scope select, in creation order.
 *
 * Two legs feed the list, exactly as upstream: the legacy artifact catalog
 * (`public.artifacts`, joined to legacy scenarios) and canonical SimForge
 * artifacts produced by succeeded render jobs whose document lives in the
 * dataset or was pinned into it through `dataset_items`. Once the job has a
 * snapshot, both legs read the snapshot's immutable membership instead of the
 * live dataset, so retries and packaging see what the snapshot recorded.
 */
export async function listArtifactsForJob(job: SourceJob): Promise<ExportArtifact[]> {
  const scope = job.scopeJson ?? null;
  const search = String(scope?.search ?? "").trim().toLowerCase();
  const pipelineRunId = String(scope?.pipelineRunId ?? "").trim();
  const artifactClasses = expandArtifactClasses(scopeValues(scope, "artifactClasses"));

  const legacyClauses = [
    "a.workspace_id = :workspace_id",
    "a.status = 'ready'",
    "COALESCE(a.artifact_family, '') NOT IN ('dataset_export', 'dataset_publication', 'system')",
  ];
  const legacyParams: SqlParams = {
    workspace_id: job.workspaceId,
    dataset_id: job.datasetId,
  };
  const addLegacyArrayFilter = (key: keyof DatasetExportScope, param: string, expression: string) => {
    const values = scopeValues(scope, key);
    if (values.length === 0) return;
    legacyClauses.push(`${expression} = ANY(string_to_array(:${param}, ','))`);
    legacyParams[param] = values.join(",");
  };
  if (job.datasetSnapshotId) {
    legacyClauses.push(
      "a.id IN (SELECT artifact_id FROM dataset_snapshot_items WHERE dataset_snapshot_id = :snapshot_id)",
    );
    legacyParams.snapshot_id = job.datasetSnapshotId;
  } else {
    legacyClauses.push("sc.dataset_id = :dataset_id");
  }
  addLegacyArrayFilter("artifactIds", "artifact_ids", "a.id");
  addLegacyArrayFilter("scenarioIds", "scenario_ids", "a.scenario_id");
  addLegacyArrayFilter("storageScopes", "storage_scopes", "a.s3_bucket");
  addLegacyArrayFilter("sensorIds", "sensor_ids", "a.sensor_id");
  addLegacyArrayFilter("sensorCategories", "sensor_categories", "a.sensor_category");
  addLegacyArrayFilter("outputModalities", "output_modalities", "a.output_modality");
  addLegacyArrayFilter("artifactClasses", "artifact_classes", "a.artifact_type");
  addLegacyArrayFilter(
    "kinds",
    "kinds",
    "COALESCE(a.metadata_json->>'originalKind', a.artifact_type)",
  );
  const simulationIds = scopeValues(scope, "simulationIds");
  if (simulationIds.length > 0) {
    legacyClauses.push(
      "(a.producer_job_id = ANY(string_to_array(:simulation_ids, ',')) OR a.simulation_id = ANY(string_to_array(:simulation_ids, ',')))",
    );
    legacyParams.simulation_ids = simulationIds.join(",");
  }
  if (scope?.rawOnly === true) legacyClauses.push("a.is_raw IS DISTINCT FROM FALSE");
  if (pipelineRunId) {
    legacyClauses.push(
      "COALESCE(a.metadata_json->>'pipeline_run_id', a.metadata_json->>'pipelineRunId') = :pipeline_run_id",
    );
    legacyParams.pipeline_run_id = pipelineRunId;
  }
  if (search) {
    legacyClauses.push(`LOWER(CONCAT_WS(
      ' ', a.id, a.scenario_id, sc.display_name, a.producer_job_id, a.simulation_id,
      COALESCE(a.metadata_json->>'originalKind', a.artifact_type), a.metadata_json->>'label',
      a.content_type, a.s3_bucket, a.s3_key, a.artifact_type, a.sensor_id, a.sensor_label,
      a.sensor_category, a.output_modality, a.metadata_json->>'artifactFormat'
    )) LIKE :search_pattern`);
    legacyParams.search_pattern = `%${search}%`;
  }

  const legacy = await pageAll<ExportArtifact>(
    `SELECT a.id, a.scenario_id, a.producer_job_id AS simulation_id, a.sensor_id,
            a.sequence_id, a.frame_index, a.s3_bucket, a.s3_key, a.s3_prefix,
            a.size_bytes::bigint AS size_bytes, a.content_type, a.sensor_label,
            a.sensor_category, a.output_modality, a.artifact_type,
            COALESCE(a.artifact_family, 'legacy') AS artifact_family,
            a.metadata_json::text AS metadata_json, a.created_at::text AS created_at
       FROM public.artifacts a
       LEFT JOIN public.scenarios sc
         ON sc.id = a.scenario_id AND sc.workspace_id = a.workspace_id
      WHERE ${legacyClauses.join(" AND ")}
      ORDER BY a.created_at ASC, a.id ASC
      LIMIT :limit OFFSET :offset`,
    legacyParams,
    "limit",
    "offset",
  );

  const canonicalClauses = [
    "ua.workspace_id = :workspace_id",
    "ua.artifact_state = 'available'",
    "ua.deleted_at IS NULL",
  ];
  const canonicalParams: SqlParams = {
    workspace_id: job.workspaceId,
    dataset_id: job.datasetId,
  };
  const addCanonicalArrayFilter = (
    key: keyof DatasetExportScope,
    param: string,
    expression: string,
  ) => {
    const values = scopeValues(scope, key);
    if (values.length === 0) return;
    canonicalClauses.push(`${expression} = ANY(string_to_array(:${param}, ','))`);
    canonicalParams[param] = values.join(",");
  };
  if (job.datasetSnapshotId) {
    canonicalClauses.push("snapshot_link.dataset_snapshot_id = :canonical_snapshot_id");
    canonicalParams.canonical_snapshot_id = job.datasetSnapshotId;
  } else {
    canonicalClauses.push(
      "(document.dataset_id = :dataset_id OR dataset_item.dataset_id = :dataset_id)",
    );
  }
  addCanonicalArrayFilter("artifactIds", "canonical_artifact_ids", "ua.id");
  addCanonicalArrayFilter("scenarioIds", "canonical_scenario_ids", "document.id");
  addCanonicalArrayFilter("storageScopes", "canonical_storage_scopes", "ua.storage_bucket");
  addCanonicalArrayFilter("sensorIds", "canonical_sensor_ids", "ua.metadata->>'sensorId'");
  addCanonicalArrayFilter(
    "sensorCategories",
    "canonical_sensor_categories",
    "ua.metadata->>'sensorCategory'",
  );
  addCanonicalArrayFilter(
    "outputModalities",
    "canonical_output_modalities",
    "ua.metadata->>'outputModality'",
  );
  if (artifactClasses.kinds.length > 0) {
    const prefixClauses = artifactClasses.prefixes.map(
      (_prefix, index) => `ua.artifact_kind LIKE :canonical_kind_prefix_${index}`,
    );
    canonicalClauses.push(
      `(ua.artifact_kind = ANY(string_to_array(:canonical_artifact_classes, ','))${
        prefixClauses.length ? ` OR ${prefixClauses.join(" OR ")}` : ""
      })`,
    );
    canonicalParams.canonical_artifact_classes = artifactClasses.kinds.join(",");
    artifactClasses.prefixes.forEach((prefix, index) => {
      canonicalParams[`canonical_kind_prefix_${index}`] = `${prefix}%`;
    });
  }
  addCanonicalArrayFilter("kinds", "canonical_kinds", "ua.artifact_kind");
  addCanonicalArrayFilter("simulationIds", "canonical_simulation_ids", "render_link.render_job_id");
  if (scope?.rawOnly === true) {
    canonicalClauses.push("COALESCE(ua.metadata->>'isRaw', 'true') <> 'false'");
  }
  if (pipelineRunId) {
    canonicalClauses.push(
      "COALESCE(dataset_item.metadata->>'pipelineRunId', ua.metadata->>'pipelineRunId', ua.metadata->>'pipeline_run_id') = :canonical_pipeline_run_id",
    );
    canonicalParams.canonical_pipeline_run_id = pipelineRunId;
  }
  if (search) {
    canonicalClauses.push(`LOWER(CONCAT_WS(
      ' ', ua.id, document.id, document.title, render_link.render_job_id,
      ua.artifact_kind, ua.media_type, ua.storage_bucket, ua.storage_key, ua.metadata::text
    )) LIKE :canonical_search_pattern`);
    canonicalParams.canonical_search_pattern = `%${search}%`;
  }

  const canonical = await pageAll<ExportArtifact>(
    `SELECT DISTINCT ua.id,
            document.id AS scenario_id,
            render_link.render_job_id AS simulation_id,
            ua.metadata->>'sensorId' AS sensor_id,
            ua.metadata->>'sequenceId' AS sequence_id,
            CASE WHEN ua.metadata->>'frameIndex' ~ '^[0-9]+$'
              THEN (ua.metadata->>'frameIndex')::int ELSE NULL END AS frame_index,
            ua.storage_bucket AS s3_bucket,
            ua.storage_key AS s3_key,
            NULL::text AS s3_prefix,
            ua.byte_length::bigint AS size_bytes,
            ua.media_type AS content_type,
            ua.metadata->>'sensorLabel' AS sensor_label,
            ua.metadata->>'sensorCategory' AS sensor_category,
            ua.metadata->>'outputModality' AS output_modality,
            ua.artifact_kind AS artifact_type,
            'scenario'::text AS artifact_family,
            ua.metadata::text AS metadata_json,
            ua.created_at::text AS created_at
       FROM simforge.artifacts ua
       JOIN simforge.artifact_links render_link
         ON render_link.artifact_id = ua.id
        AND render_link.workspace_id = ua.workspace_id
        AND render_link.render_job_id IS NOT NULL
       JOIN simforge.render_jobs render_job
         ON render_job.id = render_link.render_job_id
        AND render_job.workspace_id = render_link.workspace_id
        AND render_job.job_state = 'succeeded'
       JOIN simforge.revisions revision
         ON revision.id = render_job.revision_id
        AND revision.workspace_id = render_job.workspace_id
       JOIN simforge.documents document
         ON document.id = revision.document_id
        AND document.workspace_id = revision.workspace_id
       LEFT JOIN simforge.dataset_items dataset_item
         ON dataset_item.workspace_id = render_job.workspace_id
        AND dataset_item.render_job_id = render_job.id
       LEFT JOIN simforge.dataset_snapshot_artifact_links snapshot_link
         ON snapshot_link.workspace_id = ua.workspace_id
        AND snapshot_link.artifact_id = ua.id
      WHERE ${canonicalClauses.join(" AND ")}
      ORDER BY ua.created_at ASC, ua.id ASC
      LIMIT :canonical_limit OFFSET :canonical_offset`,
    canonicalParams,
    "canonical_limit",
    "canonical_offset",
  );

  return [...legacy, ...canonical].map((artifact) => ({
    ...artifact,
    size_bytes: artifact.size_bytes == null ? null : Number(artifact.size_bytes),
    frame_index: artifact.frame_index == null ? null : Number(artifact.frame_index),
  }));
}

/**
 * The scenario definitions written next to the artifacts as
 * `scenarios/<name>-<id>.json`. Legacy rows carry their `draft_json`; canonical
 * documents contribute the current draft's canonical content.
 */
export async function listScenarioDefinitionsForJob(
  job: SourceJob,
): Promise<ExportScenarioDefinition[]> {
  const scenarioIds = scopeValues(job.scopeJson ?? null, "scenarioIds");
  const params: SqlParams = {
    workspace_id: job.workspaceId,
    dataset_id: job.datasetId,
  };
  let sql: string;
  if (job.datasetSnapshotId) {
    params.snapshot_id = job.datasetSnapshotId;
    sql = `
      WITH scoped_scenarios AS (
        SELECT DISTINCT a.scenario_id
          FROM public.dataset_snapshot_items dsi
          JOIN public.artifacts a
            ON a.id = dsi.artifact_id AND a.workspace_id = :workspace_id
         WHERE dsi.dataset_snapshot_id = :snapshot_id AND a.scenario_id IS NOT NULL
        UNION
        SELECT DISTINCT revision.document_id
          FROM simforge.dataset_snapshot_artifact_links link
          JOIN simforge.artifact_links artifact_link
            ON artifact_link.artifact_id = link.artifact_id
           AND artifact_link.workspace_id = link.workspace_id
           AND artifact_link.render_job_id IS NOT NULL
          JOIN simforge.render_jobs render_job
            ON render_job.id = artifact_link.render_job_id
           AND render_job.workspace_id = artifact_link.workspace_id
          JOIN simforge.revisions revision
            ON revision.id = render_job.revision_id
           AND revision.workspace_id = render_job.workspace_id
         WHERE link.workspace_id = :workspace_id AND link.dataset_snapshot_id = :snapshot_id
      ), scenario_definitions AS (
        SELECT s.id, s.display_name, s.status,
               COALESCE(s.source_kind, 'native') AS source_kind,
               s.draft_json::text AS draft_json
          FROM public.scenarios s
         WHERE s.workspace_id = :workspace_id
        UNION ALL
        SELECT document.id, document.title AS display_name,
               'ready'::text AS status, 'scenario'::text AS source_kind,
               draft.canonical_content::text AS draft_json
          FROM simforge.documents document
          JOIN simforge.drafts draft
            ON draft.document_id = document.id AND draft.workspace_id = document.workspace_id
         WHERE document.workspace_id = :workspace_id AND document.deleted_at IS NULL
      )
      SELECT s.id, s.display_name, s.status, s.source_kind, s.draft_json
        FROM scenario_definitions s
        JOIN scoped_scenarios scoped ON scoped.scenario_id = s.id
       WHERE TRUE`;
  } else {
    sql = `
      WITH scenario_definitions AS (
        SELECT s.id, s.display_name, s.status,
               COALESCE(s.source_kind, 'native') AS source_kind,
               s.draft_json::text AS draft_json
          FROM public.scenarios s
         WHERE s.workspace_id = :workspace_id
           AND (
             s.dataset_id = :dataset_id
             OR EXISTS (
               SELECT 1 FROM public.dataset_scenarios ds
                WHERE ds.workspace_id = s.workspace_id
                  AND ds.dataset_id = :dataset_id AND ds.scenario_id = s.id
             )
           )
        UNION ALL
        SELECT document.id, document.title AS display_name,
               'ready'::text AS status, 'scenario'::text AS source_kind,
               draft.canonical_content::text AS draft_json
          FROM simforge.documents document
          JOIN simforge.drafts draft
            ON draft.document_id = document.id AND draft.workspace_id = document.workspace_id
         WHERE document.workspace_id = :workspace_id
           AND document.deleted_at IS NULL
           AND (
             document.dataset_id = :dataset_id
             OR EXISTS (
               SELECT 1 FROM simforge.dataset_items item
                 JOIN simforge.revisions rev
                   ON rev.id = item.revision_id AND rev.workspace_id = item.workspace_id
                WHERE item.workspace_id = document.workspace_id
                  AND item.dataset_id = :dataset_id AND rev.document_id = document.id
             )
           )
      )
      SELECT s.id, s.display_name, s.status, s.source_kind, s.draft_json
        FROM scenario_definitions s
       WHERE TRUE`;
  }
  if (scenarioIds.length > 0) {
    params.scenario_ids = scenarioIds.join(",");
    sql += " AND s.id = ANY(string_to_array(:scenario_ids, ','))";
  }
  sql += " ORDER BY s.display_name ASC NULLS LAST, s.id ASC";
  return queryRows<ExportScenarioDefinition>(sql, params);
}
