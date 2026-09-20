import type { StudioHostKind } from "@simforge-oss/studio-host";

/**
 * Header marker that declares a migration to be about THIS INSTALLATION rather
 * than about the schema every host shares.
 *
 * Some migrations in `migrations/` describe a local install specifically: they
 * seed a starter credit balance, or drop the account, organization and billing
 * tables because a local install has no tenants. Running one of those against a
 * host whose product is those tenants destroys live data. The migration itself
 * is the only place that knows which kind it is, so it says so, in a comment
 * line in its header:
 *
 * ```sql
 * -- simforge:local-only <why this must not run on a hosted database>
 * ```
 *
 * The runner reads the marker. It deliberately does not keep a list of
 * filenames: a list is a second place to edit, and the migration that gets
 * added without its entry is the one that runs where it must not.
 */
export const LOCAL_ONLY_MARKER = "simforge:local-only";

/**
 * The reason this migration is local-only, or `null` if it is not.
 *
 * Only the header is consulted — the leading run of comment and blank lines —
 * so the marker cannot be picked up from a string literal or a comment buried
 * in the body of a statement.
 */
export function localOnlyReason(sql: string): string | null {
  for (const line of sql.split("\n")) {
    const text = line.trim();
    if (text === "") continue;
    if (!text.startsWith("--")) return null;
    const comment = text.slice(2).trim();
    if (!comment.startsWith(LOCAL_ONLY_MARKER)) continue;
    return comment.slice(LOCAL_ONLY_MARKER.length).trim() || "declared local-only";
  }
  return null;
}

/**
 * Which host this migration run is for. A local install is the default: the
 * only way to get the narrower behaviour is to ask for it.
 */
export function migrationHostKind(env: NodeJS.ProcessEnv = process.env): StudioHostKind {
  const declared = env.SIMFORGE_STUDIO_HOST_KIND?.trim();
  if (!declared || declared === "local") return "local";
  if (declared === "cloud") return "cloud";
  throw new Error(
    `SIMFORGE_STUDIO_HOST_KIND must be "local" or "cloud", not ${JSON.stringify(declared)}`,
  );
}

/** The default ledger: one local install, one set of migrations, one table. */
export const DEFAULT_MIGRATIONS_LEDGER = "public.schema_migrations";

/**
 * The table this run records itself in.
 *
 * Configurable because a host that also runs its own migrations already owns
 * `public.schema_migrations`, and the two sets share filenames — one ledger
 * would make this runner skip a migration the host happened to name
 * identically and leave the schema half-built. The name is interpolated into
 * DDL, so it is checked here rather than trusted: schema and table, lowercase
 * identifiers, nothing to quote.
 */
export function migrationsLedger(env: NodeJS.ProcessEnv = process.env): string {
  const declared = env.SIMFORGE_STUDIO_MIGRATIONS_TABLE?.trim();
  if (!declared) return DEFAULT_MIGRATIONS_LEDGER;
  if (!/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/.test(declared)) {
    throw new Error(
      `SIMFORGE_STUDIO_MIGRATIONS_TABLE must be a plain [schema.]table identifier, not ${JSON.stringify(declared)}`,
    );
  }
  return declared;
}
