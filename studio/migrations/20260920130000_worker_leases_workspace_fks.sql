-- migration-impact: destructive
-- Close the two worker_leases deferrals in 20260806011000.
-- Rollback: migrations/.inverse/20260920130000_worker_leases_workspace_fks.sql
-- browser_asset_members remains deferred to a dedicated backfill window (~149k
-- rows on 2026-09-20). Neither that table nor its historical deferral is changed.
--
-- Deploy with the two claim writers in control-plane-store.ts and
-- render-worker-control-store.ts. Pause claims across the database/code cutover:
-- old writers cannot run after NOT NULL, new writers cannot run before ADD COLUMN.
-- No trigger/default guesses tenant identity. Leases drain naturally; observed
-- dev/staging counts were 124/930 with no active leases. A short ACCESS EXCLUSIVE
-- lock fences writes through backfill/audit/constraint replacement. lock_timeout
-- bounds acquisition; direct NOT NULL is reviewed for this small table (a NOT
-- VALID check would not shorten the ADD COLUMN lock held by this transaction).
-- Missing parents, NULL tenant keys, or disagreeing existing tenant keys abort
-- the entire transaction. No lease is deleted and no non-NULL tenant is rewritten.
-- Parent-job workspace is authoritative only when the attempt agrees.
-- FK definitions are read before replacement: only key lists change, preserving
-- ON DELETE (observed CASCADE for both on dev), ON UPDATE and deferrability.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $do$
DECLARE
  s text;
  leases regclass;
  parent regclass;
  parent_name text;
  child_key text;
  con record;
  definition text;
  bad bigint;
  found integer;
BEGIN
  SELECT n.nspname INTO s FROM pg_class t
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE t.relname = 'worker_leases' AND n.nspname IN ('uniscenario', 'simforge')
     AND t.relkind IN ('r', 'p')
   ORDER BY n.nspname = 'simforge' DESC LIMIT 1;
  IF s IS NULL THEN RAISE EXCEPTION 'worker_leases schema not found'; END IF;
  leases := format('%I.worker_leases', s)::regclass;
  EXECUTE format('ALTER TABLE %s ADD COLUMN workspace_id TEXT', leases);
  EXECUTE format('UPDATE %s l SET workspace_id = j.workspace_id FROM %I.render_jobs j WHERE j.id = l.render_job_id AND l.workspace_id IS NULL', leases, s);
  EXECUTE format(
    'SELECT count(*) FROM %s l LEFT JOIN %I.render_jobs j ON j.id = l.render_job_id LEFT JOIN %I.render_attempts a ON a.id = l.render_attempt_id WHERE l.workspace_id IS NULL OR j.id IS NULL OR l.workspace_id IS DISTINCT FROM j.workspace_id OR (l.render_attempt_id IS NOT NULL AND (a.id IS NULL OR l.workspace_id IS DISTINCT FROM a.workspace_id))',
    leases, s, s) INTO bad;
  IF bad <> 0 THEN
    RAISE EXCEPTION 'worker_leases tenant audit failed: % orphan, NULL, or mismatched rows; repair explicitly before retrying', bad;
  END IF;

  FOREACH parent_name IN ARRAY ARRAY['render_jobs', 'render_attempts'] LOOP
    parent := format('%I.%I', s, parent_name)::regclass;
    child_key := CASE parent_name WHEN 'render_jobs' THEN 'render_job_id' ELSE 'render_attempt_id' END;
    IF NOT EXISTS (
      SELECT 1 FROM pg_index i
       WHERE i.indrelid = parent AND i.indisunique AND i.indisvalid
         AND i.indimmediate AND i.indpred IS NULL AND i.indexprs IS NULL
         AND i.indnkeyatts = 2
         AND i.indkey[0] = (SELECT attnum FROM pg_attribute WHERE attrelid = parent AND attname = 'id')
         AND i.indkey[1] = (SELECT attnum FROM pg_attribute WHERE attrelid = parent AND attname = 'workspace_id')
    ) THEN
      EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I UNIQUE (id, workspace_id)', parent, parent_name || '_lease_workspace_unique');
      EXECUTE format('COMMENT ON CONSTRAINT %I ON %s IS %L', parent_name || '_lease_workspace_unique', parent, 'Created by 20260920130000_worker_leases_workspace_fks');
    END IF;
    found := 0;
    FOR con IN SELECT c.oid, c.conname, c.confdeltype, pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c WHERE c.conrelid = leases AND c.confrelid = parent AND c.contype = 'f'
        AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = leases AND attname = child_key)]::smallint[]
        AND c.confkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = parent AND attname = 'id')]::smallint[]
    LOOP
      found := found + 1;
      definition := replace(replace(con.definition, format('FOREIGN KEY (%I)', child_key), format('FOREIGN KEY (%I, workspace_id)', child_key)), '(id)', '(id, workspace_id)');
      IF definition = con.definition THEN RAISE EXCEPTION 'Unrecognized FK definition: %', con.definition; END IF;
      EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', leases, con.conname);
      EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s', leases, con.conname, definition);
      EXECUTE format('ALTER TABLE %s VALIDATE CONSTRAINT %I', leases, con.conname);
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = leases AND conname = con.conname AND confdeltype = con.confdeltype) THEN
        RAISE EXCEPTION 'ON DELETE changed for %', con.conname;
      END IF;
    END LOOP;
    IF found <> 1 THEN RAISE EXCEPTION 'Expected exactly one single-column lease FK to %, found %', parent, found; END IF;
  END LOOP;
  EXECUTE format('ALTER TABLE %s ALTER COLUMN workspace_id SET NOT NULL', leases);
END
$do$;

-- Fail closed on the complete catalog end state, including validated composites
-- and absence of the old tenant-blind keys. Parent FKs already enforce workspaces.
DO $do$
DECLARE
  t record;
  found integer := 0;
BEGIN
  FOR t IN SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'worker_leases' AND n.nspname IN ('uniscenario', 'simforge')
      AND c.relkind IN ('r', 'p')
  LOOP
    found := found + 1;
    IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = t.oid AND attname = 'workspace_id' AND attnotnull AND NOT attisdropped)
      OR (SELECT count(*) FROM pg_constraint c JOIN pg_class p ON p.oid = c.confrelid
          WHERE c.conrelid = t.oid AND c.contype = 'f' AND p.relname IN ('render_jobs', 'render_attempts')) <> 2
      OR (SELECT count(*) FROM pg_constraint c JOIN pg_class p ON p.oid = c.confrelid
          WHERE c.conrelid = t.oid AND c.contype = 'f' AND p.relname IN ('render_jobs', 'render_attempts') AND c.convalidated
            AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = t.oid AND attname = CASE p.relname WHEN 'render_jobs' THEN 'render_job_id' ELSE 'render_attempt_id' END), (SELECT attnum FROM pg_attribute WHERE attrelid = t.oid AND attname = 'workspace_id')]::smallint[]
            AND c.confkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = p.oid AND attname = 'id'), (SELECT attnum FROM pg_attribute WHERE attrelid = p.oid AND attname = 'workspace_id')]::smallint[]) <> 2 THEN
      RAISE EXCEPTION 'worker_leases tenant containment incomplete';
    END IF;
  END LOOP;
  IF found <> 1 THEN RAISE EXCEPTION 'Expected one worker_leases table, found %', found; END IF;
END
$do$;
COMMIT;
