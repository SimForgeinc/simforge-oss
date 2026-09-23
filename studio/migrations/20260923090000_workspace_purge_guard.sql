-- migration-impact: expand
-- migration-window: online
-- Migration 20260923090000: a workspace that owns immutable scenario results cannot be deleted by accident.
--
-- simforge.revisions, simforge.sim_results (and revision_simulations) and simforge.render_jobs
-- reference public.workspaces ON DELETE CASCADE, so one `DELETE FROM public.workspaces` erases
-- every revision, saved simulation and render record the workspace ever made. The product path
-- only soft-deletes (workspaces.deleted_at); this guard makes the hard delete refuse unless the
-- audited purge path asked for exactly that workspace in the same transaction:
--
--   SELECT set_config('simforge.workspace_purge', '<workspace id>', true);  -- transaction-local
--   DELETE FROM public.workspaces WHERE id = '<workspace id>';
--
-- Anything else raises SQLSTATE 23001 (restrict_violation) with message
-- workspace_has_immutable_results. Workspaces with none of those rows delete as before.
--
-- Adds one function and one trigger; changes no existing object or row.
-- Rollback: DROP TRIGGER simforge_workspace_delete_guard ON public.workspaces;
--   DROP FUNCTION simforge.workspace_delete_guard();
--   (migrations/.inverse/20260923090000_workspace_purge_guard.sql in SimCloud.)

BEGIN;

CREATE FUNCTION simforge.workspace_delete_guard() RETURNS trigger
LANGUAGE plpgsql AS $guard$
DECLARE
  revisions_count BIGINT;
  results_count BIGINT;
  renders_count BIGINT;
BEGIN
  IF current_setting('simforge.workspace_purge', true) IS DISTINCT FROM OLD.id THEN
    SELECT count(*) INTO revisions_count FROM simforge.revisions WHERE workspace_id = OLD.id;
    SELECT count(*) INTO results_count FROM simforge.sim_results WHERE workspace_id = OLD.id;
    SELECT count(*) INTO renders_count FROM simforge.render_jobs WHERE workspace_id = OLD.id;
    IF revisions_count + results_count + renders_count > 0 THEN
      RAISE EXCEPTION USING
        ERRCODE = 'restrict_violation',
        MESSAGE = 'workspace_has_immutable_results',
        DETAIL = format('workspace %s owns %s revisions, %s simulation results and %s render jobs; deleting it would cascade-delete all of them',
          OLD.id, revisions_count, results_count, renders_count),
        HINT = 'Soft-delete the workspace (deleted_at) instead, or run the audited admin purge, which sets simforge.workspace_purge to this workspace id for its transaction.';
    END IF;
  END IF;
  RETURN OLD;
END;
$guard$;

CREATE TRIGGER simforge_workspace_delete_guard
  BEFORE DELETE ON public.workspaces
  FOR EACH ROW EXECUTE FUNCTION simforge.workspace_delete_guard();

COMMIT;
