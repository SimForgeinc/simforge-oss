-- migration-impact: data migration (rewrites draft/revision map pins to simulation-member digests)
-- migration-window: online
-- Migration 20260922180000: a draft's map pin covers the SIMULATION members of
-- its map version's published closure, not the whole browser closure.
-- 20260922150000 pinned drafts to the browser closure digest
-- (browser_asset_sets.closure_sha256). Any republication of a version that only
-- adds derived members (a SUMO network, an ambient turn-verdict table, texture
-- tiers) changes that digest and would refuse every pinned draft's commit with
-- scenario_map_pin_mismatch. The pin is now `simforge.map-pin-closure/v1`:
-- sha256 over "<path> <sha256>\n" lines (byte order of path) of map.xodr,
-- topology-index.json.gz, signals.geojson.gz, derived/topology-derived.json.gz,
-- derived/locations.json.gz and 3d/variants/static-colliders*
-- (studio/app/lib/scenario/map-pin.ts, SIMULATION_CLOSURE_SHA256_SQL).
-- This rewrites pins that hold the browser digest of the version's current
-- closure. Pins the code writes from now on are already simulation digests; the
-- commit check also honours an old browser-digest pin while the simulation
-- members of that publication are unchanged, so rows this misses stay valid.
-- Rollback: the rewrite is lossless in the other direction only for pins whose
-- version was not republished since; SimCloud ships
-- migrations/.inverse/20260922180000_scenario_pin_simulation_closure.sql, which
-- restores the current browser digest for pins equal to the current simulation
-- digest.

BEGIN;

UPDATE simforge.drafts d
   SET map_closure_sha256 = sc.simulation_closure_sha256
  FROM (
  SELECT mv.id AS map_version_id,
         bs.closure_sha256 AS browser_closure_sha256,
         (SELECT encode(sha256(convert_to(string_agg(m.relative_path || ' ' || b.sha256 || E'\n', '' ORDER BY m.relative_path COLLATE "C"), 'UTF8')), 'hex')
            FROM simforge.browser_asset_members m
            JOIN simforge.browser_asset_blobs b ON b.id = m.blob_id
           WHERE m.asset_set_id = bs.id
             AND (m.relative_path IN ('map.xodr', 'topology-index.json.gz', 'signals.geojson.gz',
                                      'derived/topology-derived.json.gz', 'derived/locations.json.gz')
                  OR m.relative_path LIKE '3d/variants/static-colliders%')) AS simulation_closure_sha256
    FROM simforge.map_versions mv
    JOIN simforge.browser_asset_sets bs ON bs.id = mv.browser_asset_set_id
     AND bs.map_version_id = mv.id AND bs.asset_set_state = 'available'
   WHERE mv.retired_at IS NULL
  ) sc
 WHERE d.map_version_id = sc.map_version_id
   AND d.map_closure_sha256 = sc.browser_closure_sha256
   AND sc.simulation_closure_sha256 IS NOT NULL;

COMMIT;
