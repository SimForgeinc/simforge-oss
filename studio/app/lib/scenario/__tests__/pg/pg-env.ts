/**
 * First import of the real-Postgres tests: points the data layer at
 * `SIMFORGE_TEST_DATABASE_URL` (a throwaway database) BEFORE app/lib/db/config.ts
 * is evaluated. PGlite runs one connection, so it cannot show a race; these
 * tests need a server with real concurrent sessions.
 */
import "../../../models/__tests__/test-env";

export const PG_URL = process.env.SIMFORGE_TEST_DATABASE_URL?.trim() || null;
if (PG_URL) process.env.DATABASE_URL = PG_URL;
