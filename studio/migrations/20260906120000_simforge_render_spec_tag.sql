-- migration-impact: contract
-- migration-window: the control plane now writes and claims only
-- `simforge.render-intent/v1`, and browser recordings carry only the canonical
-- `simforge.render-spec/v3`; the retired single-source v2 spec and the
-- `uniscenario.*` namespace are no longer admitted. Rows created before this
-- cutover keep the tag they were hashed with (intent_sha256 covers the schema
-- field) and remain readable history; succeeded recordings are never
-- re-evaluated.
BEGIN;

ALTER TABLE simforge.render_jobs
  DROP CONSTRAINT IF EXISTS uniscenario_render_jobs_browser_render_success_origin_ck,
  ADD CONSTRAINT uniscenario_render_jobs_browser_render_success_origin_ck CHECK (
    job_mode <> 'browser_render'
    OR job_state <> 'succeeded'
    OR (
      request_contract_version IN ('simforge.render-intent/v1', 'uniscenario.render-intent/v1')
      AND render_intent->>'schema' = request_contract_version
      AND origin_recording_job_id IS NULL
      AND renderer_engine = 'browser'
    )
    OR (
      request_contract_version NOT IN ('simforge.render-intent/v1', 'uniscenario.render-intent/v1')
      AND origin_recording_job_id IS NOT NULL
    )
  ) NOT VALID,
  DROP CONSTRAINT IF EXISTS uniscenario_render_jobs_success_requires_accepted_evidence_ck,
  ADD CONSTRAINT uniscenario_render_jobs_success_requires_accepted_evidence_ck CHECK (
    job_state <> 'succeeded'
    OR request_contract_version IN ('simforge.render-intent/v1', 'uniscenario.render-intent/v1')
    OR job_mode NOT IN ('interaction_2d', 'full_render')
    OR (
      parity_accepted IS TRUE
      AND parity_evidence_schema = 'uniscenario.parity-evidence/v1'
      AND parity_evidence IS NOT NULL
    )
  ) NOT VALID;


CREATE OR REPLACE FUNCTION simforge.enforce_browser_recording_artifact_closure()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  spec JSONB := NEW.request_payload->'renderSpec';
BEGIN
  IF NEW.postprocess_kind <> 'browser_threejs_recording'
     OR NEW.state <> 'succeeded'
     OR OLD.state = 'succeeded' THEN
    RETURN NEW;
  END IF;

  IF spec->>'schema' IS DISTINCT FROM 'simforge.render-spec/v3' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'browser_recording_artifact_closure_invalid',
      MESSAGE = 'browser recording render spec is not supported';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements_text(spec->'artifacts') artifact(value)
     WHERE artifact.value NOT IN (
       'video', 'manifest', 'frames', 'sensorArchive', 'trace', 'annotations'
     )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'browser_recording_artifact_closure_invalid',
      MESSAGE = 'browser recording render spec declares an unsupported artifact';
  END IF;

  IF EXISTS (
    WITH expected(role, actor_id, sensor_id, modality, relationship) AS (
      SELECT 'manifest'::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT, 'output'::TEXT
      UNION ALL
      SELECT 'video', NULL, NULL, NULL, 'output' WHERE spec->'artifacts' ? 'video'
      UNION ALL
      SELECT 'frames', NULL, NULL, NULL, 'output' WHERE spec->'artifacts' ? 'frames'
      UNION ALL
      -- Every camera source emits its own encoded video stream; lidar/radar
      -- add visualization videos when a video output is requested.
      SELECT 'sensor_video', source->>'actorId', source->>'sensorId',
             source->>'modality', 'output'
        FROM jsonb_array_elements(spec->'sources') source
       WHERE source->>'modality' NOT IN ('lidar', 'radar')
          OR spec ? 'video'
      UNION ALL
      -- Measurement archives exist only for lidar/radar; camera frame
      -- archives were removed with individual RGB frame persistence.
      SELECT 'sensor_archive', source->>'actorId', source->>'sensorId',
             source->>'modality', 'output'
        FROM jsonb_array_elements(spec->'sources') source
       WHERE spec->'artifacts' ? 'sensorArchive'
         AND source->>'modality' IN ('lidar', 'radar')
    ), actual(role, actor_id, sensor_id, modality, relationship) AS (
      SELECT link.artifact_role, link.artifact_sensor_actor_id,
             link.artifact_sensor_id, link.artifact_sensor_modality, link.relationship
        FROM simforge.operational_job_artifact_links link
        JOIN simforge.artifacts artifact
          ON artifact.id = link.artifact_id
         AND artifact.workspace_id = link.workspace_id
       WHERE link.workspace_id = NEW.workspace_id
         AND link.job_family = 'artifact_postprocess'
         AND link.job_id = NEW.id
         AND link.attempt_id IS NULL
         AND link.artifact_role IS NOT NULL
         AND artifact.artifact_state = 'available'
         AND artifact.deleted_at IS NULL
    )
    (SELECT * FROM expected EXCEPT SELECT * FROM actual)
    UNION ALL
    (SELECT * FROM actual EXCEPT SELECT * FROM expected)
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'browser_recording_artifact_closure_invalid',
      MESSAGE = 'browser recording artifacts do not equal the render spec closure';
  END IF;

  RETURN NEW;
END;
$$;

COMMIT;
