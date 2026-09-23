-- migration-impact: additive columns
-- migration-window: online
-- Migration 20260923110000: where a render timeline's heights came from
-- (docs/engineering/ground-height.md, render-timeline.md §4).
-- * `sim_timelines.contact_origin`: 'trace' (engine 0.11 contact copied),
--   'derived-at-timeline-build' (a trace recorded without contact, grounded on
--   the map's ground derivative when the timeline was built) or
--   'legacy-xodr-elevation' (a map version published before its ground
--   derivative: the retired OpenDRIVE resolver). 'synthetic' surfaces never
--   reach a hosted render. Null on rows derived before this migration
--   (sampler 1, which only ever used the OpenDRIVE resolver).
-- * `render_jobs.timeline_contact_origin`: the origin of the timeline the job
--   replays, so a render on legacy heights is labelled, never silent.
-- Rollback: ALTER TABLE simforge.sim_timelines DROP COLUMN contact_origin;
--   ALTER TABLE simforge.render_jobs DROP COLUMN timeline_contact_origin;

BEGIN;

ALTER TABLE simforge.sim_timelines
  ADD COLUMN IF NOT EXISTS contact_origin TEXT
    CHECK (contact_origin IS NULL OR contact_origin IN ('trace', 'derived-at-timeline-build', 'legacy-xodr-elevation'));

ALTER TABLE simforge.render_jobs
  ADD COLUMN IF NOT EXISTS timeline_contact_origin TEXT
    CHECK (timeline_contact_origin IS NULL OR timeline_contact_origin IN ('trace', 'derived-at-timeline-build', 'legacy-xodr-elevation'));

COMMIT;
