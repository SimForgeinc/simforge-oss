/**
 * Expand half of migration 20260923140000 (hifi preview profile -> preset)
 * and the store's rollout shim.
 *
 * The expand only adds `preset` (nullable, CHECK NOT VALID). Rows written
 * before it, and rows the previous release (rc.75.1) inserts during the
 * rollout, carry `profile` only: the store maps them explicitly and logs
 * them. The new app writes both columns so the previous release can still
 * read its rows. The contract half (next release) backfills and drops
 * `profile`; its SQL is exercised here too, so it cannot rot unnoticed.
 */
import "../../models/__tests__/test-env";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { bootModelTestDatabase } from "../../models/__tests__/harness";
import type { AppContext } from "../../db/app-context";
import { execute, executeScript, queryOne } from "../../db/data-api";
import {
  LEGACY_PROFILE_OF_PRESET,
  createHifiPreviewRequest,
  getHifiPreviewRequest,
  leaseNextHifiPreview,
  presetOfRow,
} from "../store";
import type { CreateHifiPreviewInput } from "@simforge-oss/studio-ui/lib/hifi-preview/contracts";

const EXPAND_SQL = readFileSync(
  fileURLToPath(new URL("../../../../migrations/20260923140000_hifi_preview_render_preset_expand.sql", import.meta.url)),
  "utf8",
);
const CONTRACT_SQL = readFileSync(
  fileURLToPath(new URL("../../../../migrations/.next-release/hifi_preview_drop_profile.sql", import.meta.url)),
  "utf8",
);

let context: AppContext;

before(async () => {
  context = await bootModelTestDatabase();
}, { timeout: 240_000 });

/** What an rc.75.1 writer inserts: `profile` only, request_json with `profile`. */
async function insertLegacyRow(id: string, profile: "cinematic" | "sensor"): Promise<void> {
  await execute(
    `INSERT INTO simforge.hifi_preview_requests
       (id, workspace_id, map_version_id, profile, tick, request_json)
     VALUES (:id, :workspace_id, 'mv-legacy', :profile, 0, :request)`,
    {
      id,
      workspace_id: context.workspaceId,
      profile,
      request: { mapVersionId: "mv-legacy", profile, tick: 0 },
    },
  );
}

test("the expand migration only adds: legacy rows keep preset NULL; it is idempotent", async () => {
  await insertLegacyRow("hp-legacy-sensor", "sensor");
  await executeScript(EXPAND_SQL);
  await executeScript(EXPAND_SQL);
  const sensor = await queryOne<{ preset: string | null; profile: string }>(
    "SELECT preset, profile FROM simforge.hifi_preview_requests WHERE id = 'hp-legacy-sensor'",
  );
  assert.deepEqual(sensor, { preset: null, profile: "sensor" });
  await assert.rejects(
    execute("UPDATE simforge.hifi_preview_requests SET preset = 'cinematic' WHERE id = 'hp-legacy-sensor'"),
    /hifi_preview_requests_preset_check/,
  );
  await execute("DELETE FROM simforge.hifi_preview_requests WHERE id LIKE 'hp-legacy-%'");
});

test("the new app writes both columns so the previous release can read its rows", async () => {
  const record = await createHifiPreviewRequest(context, {
    mapVersionId: "mv-new",
    preset: "training",
    tick: 3,
  } as unknown as CreateHifiPreviewInput);
  assert.equal(record.preset, "training");
  const row = await queryOne<{ preset: string; profile: string }>(
    "SELECT preset, profile FROM simforge.hifi_preview_requests WHERE id = :id",
    { id: record.id },
  );
  assert.deepEqual(row, { preset: "training", profile: LEGACY_PROFILE_OF_PRESET.training });
  await execute("DELETE FROM simforge.hifi_preview_requests WHERE id = :id", { id: record.id });
});

test("a row the previous release inserts after the migration is mapped explicitly and logged", async () => {
  await insertLegacyRow("hp-rollout-sensor", "sensor");
  const record = await getHifiPreviewRequest(context, "hp-rollout-sensor");
  assert.equal(record?.preset, "training");
  const lease = await leaseNextHifiPreview({ workerId: "test" });
  assert.equal(lease?.requestId, "hp-rollout-sensor");
  assert.equal(lease?.request.preset, "training", "the worker renders the mapped preset, not a default");

  const logged: Array<[string, Record<string, unknown>]> = [];
  assert.equal(
    presetOfRow({ id: "r", preset: null, profile: "cinematic" }, (event, detail) => logged.push([event, detail])),
    "showcase",
  );
  assert.deepEqual(logged, [["hifi_preview.legacy_profile_row", { requestId: "r", profile: "cinematic", preset: "showcase" }]]);
  assert.equal(presetOfRow({ id: "r", preset: "showcase", profile: "sensor" }, () => assert.fail("no log")), "showcase");
  assert.throws(() => presetOfRow({ id: "r", preset: null, profile: null }, () => {}), /no preset/);
  assert.throws(() => presetOfRow({ id: "r", preset: null, profile: "hdr" }, () => {}), /unmappable legacy profile/);
});

test("the next release's contract migration backfills with the same mapping and drops profile", async () => {
  await insertLegacyRow("hp-contract-sensor", "sensor");
  await insertLegacyRow("hp-contract-cinematic", "cinematic");
  await executeScript(CONTRACT_SQL);
  const rows = await queryOne<{ sensor: string; cinematic: string; has_profile: boolean }>(
    `SELECT
       (SELECT preset FROM simforge.hifi_preview_requests WHERE id = 'hp-contract-sensor') AS sensor,
       (SELECT preset FROM simforge.hifi_preview_requests WHERE id = 'hp-contract-cinematic') AS cinematic,
       EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'simforge' AND table_name = 'hifi_preview_requests'
                 AND column_name = 'profile') AS has_profile`,
  );
  assert.deepEqual(rows, { sensor: "training", cinematic: "showcase", has_profile: false });
});
