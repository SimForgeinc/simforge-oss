-- Migration 20260917130000: admit the rented 24 GiB `rtx3090-24gb-v1` render worker profile.
-- The schema pinned the fleet to the two workstation classes (20260820150000), so a truthful
-- 3090 registration was refused by the hardware-profile CHECK, by the approved-identity CHECK
-- and by the lease-eligibility trigger. Nothing else about the profile is special: it is a
-- non-local, GPU-bearing profile like `rtx3080-10gb-v1`.
-- Rollback: restore the three predicates to the three-profile list of 20260820150000 after
-- removing any worker_nodes row whose hardware_profile is 'rtx3090-24gb-v1'.

BEGIN;

ALTER TABLE simforge.worker_nodes
  DROP CONSTRAINT IF EXISTS uniscenario_worker_nodes_hardware_profile_ck,
  ADD CONSTRAINT uniscenario_worker_nodes_hardware_profile_ck CHECK (
    hardware_profile IS NULL
    OR hardware_profile IN (
      'rtx3080-10gb-v1', 'rtx5080-16gb-v1', 'rtx5080-16gb-local-v1', 'rtx3090-24gb-v1'
    )
  ) NOT VALID;

ALTER TABLE simforge.worker_nodes
  DROP CONSTRAINT IF EXISTS uniscenario_worker_nodes_approved_identity_ck,
  ADD CONSTRAINT uniscenario_worker_nodes_approved_identity_ck CHECK (
    registration_state <> 'active' OR (
      hardware_profile IN (
        'rtx3080-10gb-v1', 'rtx5080-16gb-v1', 'rtx5080-16gb-local-v1', 'rtx3090-24gb-v1'
      )
      AND approved_hardware_profile = hardware_profile
      AND approved_worker_version = worker_version
      AND approved_image_digest = image_digest
      AND approved_at IS NOT NULL
    )
  ) NOT VALID;

-- Same trigger function the 20260810010000 trigger already calls; the schema-compat migration
-- (20260824190000) moved it into `simforge`, so replacing it here rebinds that trigger.
CREATE OR REPLACE FUNCTION simforge.enforce_render_worker_lease_eligibility()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  worker simforge.worker_nodes%ROWTYPE;
BEGIN
  IF NEW.lease_state <> 'active' THEN
    RETURN NEW;
  END IF;
  SELECT * INTO worker FROM simforge.worker_nodes
   WHERE id = NEW.worker_node_id FOR SHARE;
  IF NOT FOUND
     OR worker.registration_state <> 'active'
     OR worker.hardware_profile NOT IN (
          'rtx3080-10gb-v1', 'rtx5080-16gb-v1', 'rtx5080-16gb-local-v1', 'rtx3090-24gb-v1'
        )
     OR worker.approved_hardware_profile IS DISTINCT FROM worker.hardware_profile
     OR worker.approved_worker_version IS DISTINCT FROM worker.worker_version
     OR worker.approved_image_digest IS DISTINCT FROM worker.image_digest
     OR worker.approved_at IS NULL
     OR worker.last_heartbeat_at < NOW() - INTERVAL '90 seconds' THEN
    RAISE EXCEPTION 'uniscenario_worker_not_eligible';
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
