-- migration-impact: additive
-- migration-window: First-run setup state of this installation. The rendering
-- preference lives in localStorage, which is per browser profile and therefore
-- says nothing about whether the *installation* has been set up; the data root
-- is the real identity of an installation, so the first-run flag belongs here.
--
-- Exactly one row (id = 1): a Studio data root is one installation. `mode`
-- records whether setup finished signed in to SimCloud or locally, `quality`
-- the graphics level the user picked, both for support and for re-running
-- setup from Settings. Nothing here is a credential and nothing here gates
-- access — an unfinished row only means the onboarding screens still show.
BEGIN;

CREATE TABLE IF NOT EXISTS simforge.local_studio_setup (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  -- NULL until the user finished the onboarding flow.
  completed_at TIMESTAMPTZ,
  mode TEXT CHECK (mode IN ('cloud', 'local')),
  quality TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- A completed setup always names how it completed.
  CONSTRAINT local_studio_setup_completed_check
    CHECK (completed_at IS NULL OR (mode IS NOT NULL AND quality IS NOT NULL))
);

COMMIT;
