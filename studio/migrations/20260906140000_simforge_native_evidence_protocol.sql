-- migration-impact: contract
-- migration-window: a succeeded render attempt/job must carry accepted
-- evidence of the engine that rendered it, verified by the control plane
-- against that engine's own output document:
--   * carla   -> `uniscenario.parity-evidence/v1` (the executor manifest's parity
--                evidence; accepted iff the native-physics verdict is `pass`)
--   * native  -> `simforge.native-run-diagnostics/v1` (the engine's run diagnostics,
--                binding service protocol, replay clock, rendered tick count and
--                the pinned actor appearance closure `actorAssetsSha256`)
--   * browser -> `simforge.browser-render-manifest/v1` (the capture's frame-major
--                fixed-step schedule and hashed receipts of every byte stream)
-- The former bypass keyed on the intent contract tag is removed: the tag names
-- the request shape, not evidence, and no lane succeeds without evidence.
-- `browser_render` jobs complete through the recording lane and keep their own
-- origin fence. Rows completed before this cutover are unchanged history
-- (NOT VALID). Every check wraps its expression in IS TRUE so a missing key's
-- SQL NULL never passes.
BEGIN;

CREATE OR REPLACE FUNCTION simforge.render_evidence_accepted(
  schema_name TEXT, evidence JSONB, accepted BOOLEAN
) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE
AS $$
  SELECT (
    jsonb_typeof(evidence) = 'object'
    AND evidence->>'schema' = schema_name
    AND (
      (schema_name = 'uniscenario.parity-evidence/v1'
        AND accepted = ((evidence->>'verdict') = 'pass'))
      OR
      (schema_name = 'simforge.native-run-diagnostics/v1'
        AND (evidence #>> '{service,protocol}')::integer > 0
        AND (evidence->>'fixedTimestepSeconds')::numeric > 0
        AND (evidence->>'frameCount')::integer > 0
        AND evidence->>'actorAssetsSha256' ~ '^[a-f0-9]{64}$'
        AND accepted IS TRUE)
      OR
      (schema_name = 'simforge.browser-render-manifest/v1'
        AND evidence->>'engine' = 'browser'
        AND evidence->>'intentSha256' ~ '^[a-f0-9]{64}$'
        AND (evidence #>> '{schedule,frameCount}')::integer > 0
        AND (evidence #>> '{schedule,fps}')::numeric > 0
        AND jsonb_typeof(evidence->'artifacts') = 'array'
        AND accepted IS TRUE)
    )
  ) IS TRUE;
$$;

CREATE OR REPLACE FUNCTION simforge.render_evidence_matches_engine(
  engine TEXT, schema_name TEXT
) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE
AS $$
  SELECT (
    (engine = 'carla' AND schema_name = 'uniscenario.parity-evidence/v1')
    OR (engine = 'native' AND schema_name = 'simforge.native-run-diagnostics/v1')
    OR (engine = 'browser' AND schema_name = 'simforge.browser-render-manifest/v1')
  ) IS TRUE;
$$;

ALTER TABLE simforge.render_jobs
  DROP CONSTRAINT IF EXISTS uniscenario_render_jobs_parity_evidence_ck,
  ADD CONSTRAINT uniscenario_render_jobs_parity_evidence_ck CHECK ((
    (parity_evidence IS NULL AND parity_evidence_schema IS NULL AND parity_accepted IS NULL)
    OR simforge.render_evidence_accepted(parity_evidence_schema, parity_evidence, parity_accepted)
  ) IS TRUE) NOT VALID,
  DROP CONSTRAINT IF EXISTS uniscenario_render_jobs_success_requires_accepted_evidence_ck,
  ADD CONSTRAINT uniscenario_render_jobs_success_requires_accepted_evidence_ck CHECK ((
    job_state <> 'succeeded'
    OR job_mode NOT IN ('interaction_2d', 'full_render')
    OR (
      parity_accepted IS TRUE
      AND parity_evidence IS NOT NULL
      AND simforge.render_evidence_matches_engine(renderer_engine, parity_evidence_schema)
    )
  ) IS TRUE) NOT VALID;

ALTER TABLE simforge.render_attempts
  DROP CONSTRAINT IF EXISTS uniscenario_render_attempts_parity_evidence_ck,
  ADD CONSTRAINT uniscenario_render_attempts_parity_evidence_ck CHECK ((
    (parity_evidence IS NULL AND parity_evidence_schema IS NULL AND parity_accepted IS NULL)
    OR simforge.render_evidence_accepted(parity_evidence_schema, parity_evidence, parity_accepted)
  ) IS TRUE) NOT VALID,
  DROP CONSTRAINT IF EXISTS uniscenario_render_attempts_success_requires_accepted_evidence_ck,
  ADD CONSTRAINT uniscenario_render_attempts_success_requires_accepted_evidence_ck CHECK ((
    attempt_state <> 'succeeded'
    OR (
      parity_accepted IS TRUE
      AND parity_evidence IS NOT NULL
      AND simforge.render_evidence_matches_engine(renderer_engine, parity_evidence_schema)
    )
  ) IS TRUE) NOT VALID;

COMMIT;
