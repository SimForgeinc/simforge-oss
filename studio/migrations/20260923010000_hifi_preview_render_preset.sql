-- migration-impact: contract
-- migration-window: online
-- Migration 20260923010000: a high-fidelity preview renders with one of the
-- native renderer's two presets (`showcase`, `training`), not a render
-- profile. The native renderer has one look; the `sensor` profile no longer
-- exists (docs/engineering/native-runtime-jobs.md). Existing rows keep what
-- they rendered: `cinematic` was the showcase look, and `sensor` rows map to
-- `training`, the preset for machine consumers. request_json of existing rows
-- is left as recorded (it is the request as submitted).
BEGIN;

ALTER TABLE simforge.hifi_preview_requests
  DROP CONSTRAINT IF EXISTS hifi_preview_requests_profile_check;

UPDATE simforge.hifi_preview_requests
  SET profile = CASE profile WHEN 'sensor' THEN 'training' ELSE 'showcase' END;

ALTER TABLE simforge.hifi_preview_requests RENAME COLUMN profile TO preset;

ALTER TABLE simforge.hifi_preview_requests
  ADD CONSTRAINT hifi_preview_requests_preset_check CHECK (preset IN ('showcase', 'training'));

COMMIT;
