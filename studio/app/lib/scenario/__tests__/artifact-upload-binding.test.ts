import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const migration = await readFile(new URL("../../../../migrations/20260907010000_unified_artifact_upload_binding.sql", import.meta.url), "utf8");
const schema = `CREATE SCHEMA simforge;
CREATE TABLE simforge.artifact_uploads (
  id text PRIMARY KEY,
  expected_sha256 text,
  expected_byte_length bigint,
  expected_size_bytes bigint,
  bound_at timestamptz,
  CONSTRAINT uniscenario_artifact_uploads_binding_complete_check CHECK (
    (expected_sha256 IS NULL) = (expected_byte_length IS NULL)
    AND (expected_sha256 IS NULL) = (bound_at IS NULL)
  )
);
CREATE SCHEMA uniscenario;
CREATE VIEW uniscenario.artifact_uploads AS SELECT * FROM simforge.artifact_uploads;`;
const digest = "a".repeat(64);

test("upgrades old bindings and accepts complete native reservations without duplicate size fields", async () => {
  const db = new PGlite();
  try {
    await db.exec(schema);
    await db.query("INSERT INTO simforge.artifact_uploads(id,expected_sha256,expected_byte_length,bound_at) VALUES('legacy',$1,47,NOW())", [digest]);
    const insertNative = "INSERT INTO simforge.artifact_uploads(id,expected_sha256,expected_size_bytes,bound_at) VALUES('native',$1,128,NOW())";
    await assert.rejects(db.query(insertNative, [digest]), /binding_complete_check/);
    await db.exec(migration);
    await db.query(insertNative, [digest]);
    assert.deepEqual((await db.query("SELECT id, expected_size_bytes FROM simforge.artifact_uploads ORDER BY id")).rows, [
      { id: "legacy", expected_size_bytes: 47 },
      { id: "native", expected_size_bytes: 128 },
    ]);
    await assert.rejects(db.query("INSERT INTO simforge.artifact_uploads(id,expected_sha256,expected_size_bytes) VALUES('unbound',$1,128)", [digest]), /binding_complete_check/);
  } finally {
    await db.close();
  }
});

test("refuses conflicting historical byte lengths without losing either value", async () => {
  const db = new PGlite();
  try {
    await db.exec(schema);
    await db.query("INSERT INTO simforge.artifact_uploads VALUES('conflict',$1,47,48,NOW())", [digest]);
    await assert.rejects(db.exec(migration), /artifact_upload_size_conflict/);
    await db.exec("ROLLBACK");
    assert.deepEqual((await db.query("SELECT expected_byte_length,expected_size_bytes FROM simforge.artifact_uploads WHERE id='conflict'")).rows, [
      { expected_byte_length: 47, expected_size_bytes: 48 },
    ]);
  } finally {
    await db.close();
  }
});
