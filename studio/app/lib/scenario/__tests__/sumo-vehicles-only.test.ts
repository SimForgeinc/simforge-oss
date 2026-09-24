import "../../models/__tests__/test-env";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { AMBIENT_TRAFFIC_EXTENSION_KEY, resolveAmbientTrafficProfile } from "@simforge-oss/engine";
import { AMBIENT_TRAFFIC_PROVIDER_EXTENSION_KEY } from "@simforge-oss/playback/traffic";
import { parseTemplate } from "@simforge-oss/scenario";

import { migrate } from "../../../../scripts/migrate";
import { sumoVehiclesOnlyDrafts } from "../../../../scripts/sumo-vehicles-only-drafts";
import { LOCAL_USER_ID, LOCAL_WORKSPACE_ID } from "@/app/lib/auth/session";
import { execute, queryOne, shutdownDatabase } from "@/app/lib/db/data-api";
import { canonicalContentSha256 } from "../core";
import { sumoVehiclesOnlyStoredDocument } from "../sumo-vehicles-only";
import { seedPinnedMap } from "./pinning-fixtures";

const HERE = dirname(fileURLToPath(import.meta.url));
const LTAP = JSON.parse(readFileSync(join(HERE, "../../../../../examples/ltap-opposing.template.json"), "utf8")) as Record<string, unknown>;

function withTraffic(provider: string | undefined, profile: unknown): Record<string, unknown> {
  const extensions = { ...((LTAP.extensions as Record<string, unknown> | undefined) ?? {}) };
  delete extensions[AMBIENT_TRAFFIC_PROVIDER_EXTENSION_KEY];
  delete extensions[AMBIENT_TRAFFIC_EXTENSION_KEY];
  if (provider !== undefined) extensions[AMBIENT_TRAFFIC_PROVIDER_EXTENSION_KEY] = provider;
  if (profile !== undefined) extensions[AMBIENT_TRAFFIC_EXTENSION_KEY] = profile;
  return { ...LTAP, extensions };
}

test("a SUMO draft that asks for road users is repaired to vehicles only, touching only the two shares", () => {
  const light = { version: 1, preset: "light", seed: "kept" };
  const outcome = sumoVehiclesOnlyStoredDocument(withTraffic("sumo", light));
  assert.equal(outcome.kind, "updated");
  if (outcome.kind !== "updated") return;
  assert.equal(outcome.cyclistShare, 0.04);
  assert.equal(outcome.pedestrianShare, 0);
  assert.deepEqual(outcome.content.extensions?.[AMBIENT_TRAFFIC_EXTENSION_KEY], { ...light, pedestrianShare: 0, cyclistShare: 0 });
  const resolved = resolveAmbientTrafficProfile(outcome.content.extensions?.[AMBIENT_TRAFFIC_EXTENSION_KEY] as never);
  assert.deepEqual({ ...resolved, pedestrianShare: 0.02 }, { ...resolveAmbientTrafficProfile({ ...light, pedestrianShare: 0.02, cyclistShare: 0 } as never) });
  // Idempotent.
  assert.deepEqual(sumoVehiclesOnlyStoredDocument(outcome.content), { kind: "unchanged", reason: "vehicles_only" });
});

test("everything else is left alone or reported", () => {
  const city = { version: 1, preset: "city", seed: "ambient-1" };
  assert.deepEqual(sumoVehiclesOnlyStoredDocument(withTraffic("native", city)), { kind: "unchanged", reason: "not_sumo" });
  assert.deepEqual(sumoVehiclesOnlyStoredDocument(withTraffic(undefined, city)), { kind: "unchanged", reason: "not_sumo" });
  assert.deepEqual(sumoVehiclesOnlyStoredDocument(withTraffic("sumo", undefined)), { kind: "unchanged", reason: "no_profile" });
  assert.deepEqual(sumoVehiclesOnlyStoredDocument(withTraffic("sumo", { version: 1, preset: "off", seed: "x" })), { kind: "unchanged", reason: "off" });
  assert.equal(sumoVehiclesOnlyStoredDocument(withTraffic("sumo", "broken")).kind, "invalid_ambient_profile");
  assert.equal(sumoVehiclesOnlyStoredDocument({ not: "a scenario" }).kind, "unparseable");
});

test("the script lists in a dry run, writes with --apply under the draft version, and is idempotent", async (t) => {
  t.after(async () => {
    await shutdownDatabase();
  });
  await migrate();
  await seedPinnedMap();
  const drafts: [string, Record<string, unknown>][] = [
    ["uscn_sumo_city", withTraffic("sumo", { version: 1, preset: "city", seed: "ambient-1" })],
    ["uscn_sumo_clean", withTraffic("sumo", { version: 1, preset: "city", seed: "ambient-1", pedestrianShare: 0, cyclistShare: 0 })],
    ["uscn_native_city", withTraffic("native", { version: 1, preset: "city", seed: "ambient-1" })],
  ];
  for (const [id, raw] of drafts) {
    const content = parseTemplate(raw);
    await execute(
      `INSERT INTO simforge.documents (id, workspace_id, title, schema_version, map_version_id, dataset_id, created_by_user_id, updated_by_user_id)
       VALUES (:id, :workspace_id, :id, 'simforge.scenario/v2', 'usmapv_pin', 'usds_pin', :user_id, :user_id)`,
      { id, workspace_id: LOCAL_WORKSPACE_ID, user_id: LOCAL_USER_ID },
    );
    await execute(
      `INSERT INTO simforge.drafts (document_id, workspace_id, schema_version, canonical_content, content_sha256, map_version_id, updated_by_user_id)
       VALUES (:id, :workspace_id, 'simforge.scenario/v2', CAST(:content AS jsonb), :sha, 'usmapv_pin', :user_id)`,
      { id, workspace_id: LOCAL_WORKSPACE_ID, content, sha: canonicalContentSha256(content), user_id: LOCAL_USER_ID },
    );
  }
  const dry = await sumoVehiclesOnlyDrafts({ apply: false });
  assert.deepEqual(dry.updated, [{ documentId: "uscn_sumo_city", pedestrianShare: 0.06, cyclistShare: 0.02 }]);
  const untouched = await queryOne<{ draft_version: number }>(`SELECT draft_version FROM simforge.drafts WHERE document_id = 'uscn_sumo_city'`);
  assert.equal(Number(untouched?.draft_version), 1, "a dry run writes nothing");

  const applied = await sumoVehiclesOnlyDrafts({ apply: true });
  assert.deepEqual(applied.updated.map((entry) => entry.documentId), ["uscn_sumo_city"]);
  assert.deepEqual(applied.raced, []);
  const row = await queryOne<{ draft_version: number; content_sha256: string; canonical_content: string }>(
    `SELECT draft_version, content_sha256, canonical_content::text AS canonical_content FROM simforge.drafts WHERE document_id = 'uscn_sumo_city'`,
  );
  assert.equal(Number(row?.draft_version), 2);
  const stored = parseTemplate(JSON.parse(row!.canonical_content));
  assert.equal(row?.content_sha256, canonicalContentSha256(stored));
  assert.deepEqual(stored.extensions?.[AMBIENT_TRAFFIC_EXTENSION_KEY], { version: 1, preset: "city", seed: "ambient-1", pedestrianShare: 0, cyclistShare: 0 });

  const rerun = await sumoVehiclesOnlyDrafts({ apply: true });
  assert.deepEqual(rerun.updated, []);
});
