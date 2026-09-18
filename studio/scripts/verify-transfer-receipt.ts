import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTemplate } from "@simforge-oss/scenario";
import type { CrossMapVariationTransferReceiptInput } from "../app/lib/scenario/document-store";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const liveDaemonRoot = "/home/path/.local/share/simforge/daemon-data";
const targetMigration = "20260917120000_simforge_variation_transfer_receipt_identity.sql";
const hex = "a".repeat(64);

function errorConstraint(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  return "constraint" in error && typeof error.constraint === "string" ? error.constraint : undefined;
}

async function main() {
  if (process.env.DATABASE_URL?.trim()) {
    throw new Error("Refusing receipt verification while DATABASE_URL is set; this harness uses only throwaway PGlite.");
  }
  if (process.env.SIMFORGE_CLOUD_ROOT?.includes(liveDaemonRoot) || process.env.SIMFORGE_CLOUD_ROOT?.includes("5421")) {
    throw new Error("Refusing receipt verification against the live daemon data root or port 5421.");
  }

  const scratchRoot = await mkdtemp(join(tmpdir(), "simforge-transfer-receipt-"));
  assert.notEqual(resolve(scratchRoot), liveDaemonRoot);
  assert.equal(scratchRoot.includes("5421"), false);
  process.env.SIMFORGE_CLOUD_ROOT = scratchRoot;

  let shutdownDatabase: (() => Promise<void>) | undefined;
  try {
    // Database config is read at module evaluation time. Dynamic imports are intentional here:
    // the throwaway root must be installed before any database or store module can open PGlite.
    const database = await import("../app/lib/db/data-api");
    shutdownDatabase = database.shutdownDatabase;
    const { migrate } = await import("./migrate");
    const expectedMigrations = (await readdir(resolve(appRoot, "migrations")))
      .filter((filename) => filename.endsWith(".sql"))
      .sort();
    const originalLog = console.log;
    let applied: string[];
    try {
      console.log = () => undefined;
      applied = await migrate();
    } finally {
      console.log = originalLog;
    }
    assert.deepEqual(applied, expectedMigrations, "fresh scratch database must apply the full migration sequence");
    assert.equal(applied.at(-1), targetMigration);

    await database.executeScript(`
      INSERT INTO public.ba_user (id, name, email)
        VALUES ('user-test', 'Test', 'transfer-receipt@example.invalid');
      INSERT INTO public.ba_organization (id, name, slug)
        VALUES ('org-test', 'Test', 'transfer-receipt-test');
      INSERT INTO public.workspaces (id, slug, name, created_by_user_id, auth_organization_id)
        VALUES ('ws-test', 'transfer-receipt-test', 'Test', 'user-test', 'org-test');
      INSERT INTO simforge.datasets (id, workspace_id, name)
        VALUES ('dataset-test', 'ws-test', 'Test');
      INSERT INTO simforge.documents (id, workspace_id, title, schema_version, dataset_id)
        VALUES ('fixture-doc', 'ws-test', 'Fixture', '2', 'dataset-test');
      INSERT INTO simforge.revisions (
        id, workspace_id, document_id, revision_number, source_draft_version, schema_version,
        canonical_content, content_sha256, compiler_version
      ) VALUES (
        'fixture-revision', 'ws-test', 'fixture-doc', 1, 1, '2', '{}'::jsonb,
        '${"0".repeat(64)}', 'fixture'
      );
      INSERT INTO simforge.artifacts (
        id, workspace_id, revision_id, artifact_kind, media_type, storage_bucket, storage_key,
        sha256, byte_length
      ) VALUES
        ('artifact-catalog', 'ws-test', 'fixture-revision', 'asset-catalog', 'application/json',
         'scratch', 'catalog', '${"1".repeat(64)}', 1),
        ('artifact-source', 'ws-test', 'fixture-revision', 'map-source', 'application/xml',
         'scratch', 'source', '${"2".repeat(64)}', 1),
        ('artifact-target', 'ws-test', 'fixture-revision', 'map-source', 'application/xml',
         'scratch', 'target', '${"3".repeat(64)}', 1);
      INSERT INTO simforge.asset_catalog_versions (
        id, workspace_id, manifest_artifact_id, manifest_sha256, source_inventory_sha256,
        pipeline_version, toolchain, provenance
      ) VALUES (
        'catalog-test', 'ws-test', 'artifact-catalog', '${"4".repeat(64)}', '${"5".repeat(64)}',
        'test', '{}'::jsonb, '{}'::jsonb
      );
      INSERT INTO simforge.map_versions (
        id, workspace_id, label, browser_manifest_url, topology_artifact_url, xodr_artifact_id,
        xodr_sha256, coordinate_system_id, coordinate_system_sha256, asset_catalog_version_id
      ) VALUES
        ('map-source', 'ws-test', 'Source', 'scratch://source', 'scratch://source-topology',
         'artifact-source', '${"6".repeat(64)}', 'coords-source', '${"7".repeat(64)}', 'catalog-test'),
        ('map-target', 'ws-test', 'Target', 'scratch://target', 'scratch://target-topology',
         'artifact-target', '${"8".repeat(64)}', 'coords-target', '${"9".repeat(64)}', 'catalog-test');
      INSERT INTO simforge.documents (
        id, workspace_id, title, schema_version, map_version_id, dataset_id
      ) VALUES ('source-doc', 'ws-test', 'Source', '2', 'map-source', 'dataset-test');
      INSERT INTO simforge.documents (
        id, workspace_id, title, schema_version, map_version_id, dataset_id, derivation_kind,
        derived_from_document_id, derived_from_map_version_id, derived_at
      ) VALUES (
        'target-doc', 'ws-test', 'Target', '2', 'map-target', 'dataset-test',
        'cross_map_variation', 'source-doc', 'map-source', NOW()
      );
    `);

    const receiptColumns = `
      id, workspace_id, target_document_id, source_document_id, source_map_version_id,
      target_map_version_id, pattern_id, pattern_sha256, source_site_id, target_site_id,
      verdict, acceptance, equivalence_score, source_topology_digest, target_topology_digest,
      source_closure_digest, target_closure_digest, compiler_version, matcher_version, solver_version,
      param_seed, draw_index, input_hash, replay_key, replay_token, transfer_verdict,
      geometry_transfer, behavior_preservation, behavior_metrics, required_checks_passed,
      identity_provenance`;
    const receiptValues = `
      'receipt-test', 'ws-test', 'target-doc', 'source-doc', 'map-source', 'map-target',
      'pattern', '${hex}', 'source-site', 'target-site', 'equivalent', 'accepted', 1.0,
      'source-topology', 'target-topology', 'source-closure', 'target-closure',
      'compiler-v1', 'matcher-v1', 'solver-v1', 'seed', 7, 'input-hash',
      '{"seed":"seed","drawIndex":7}'::jsonb, '${hex}', 'adapted-equivalent', 'adapted',
      'preserved', '{"collisionDelta":0}'::jsonb, TRUE, 'local-derived'`;
    await database.execute(
      `INSERT INTO simforge.variation_transfers (${receiptColumns}) VALUES (${receiptValues})`,
    );

    const invalidUpdates: Record<string, { assignment: string; constraint: string }> = {
      acceptance: {
        assignment: "acceptance = 'bogus'",
        constraint: "simforge_variation_transfers_acceptance_check",
      },
      transfer_verdict: {
        assignment: "transfer_verdict = 'bogus'",
        constraint: "simforge_variation_transfers_transfer_verdict_check",
      },
      geometry_transfer: {
        assignment: "geometry_transfer = 'bogus'",
        constraint: "simforge_variation_transfers_geometry_check",
      },
      behavior_preservation: {
        assignment: "behavior_preservation = 'bogus'",
        constraint: "simforge_variation_transfers_behavior_check",
      },
      replay_token: {
        assignment: "replay_token = 'NOT-A-LOWERCASE-SHA'",
        constraint: "simforge_variation_transfers_replay_token_check",
      },
      replay_key: {
        assignment: "replay_key = '[]'::jsonb",
        constraint: "simforge_variation_transfers_replay_key_check",
      },
      behavior_metrics: {
        assignment: "behavior_metrics = '[]'::jsonb",
        constraint: "simforge_variation_transfers_behavior_metrics_check",
      },
    };
    const rejectedConstraints: string[] = [];
    for (const { assignment, constraint } of Object.values(invalidUpdates)) {
      let rejected = false;
      try {
        await database.execute(
          `UPDATE simforge.variation_transfers SET ${assignment} WHERE id = 'receipt-test'`,
        );
      } catch (error) {
        rejected = true;
        assert.equal(errorConstraint(error), constraint);
        rejectedConstraints.push(constraint);
      }
      assert.equal(rejected, true, `${constraint} must reject its invalid value`);
    }
    const validReceipt = await database.queryOne<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM simforge.variation_transfers WHERE id = 'receipt-test'`,
    );
    assert.equal(validReceipt?.count, 1);

    const fixture = JSON.parse(
      await readFile(resolve(appRoot, "../examples/school-dartout.template.json"), "utf8"),
    );
    const content = parseTemplate(fixture);
    await database.execute(
      `INSERT INTO simforge.drafts (
         document_id, workspace_id, schema_version, canonical_content, content_sha256,
         map_version_id, authoring_quality_id
       ) VALUES (
         'source-doc', 'ws-test', '2', CAST(:content AS jsonb), :sha, 'map-source', 'high'
       )`,
      { content, sha: "b".repeat(64) },
    );
    const receipt: CrossMapVariationTransferReceiptInput = {
      patternId: "pattern",
      patternSha256: "c".repeat(64),
      sourceSiteId: "source-site",
      targetSiteId: "target-site",
      permutationKey: "direct",
      verdict: "equivalent",
      acceptance: "accepted",
      equivalenceScore: 1,
      topologyScore: 1,
      roleBindingScore: 1,
      intentPreserved: true,
      issues: [],
      resumeToken: null,
      sourceTopologyDigest: "source-topology",
      targetTopologyDigest: "target-topology",
      sourceClosureDigest: "source-closure",
      targetClosureDigest: "target-closure",
      compilerVersion: "compiler-v1",
      matcherVersion: "matcher-v1",
      solverVersion: "solver-v1",
      paramSeed: "seed",
      drawIndex: 7,
      inputHash: "input-hash",
      replayKey: { seed: "seed", drawIndex: 7 },
      replayToken: "d".repeat(64),
      transferVerdict: "equivalent",
      geometryTransfer: "exact",
      behaviorPreservation: "preserved",
      behaviorMetrics: { collisionDelta: 0 },
      requiredChecksPassed: true,
      identityProvenance: "local-derived",
    };
    const store = await import("../app/lib/scenario/document-store");
    const context = {
      workspaceId: "ws-test",
      userId: "user-test",
      organizationId: "org-test",
      session: {
        sub: "user-test",
        email: "transfer-receipt@example.invalid",
        name: "Test",
        role: "owner",
        activeOrganizationId: "org-test",
      },
    };
    let invalidReceiptRejected = false;
    try {
      await store.createCrossMapScenarioDocument(context, "source-doc", {
        title: "Must Roll Back",
        targetMapVersionId: "map-target",
        content,
        receipt: { ...receipt, replayToken: "invalid" },
      });
    } catch (error) {
      invalidReceiptRejected = true;
      assert.equal(
        errorConstraint(error),
        "simforge_variation_transfers_replay_token_check",
      );
    }
    assert.equal(invalidReceiptRejected, true);
    const rolledBack = await database.queryOne<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM simforge.documents WHERE title = 'Must Roll Back'`,
    );
    assert.equal(rolledBack?.count, 0);

    const created = await store.createCrossMapScenarioDocument(context, "source-doc", {
      title: "Transferred Child",
      targetMapVersionId: "map-target",
      content,
      receipt,
    });
    assert.equal(created.kind, "created");
    if (created.kind !== "created") throw new Error("cross-map source or target disappeared");
    assert.equal(created.document.mapVersionId, "map-target");
    const readBack = await store.getVariationTransferReceipt(context, created.document.id);
    assert.equal(readBack?.id, created.receipt.id);
    assert.equal(readBack?.targetDocumentId, created.document.id);
    assert.equal(readBack?.sourceDocumentId, "source-doc");

    console.log(JSON.stringify({
      ok: true,
      database: "throwaway-pglite",
      migrationsApplied: applied.length,
      lastMigration: applied.at(-1),
      rejectedConstraints,
      validReceiptRows: validReceipt?.count,
      atomicRollbackChildRows: rolledBack?.count,
      atomicCreate: {
        targetMapVersionId: created.document.mapVersionId,
        receiptLinked: readBack?.targetDocumentId === created.document.id,
        sourceDocumentId: readBack?.sourceDocumentId,
      },
    }));
  } finally {
    await shutdownDatabase?.();
    await rm(scratchRoot, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }));
  process.exitCode = 1;
});
