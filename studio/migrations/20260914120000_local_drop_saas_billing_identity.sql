-- Cut the hosted-SaaS billing and tenant-identity rows out of the local
-- database.
--
-- A local installation has no account, organization, membership or billing:
-- local identity is the frozen synthetic constants in
-- studio/app/lib/auth/session.ts, so a credit balance, a billing ledger, an
-- invitation row and a tenant audit trail can only ever be dead SaaS shape
-- here. Cloud keeps every one of them, because there they are real hosted
-- product concerns (docs/engineering/local-cloud-boundary.md §5.2, §5.3 and
-- §8 step 3). No local code reads any of this: the only writer of
-- credits_balance was the default-credit seeding in
-- 0089_billing_ledger_and_default_credits.sql, which dies with the column.
--
-- Deliberately NOT in this migration: the workspace_id columns on the core
-- UniScenario tables and the public.ba_user/ba_organization/ba_member/
-- workspaces rows that still key them. That is the later irreversible cut.
BEGIN;

-- No CASCADE on purpose: an unexpected dependency should fail this migration
-- rather than silently take another table's constraint with it.
DROP TABLE IF EXISTS public.billing_ledger;
DROP TABLE IF EXISTS public.ba_invitation;
DROP TABLE IF EXISTS public.admin_impersonation_sessions;
DROP TABLE IF EXISTS public.admin_role_assignments;
DROP TABLE IF EXISTS public.workspace_audit_logs;

ALTER TABLE public.workspaces DROP CONSTRAINT IF EXISTS credits_balance_non_negative;
ALTER TABLE public.workspaces DROP COLUMN IF EXISTS credits_balance;
ALTER TABLE public.ba_user DROP COLUMN IF EXISTS credits_balance;

COMMIT;
