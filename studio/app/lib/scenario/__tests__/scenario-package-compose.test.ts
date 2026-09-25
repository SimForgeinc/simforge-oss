import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  ScenarioPackageError,
  readScenarioPackage,
  verifyScenarioPackage,
  writeScenarioPackage,
} from "@simforge-oss/native-runtime";
import { serializeTemplate, simContentHash, type ScenarioTemplateV2 } from "@simforge-oss/scenario";

import {
  ACTOR_CATALOG_PATH,
  composeScenarioPackage,
  producerKind,
  scenarioPackageCliCommand,
  scenarioPackageFileName,
  scenarioPackageMinCli,
  SCENARIO_PACKAGE_MIN_CLI,
  type MapClosureMember,
  type ScenarioPackageSources,
} from "../scenario-package/compose";
import { ScenarioPackageExportError } from "../scenario-package/errors";
import { scenarioPackageExportEnabled } from "../scenario-package/flag";

/**
 * The hosted exporter's composer against the crate's own fixture: rebuilding
 * a package's inputs from `fixtures/scenario-package/valid/full.scenario.zip`
 * (which the Rust `Case::build()` wrote) as the rows and bytes a host reads,
 * the composed manifest must carry the same digests in every identity field,
 * and the binding must write thin and full containers the reader verifies.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "../../../../../fixtures/scenario-package");
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const INSTALLATION = "6f1c1c55-3a8e-4c2b-9b1e-0d6a2f9e4b11";

type FixtureManifest = {
  scenario: { title: string; contentSha256: string; simContentSha256: string };
  engine: { engineSemVer: string; solverVersion: string; release: string; build: Record<string, unknown> };
  simulation: Record<string, unknown> & { simKey: string; traceSha256: string; resolvedInputDigest: string; resolutionSha256: string };
  timelines: Record<string, unknown>[];
  map: Record<string, unknown> & { mapVersionId: string; closure: { memberCount: number; bytes: number } };
  catalog: Record<string, unknown> & { catalogIds: string[]; referencedActorBlobs: { count: number; bytes: number } };
  executionPackage: { xoscSha256: string };
};

function fixture() {
  const bytes = readFileSync(join(FIXTURES, "valid/full.scenario.zip"));
  const read = readScenarioPackage(bytes, { cliVersion: "0.2.0" });
  const member = (path: string) => {
    const found = read.members.find((m) => m.path === path);
    assert.ok(found, `fixture member ${path}`);
    return new Uint8Array(found.data);
  };
  const manifest = JSON.parse(read.manifestJson) as FixtureManifest;
  const timelinePath = read.members.map((m) => m.path).find((p) => p.startsWith("timeline/"))!;
  const actors = JSON.parse(Buffer.from(member("actors/closure.json")).toString("utf8")) as { members: Record<string, { sha256: string }> };
  const catalogModels = read.blobs.find((b) => b.sha256 === actors.members[ACTOR_CATALOG_PATH]!.sha256)!;
  const closure = JSON.parse(Buffer.from(member("map/closure.json")).toString("utf8")) as { members: MapClosureMember[] };
  const content = JSON.parse(Buffer.from(member("document.json")).toString("utf8")) as ScenarioTemplateV2;
  return { read, manifest, member, timelinePath, catalogModels, closure, content };
}

function sourcesOf(f: ReturnType<typeof fixture>): ScenarioPackageSources {
  const { manifest, member } = f;
  const sim = manifest.simulation;
  return {
    revision: {
      id: "usrev_fixture0001",
      documentId: "usdoc_fixture0001",
      revisionNumber: 3,
      committedAt: "2026-09-21T18:02:11.000Z",
      title: manifest.scenario.title,
      content: f.content,
      storedContentSha256: sha(serializeTemplate(f.content)),
      assetCatalogVersionId: manifest.catalog.assetCatalogVersionId as string,
      mapClosureSha256: manifest.map.pinClosureSha256 as string,
      ossRelease: manifest.engine.release,
    },
    result: {
      simKey: sim.simKey,
      traceSha256: sim.traceSha256,
      authoredTraceSha256: sim.authoredTraceSha256 as string,
      traceGzipSha256: sim.traceGzipSha256 as string,
      engineSemVer: manifest.engine.engineSemVer,
      solverVer: manifest.engine.solverVersion,
      traceSchema: sim.traceSchema as string,
      resolvedInputDigest: sim.resolvedInputDigest,
      resolutionSha256: sim.resolutionSha256,
      mapClosureDigest: manifest.map.mapClosureDigest as string,
      mapVersionId: manifest.map.mapVersionId,
      trafficProvider: sim.trafficProvider as string,
      trafficStepKey: null,
      // Host-only keys (`producer`, `runtime`) never reach the manifest.
      engineBuild: { ...manifest.engine.build, producer: "cpu:host-a", runtime: { source: "x" } },
      producer: "cpu:worker-7",
      createdAt: sim.simulatedAt as string,
      ambientProvenance: { mode: "native" },
    },
    traceGzip: member("simulation/trace.json.gz"),
    resolutionGzip: member("simulation/resolution.json.gz"),
    traffic: null,
    timeline: member(f.timelinePath),
    map: {
      mapVersionId: manifest.map.mapVersionId,
      sourceMapId: manifest.map.sourceMapId as string,
      label: manifest.map.label as string,
      xodrSha256: manifest.map.xodrSha256 as string,
      coordinateSystemSha256: manifest.map.coordinateSystemSha256 as string,
      browserClosureSha256: manifest.map.browserClosureSha256 as string,
      // Row order is not listing order: the composer sorts.
      members: [...f.closure.members].reverse(),
    },
    actors: { closure: member("actors/closure.json"), catalogModels: new Uint8Array(f.catalogModels.data) },
    catalogEntries: JSON.parse(Buffer.from(member("catalog/entries.json")).toString("utf8")) as unknown[],
    xosc: member("export/scenario.xosc"),
    sumo: null,
    pipelineRevision: 4,
    installation: { kind: "simcloud", id: INSTALLATION },
    motionSource: "original",
    appVersion: "0.1.0-rc.76",
  };
}

test("the composed manifest carries the fixture's digests and writes a verified thin package", () => {
  const f = fixture();
  const composed = composeScenarioPackage(sourcesOf(f));
  const m = composed.manifest as unknown as FixtureManifest & Record<string, Record<string, unknown>>;

  assert.deepEqual(m.producer, { app: "simcloud", appVersion: "0.1.0-rc.76", minCli: "0.2.0" });
  assert.equal(m.scenario.contentSha256, f.manifest.scenario.contentSha256, "document.json is the crate's canonical bytes");
  // The fixture's simContentSha256 is synthetic; the exporter's is simContentHash of the document.
  assert.equal(m.scenario.simContentSha256, simContentHash(f.content));
  assert.deepEqual(m.scenario.origin, { documentId: "usdoc_fixture0001", revisionId: "usrev_fixture0001", revisionNumber: 3, committedAt: "2026-09-21T18:02:11.000Z" });
  assert.deepEqual(m.engine.build, f.manifest.engine.build, "only the five recorded build fields");
  for (const key of ["simKey", "traceFormat", "traceSchema", "traceSha256", "traceGzipSha256", "authoredTraceSha256", "resolvedInputDigest", "resolutionSha256", "trafficProvider", "groundDigest", "sumo", "trafficSha256"]) {
    assert.deepEqual(m.simulation[key], f.manifest.simulation[key], `simulation.${key}`);
  }
  assert.equal(m.simulation.producerKind, "runner");
  assert.deepEqual(m.timelines, f.manifest.timelines);
  assert.deepEqual(m.map, f.manifest.map);
  assert.deepEqual(m.catalog, f.manifest.catalog, "catalogIds, catalog digest and the referenced actor blobs");
  assert.equal(m.executionPackage.xoscSha256, f.manifest.executionPackage.xoscSha256);
  assert.deepEqual(m.provenance, { installationKind: "simcloud", installationId: INSTALLATION, authorDisplayName: null });
  assert.deepEqual(m.extensions, { "simcloud.releaseSource": "revision", "simcloud.motionSource": "original" });

  const written = writeScenarioPackage({ manifest: composed.manifest, members: composed.members, receipt: { exportedAt: "2026-09-24T23:00:00.000Z", exporterRelease: "0.1.0-rc.76" } });
  const verification = verifyScenarioPackage(written.bytes, { cliVersion: "0.2.0" });
  assert.equal(verification.packageId, written.packageId);
  assert.equal(verification.form, "thin");
  assert.equal(verification.cliCheck, "passed");
  assert.equal(sha(Buffer.from(written.manifestJson)), written.packageId);

  // One revision, one id: composing again gives the same manifest bytes.
  const again = writeScenarioPackage({ manifest: composeScenarioPackage(sourcesOf(f)).manifest, members: composed.members });
  assert.equal(again.packageId, written.packageId);
});

test("the full form embeds exactly the crate's full set and shares the thin package id", () => {
  const f = fixture();
  const composed = composeScenarioPackage(sourcesOf(f));
  const fullSet = composed.fullBlobs({ textures: false });
  assert.deepEqual(fullSet.map((b) => b.sha256).sort(), f.read.blobs.map((b) => b.sha256).sort(), "non-texture map members + reachable actor blobs");
  const withTextures = composed.fullBlobs({ textures: true });
  assert.ok(withTextures.some((b) => b.role === "texture"), "textures are embedded on request");

  const bytesOf = (digest: string) => new Uint8Array(f.read.blobs.find((b) => b.sha256 === digest)!.data);
  const thin = writeScenarioPackage({ manifest: composed.manifest, members: composed.members });
  const full = writeScenarioPackage({
    manifest: composed.manifest,
    members: composed.members,
    blobs: fullSet.map((b) => ({ data: bytesOf(b.sha256) })),
    receipt: { exportedAt: "2026-09-24T23:00:00.000Z", exporterRelease: "0.1.0-rc.76", textureTier: "none" },
  });
  const verification = verifyScenarioPackage(full.bytes, { cliVersion: "0.2.0" });
  assert.equal(verification.form, "full");
  assert.equal(verification.packageId, thin.packageId);
  assert.equal(composed.summary.actors.referencedBlobs.count, f.manifest.catalog.referencedActorBlobs.count);
});

test("refusals are loud and named, never a partial package", () => {
  const f = fixture();
  const refused = (mutate: (s: ScenarioPackageSources) => void, code: string) => {
    const sources = sourcesOf(f);
    mutate(sources);
    assert.throws(() => composeScenarioPackage(sources), (error: unknown) => error instanceof ScenarioPackageExportError && error.code === code, code);
  };
  refused((s) => { s.revision.storedContentSha256 = "0".repeat(64); }, "package_document_digest_mismatch");
  refused((s) => { s.traceGzip = s.traceGzip.slice(1); }, "package_digest_mismatch");
  refused((s) => { s.map.browserClosureSha256 = "1".repeat(64); }, "package_map_closure_mismatch");
  refused((s) => { s.revision.mapClosureSha256 = "2".repeat(64); }, "package_identity_mismatch");
  refused((s) => { s.result.producer = "mystery:host"; }, "package_producer_kind_unknown");
  refused((s) => { s.result.traceSha256 = "3".repeat(64); }, "package_identity_mismatch");
  refused((s) => { s.actors.catalogModels = new Uint8Array([123, 125]); }, "package_digest_mismatch");
  // A withheld model is refused by name (the actor closure is patched consistently, as the origin would serve it).
  refused((s) => {
    const table = JSON.parse(Buffer.from(s.actors.catalogModels).toString("utf8")) as Record<string, unknown>;
    table.withheld = { "hazard.cardboard_box": { reason: "licence unconfirmed" } };
    const models = new TextEncoder().encode(JSON.stringify(table));
    const closure = JSON.parse(Buffer.from(s.actors.closure).toString("utf8")) as { members: Record<string, { bytes: number; sha256: string }> };
    closure.members["catalog-models.json"] = { bytes: models.byteLength, sha256: sha(models) };
    s.actors.catalogModels = models;
    s.actors.closure = new TextEncoder().encode(JSON.stringify(closure));
  }, "package_actor_model_withheld");

  // A draft the crate refuses is refused by the writer with its code, not written.
  const composed = composeScenarioPackage(sourcesOf(f));
  const bad = { ...composed.manifest, producer: { app: "simcloud", appVersion: "not-semver", minCli: "0.2.0" } };
  assert.throws(() => writeScenarioPackage({ manifest: bad, members: composed.members }), (e: unknown) => e instanceof ScenarioPackageError && e.code === "package_manifest_invalid");
});

test("minCli comes from the table; a contract version with no row refuses the export", () => {
  assert.equal(scenarioPackageMinCli({ scenarioVersion: 2, traceFormat: 5, samplerVersions: ["simforge.timeline-sampler/3"] }), "0.2.0");
  assert.throws(
    () => scenarioPackageMinCli({ scenarioVersion: 2, traceFormat: 6, samplerVersions: ["simforge.timeline-sampler/3"] }),
    (e: unknown) => e instanceof ScenarioPackageExportError && e.code === "package_min_cli_unknown" && /traceFormat 6/.test(e.message),
  );
  assert.ok(Object.isFrozen(SCENARIO_PACKAGE_MIN_CLI));
});

test("file name, one-liner and producer kinds", () => {
  const id = "ab12cd34ef567890".padEnd(64, "0");
  // The crate's `file_name`: lowercase ASCII words joined by single dashes, 12 hex.
  assert.equal(scenarioPackageFileName("Unprotected left, opposing sedan!", id), "unprotected-left-opposing-sedan.ab12cd34ef56.scenario.zip");
  assert.equal(scenarioPackageFileName("  ***  ", id), "scenario.ab12cd34ef56.scenario.zip");
  assert.equal(scenarioPackageFileName("Café à Richmond", id), "caf-richmond.ab12cd34ef56.scenario.zip");
  assert.equal(
    scenarioPackageCliCommand("left-turn.ab12cd34ef56.scenario.zip"),
    "simforge package import left-turn.ab12cd34ef56.scenario.zip --into left-turn && simforge render left-turn --preset training --rig rig.json --out left-turn-render",
  );
  assert.equal(producerKind("inline:host:1"), "inline");
  assert.equal(producerKind("cpu:worker-1"), "runner");
});

test("the manifest carries no workspace, user, host, bucket or object key", () => {
  const f = fixture();
  const sources = sourcesOf(f);
  const composed = composeScenarioPackage(sources);
  const text = JSON.stringify(composed.manifest);
  for (const secret of ["cpu:worker-7", "host-a", "ws_", "local-artifacts", "/sim/sha256/", "https://", "@"]) {
    assert.ok(!text.includes(secret), `manifest leaks ${secret}`);
  }
});

test("the flag is on in dev and local, off in staging and prod unless set", () => {
  assert.equal(scenarioPackageExportEnabled({ SIMFORGE_ENV: "dev" }), true);
  assert.equal(scenarioPackageExportEnabled({}), true);
  assert.equal(scenarioPackageExportEnabled({ SIMFORGE_ENV: "staging" }), false);
  assert.equal(scenarioPackageExportEnabled({ SIMFORGE_ENV: "prod" }), false);
  assert.equal(scenarioPackageExportEnabled({ SIMFORGE_ENV: "prod", SIMFORGE_SCENARIO_PACKAGE_EXPORT: "1" }), true);
  assert.equal(scenarioPackageExportEnabled({ SIMFORGE_ENV: "dev", SIMFORGE_SCENARIO_PACKAGE_EXPORT: "0" }), false);
});
