import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  DEFAULT_MIGRATIONS_LEDGER,
  adoptedMigrations,
  localOnlyReason,
  migrationHostKind,
  migrationsLedger,
} from "../migration-plan";

const migrationsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../../migrations");

/**
 * The three migrations that describe a local install rather than the shared
 * schema. Running any of them against a host whose product is accounts,
 * organizations and billing destroys live data, which is what the marker in
 * their headers exists to prevent.
 */
const LOCAL_ONLY = [
  "0089_billing_ledger_and_default_credits.sql",
  "0093_billing_usage_reservations.sql",
  "20260914120000_local_drop_saas_billing_identity.sql",
];

test("every local-only migration declares itself, and nothing else does", async () => {
  const filenames = (await readdir(migrationsDirectory)).filter((name) => name.endsWith(".sql"));
  const marked: string[] = [];
  for (const filename of filenames) {
    const reason = localOnlyReason(await readFile(resolve(migrationsDirectory, filename), "utf8"));
    if (reason === null) continue;
    assert.notEqual(reason, "", `${filename} must say why it is local-only`);
    marked.push(filename);
  }
  assert.deepEqual(marked.sort(), [...LOCAL_ONLY].sort());
});

test("the marker is a header line, not any line that mentions it", () => {
  assert.equal(localOnlyReason("-- simforge:local-only drops tenants\nDROP TABLE t;"), "drops tenants");
  assert.equal(localOnlyReason("-- intro\n\n-- simforge:local-only late\nSELECT 1;"), "late");
  assert.equal(localOnlyReason("-- simforge:local-only\nSELECT 1;"), "declared local-only");
  assert.equal(localOnlyReason("SELECT 1;\n-- simforge:local-only too late"), null);
  assert.equal(
    localOnlyReason("INSERT INTO t VALUES ('-- simforge:local-only');"),
    null,
    "a marker inside a statement is data, not a declaration",
  );
  assert.equal(localOnlyReason("-- ordinary migration\nSELECT 1;"), null);
});

test("the host kind defaults to local and refuses anything it does not understand", () => {
  assert.equal(migrationHostKind({}), "local");
  assert.equal(migrationHostKind({ SIMFORGE_STUDIO_HOST_KIND: " cloud " }), "cloud");
  assert.equal(migrationHostKind({ SIMFORGE_STUDIO_HOST_KIND: "" }), "local");
  assert.throws(() => migrationHostKind({ SIMFORGE_STUDIO_HOST_KIND: "hosted" }), /must be "local" or "cloud"/);
});

test("the ledger table is the default unless a plain identifier replaces it", () => {
  assert.equal(migrationsLedger({}), DEFAULT_MIGRATIONS_LEDGER);
  assert.equal(
    migrationsLedger({ SIMFORGE_STUDIO_MIGRATIONS_TABLE: "public.studio_schema_migrations" }),
    "public.studio_schema_migrations",
  );
  for (const hostile of ["public.t; DROP TABLE x", "public.t--", '"T"', "a.b.c", "Public.T"]) {
    assert.throws(
      () => migrationsLedger({ SIMFORGE_STUDIO_MIGRATIONS_TABLE: hostile }),
      /plain \[schema\.\]table identifier/,
      hostile,
    );
  }
});

test("nothing is adopted unless the host names it, and only filenames are accepted", () => {
  assert.deepEqual([...adoptedMigrations({})], []);
  assert.deepEqual(
    [...adoptedMigrations({ SIMFORGE_STUDIO_ADOPT_MIGRATIONS: " 0001_a.sql, ,20260920130000_b.sql " })],
    ["0001_a.sql", "20260920130000_b.sql"],
  );
  for (const hostile of ["x.sql; DROP TABLE t", "../x.sql", "x", "a/b.sql"]) {
    assert.throws(() => adoptedMigrations({ SIMFORGE_STUDIO_ADOPT_MIGRATIONS: hostile }), /must be migration filenames/, hostile);
  }
});
