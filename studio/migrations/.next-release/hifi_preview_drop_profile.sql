-- NOT A MIGRATION YET. The CONTRACT half of
-- migrations/20260923140000_hifi_preview_render_preset_expand.sql. The runner
-- only reads `migrations/*.sql`, so this file is inert here.
--
-- Promote it in the first release AFTER the expand migration is applied on
-- every environment (dev, staging, production), i.e. the release after rc.76,
-- and only once no rc.75.x writer can run any more:
--   1. move it to migrations/<next id>_hifi_preview_drop_profile.sql and put
--      the id in the header line below;
--   2. mirror it (same bytes) into simcloud-platform migrations/ with an
--      .inverse (re-add `profile` nullable, backfilled from `preset`:
--      training -> sensor, showcase -> cinematic);
--   3. in the same release, remove the legacy-profile shim (`presetOfRow`)
--      and the `profile` write from studio/app/lib/hifi-preview/store.ts.
--
-- migration-impact: destructive
-- migration-window: online
-- Migration <next id>: backfill hifi_preview_requests.preset from profile
-- with the single old-name mapping (sensor -> training, cinematic ->
-- showcase), validate its CHECK, make it NOT NULL and drop `profile`.
-- A profile outside the old CHECK cannot exist; if a row still has preset
-- NULL after the backfill, SET NOT NULL fails loudly.
BEGIN;

UPDATE simforge.hifi_preview_requests
  SET preset = CASE profile WHEN 'sensor' THEN 'training' WHEN 'cinematic' THEN 'showcase' END
  WHERE preset IS NULL;

ALTER TABLE simforge.hifi_preview_requests
  VALIDATE CONSTRAINT hifi_preview_requests_preset_check;

ALTER TABLE simforge.hifi_preview_requests
  ALTER COLUMN preset SET NOT NULL;

ALTER TABLE simforge.hifi_preview_requests
  DROP CONSTRAINT IF EXISTS hifi_preview_requests_profile_check;

ALTER TABLE simforge.hifi_preview_requests
  DROP COLUMN IF EXISTS profile;

COMMIT;
