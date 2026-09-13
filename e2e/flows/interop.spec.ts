/**
 * Stack-level OpenSCENARIO interoperability flows.
 *
 * The product makes four *different* claims about interchange, and this suite
 * keeps them apart because conflating them is how a compatibility artifact
 * gets mistaken for a conformance result:
 *
 *  1. **Native XML 1.4** — the interchange artifact, full official standard
 *     label, trajectory-replay execution mode.
 *  2. **XML 1.3.1 esmini compatibility** — a separate, explicitly labelled
 *     compatibility target that never relabels the 1.4 artifact.
 *  3. **External execution** — the pinned esmini 3.6.0 binary actually running
 *     the exported package.
 *  4. **Quantitative parity** — a numeric trace comparison with an attributed
 *     verdict, not "it ran, therefore it matches".
 *
 * Everything is asserted from consumer-visible output: CLI exit codes, the
 * JSON on stdout, the bytes of the written artifacts, and the comparison
 * report. Heavyweight inputs fail through the harness prerequisite gate with a
 * machine-readable record instead of being skipped.
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

// The harness root does not depend on the workspace packages, so the built
// interchange package is reached by path — the same published entry points
// (`@simforge-oss/openscenario/esmini` and `/trace-diff`) the product
// consumes. They are loaded lazily behind a prerequisite so an unbuilt
// package reports a prerequisite outcome instead of failing module load for
// the whole suite.
import type * as Esmini from "../../packages/openscenario/dist/esmini/index.js";
import type * as TraceDiff from "../../packages/openscenario/dist/trace-diff/index.js";

import {
  PREREQUISITES,
  definePrerequisite,
  expect,
  linkInstalledMaps,
  requirePrerequisites,
  runCli,
  test,
  writeEvidence,
  type E2eContext,
} from "../support/index";

/** The CLI contract: stdout is exactly one JSON document. */
function payload<T>(run: { readonly stdout: string }): T {
  return JSON.parse(run.stdout) as T;
}

/**
 * External execution is a *pinned* boundary: esmini 3.6.0, fetched by
 * `packages/openscenario/scripts-esmini/fetch-pinned-esmini.mjs`. An arbitrary
 * esmini on PATH would silently change what "parity" means, so the binary is
 * named explicitly.
 */
const PINNED_ESMINI = definePrerequisite({
  id: "pinned-esmini",
  title: "The pinned esmini 3.6.0 runner",
  env: ["SIMFORGE_E2E_ESMINI_BIN"],
  hint: "run `node packages/openscenario/scripts-esmini/fetch-pinned-esmini.mjs` and point the variable at .tools/esmini/3.6.0/payload/bin/esmini",
  verify: (values) => {
    const path = values["SIMFORGE_E2E_ESMINI_BIN"] ?? "";
    try {
      return statSync(path).isFile() ? null : "the configured esmini path is not a file";
    } catch {
      return "the configured esmini path does not exist";
    }
  },
});

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const LTAP_TEMPLATE = join(REPO_ROOT, "examples", "ltap-opposing.template.json");
/** A real OpenSCENARIO 1.4 golden that ships with the repository. */
const CONFORMANCE_XOSC = join(REPO_ROOT, "packages", "openscenario", "conformance", "actor-despawn.xosc");
const FIXTURES = resolve(import.meta.dirname, "..", "fixtures", "interop");

interface ExportResult {
  ok: boolean;
  format: string;
  standard: string;
  profile: string;
  intent: string;
  roundTrip: string;
  externalSimulatorValidation: string;
  capabilityReport: {
    roundTrip: string;
    externalSimulatorValidation: string;
    behaviorParityScope?: string;
  };
  out: string;
  bytes: number;
  warnings: { path: string; reason: string }[];
}

interface ImportSummary {
  ok: boolean;
  standard: string;
  stats: { actors: number; rolesTranslated: number };
  map: { status: string; selectedMapVersionId: string | null; diagnostic: { code: string } | null };
  capabilities: { supported: number; approximated: number; unsupported: number };
  lossy: string[];
  findings: { kind: string; code: string }[];
  out: string | null;
}

interface CliErrorDetail {
  code: string;
  path?: string;
  reason?: string;
  detail?: { format?: string; issues?: { code: string; path: string; reason: string }[] };
}

interface InstanceDocument {
  input: {
    mapId: string;
    clipSeconds: number;
    actors: { id: string; presentAtStart?: boolean }[];
    interactions: unknown[];
  };
  manifest: { instanceId: string; inputHash: string; replayKey: Record<string, unknown> };
}

/** The canonical engine trace as `normalizeCanonicalTrace` consumes it. */
type CanonicalTrace = Parameters<typeof TraceDiff.normalizeCanonicalTrace>[0];

const OPENSCENARIO_DIST = resolve(import.meta.dirname, "..", "..", "packages", "openscenario", "dist");

/**
 * The interchange package must be built before an external-execution flow can
 * score anything; an unbuilt workspace is a missing prerequisite, not a
 * silent pass.
 */
const BUILT_INTERCHANGE = definePrerequisite({
  id: "built-openscenario",
  title: "The built @simforge-oss/openscenario package",
  env: [],
  hint: "run `pnpm --filter @simforge-oss/openscenario build`",
  verify: () =>
    existsSync(join(OPENSCENARIO_DIST, "esmini", "index.js"))
    && existsSync(join(OPENSCENARIO_DIST, "trace-diff", "index.js"))
      ? null
      : "packages/openscenario/dist is missing its esmini/trace-diff entry points",
});

/** An installed map id from the configured corpus, or `null` when none is complete. */
function installedMapId(corpusRoot: string): string | null {
  const devAssets = join(corpusRoot, "dev-assets");
  if (!existsSync(devAssets)) return null;
  const candidates = readdirSync(devAssets)
    .filter((entry) => statSync(join(devAssets, entry)).isDirectory())
    .filter((entry) => existsSync(join(devAssets, entry, "derived", "topology-derived.json.gz")))
    .sort();
  return candidates[0] ?? null;
}

/** Link the real installed corpus into this test's isolated map cache. */
async function realMap(e2e: E2eContext): Promise<string> {
  await requirePrerequisites(e2e, [PREREQUISITES.realMaps]);
  const corpusRoot = process.env["SIMFORGE_E2E_MAPS_FIXTURE_ROOT"] ?? "";
  const mapId = installedMapId(corpusRoot);
  expect(mapId, `the configured corpus at ${corpusRoot} has no map with derived topology`).not.toBeNull();
  await linkInstalledMaps(e2e, [mapId ?? ""]);
  return mapId ?? "";
}

/**
 * Materialize the worked template into a concrete, provenance-bearing
 * instance and its canonical trace. Interchange claims are only meaningful
 * about a concrete instance — a portable template has no coordinates.
 */
async function materialize(
  mapId: string,
  workspace: string,
  label: string,
): Promise<{ instanceFile: string; traceFile: string; instance: InstanceDocument }> {
  await mkdir(workspace, { recursive: true });
  const match = await runCli(["sites", "match", LTAP_TEMPLATE, "--map", mapId], { expectExit: 0 });
  const sites = payload<{ maps: { sites: { siteId: string }[] }[] }>(match).maps[0]?.sites ?? [];
  expect(sites.length, "the worked template must match a concrete site").toBeGreaterThan(0);

  const instanceFile = join(workspace, `${label}.instance.json`);
  const traceFile = join(workspace, `${label}.trace.json.gz`);
  const instantiated = await runCli([
    "instantiate", LTAP_TEMPLATE,
    "--map", mapId,
    "--site", sites[0]?.siteId ?? "",
    "--draw", "0",
    "--out", instanceFile,
  ]);
  expect([0, 2]).toContain(instantiated.code);
  const simulated = await runCli(["simulate", instanceFile, "--trace", traceFile]);
  expect([0, 2]).toContain(simulated.code);

  const instance = JSON.parse(await readFile(instanceFile, "utf8")) as InstanceDocument;
  return { instanceFile, traceFile, instance };
}

test.describe("OpenSCENARIO import — findings, not crashes", () => {
  test("classifies malformed, future-version and missing inputs by exit code", async ({ e2e }) => {
    // A future major version parses: it is a statement about the *input*, so
    // it is exit 2 with a finding, never a command failure.
    const future = await runCli(["import", join(FIXTURES, "unsupported-version.xosc")]);
    expect(future.code).toBe(2);
    expect(payload<ImportSummary>(future).findings.map((finding) => finding.code)).toContain("version_unsupported");

    // Something that is not XML at all cannot be reasoned about: exit 1.
    const junk = await runCli(["import", join(FIXTURES, "not-openscenario.xosc")]);
    expect(junk.code).toBe(1);
    expect(junk.stdout).toBe("");
    expect((JSON.parse(junk.stderr) as CliErrorDetail).code).toBe("malformed_xml");

    const missing = await runCli(["import", join(FIXTURES, "no-such-scene.xosc")]);
    expect(missing.code).toBe(1);
    expect((JSON.parse(missing.stderr) as CliErrorDetail).code).toBe("file_not_found");

    await writeEvidence(e2e, "interop-import-classification", {
      outcome: "verified",
      futureVersionExit: future.code,
      malformedExit: junk.code,
      missingExit: missing.code,
    });
  });

  test("translates a real 1.4 golden against a real map and names what was lost", async ({ e2e }) => {
    const mapId = await realMap(e2e);
    const out = join(e2e.runsRoot, "interop-import", "imported.template.json");
    await mkdir(join(e2e.runsRoot, "interop-import"), { recursive: true });

    const imported = await runCli(["import", CONFORMANCE_XOSC, "--map", mapId, "--out", out]);
    // Storyboard semantics are not translatable, so a *successful* translation
    // still reports findings. Exit 2 here means "read me", not "failed".
    expect(imported.code).toBe(2);
    const summary = payload<ImportSummary>(imported);
    expect(summary.standard).toBe("ASAM OpenSCENARIO 1.4");
    expect(summary.map).toMatchObject({ status: "resolved", selectedMapVersionId: mapId });
    expect(summary.stats.actors).toBeGreaterThan(0);
    // Every actor lands as a map-pinned role; none are silently dropped.
    expect(summary.stats.rolesTranslated).toBe(summary.stats.actors);
    // Loss is declared rather than absorbed.
    expect(summary.capabilities.unsupported).toBeGreaterThan(0);
    expect(summary.lossy.length).toBeGreaterThan(0);
    expect(summary.out).toBe(resolve(out));

    const draft = JSON.parse(await readFile(out, "utf8")) as {
      scenarioVersion: number;
      anchor: { pin: { mapId: string } };
      roles: { kind: string }[];
      extensions: { openScenarioImport: { source: { sha256: string } } };
    };
    expect(draft.scenarioVersion).toBe(2);
    expect(draft.anchor.pin.mapId).toBe(mapId);
    expect(draft.roles.every((role) => role.kind === "scene_absolute")).toBe(true);
    // The draft carries the provenance of the document it came from.
    expect(draft.extensions.openScenarioImport.source.sha256).toMatch(/^[0-9a-f]{64}$/);

    // The draft must be a first-class citizen of the pipeline it feeds.
    const revalidated = await runCli(["template", "validate", out], { expectExit: 0 });
    expect(payload<{ ok: boolean }>(revalidated).ok).toBe(true);

    await writeEvidence(e2e, "interop-import-translation", {
      outcome: "verified",
      mapId,
      source: CONFORMANCE_XOSC,
      sourceSha256: draft.extensions.openScenarioImport.source.sha256,
      capabilities: summary.capabilities,
      lossy: summary.lossy,
    });
  });
});

test.describe("OpenSCENARIO export — four distinct claims", () => {
  test("keeps native XML 1.4, esmini compatibility and DSL 2.2 separately labelled", async ({ e2e }) => {
    const mapId = await realMap(e2e);
    const workspace = join(e2e.runsRoot, "interop-export");
    const { instanceFile, instance } = await materialize(mapId, workspace, "export");

    const nativePath = join(workspace, "native.xosc");
    const esminiPath = join(workspace, "esmini-compat.xosc");
    const dslPath = join(workspace, "scenario.osc");

    const native = await runCli(
      ["export", instanceFile, "--format", "xosc-1.4", "--out", nativePath],
      { expectExit: 0 },
    );
    const nativeResult = payload<ExportResult>(native);
    expect(nativeResult.standard).toBe("ASAM OpenSCENARIO XML 1.4.0");
    expect(nativeResult.out).toBe(nativePath);
    const nativeXml = await readFile(nativePath, "utf8");
    expect(nativeXml).toContain('revMajor="1" revMinor="4"');
    // Provenance travels with the artifact: an exported scenario can be traced
    // back to the exact instance that produced it.
    expect(nativeXml).toContain(instance.manifest.inputHash);

    const compat = await runCli(
      ["export", instanceFile, "--format", "xosc-1.3-esmini", "--out", esminiPath],
      { expectExit: 0 },
    );
    const compatResult = payload<ExportResult>(compat);
    // The compatibility target is authored as 1.3.1 and must never be
    // presented as the native 1.4 artifact under another name.
    expect(compatResult.standard).toBe("ASAM OpenSCENARIO XML 1.3.1 · esmini compatibility");
    expect(compatResult.standard).not.toBe(nativeResult.standard);
    const compatXml = await readFile(esminiPath, "utf8");
    expect(compatXml).toContain('revMajor="1" revMinor="3"');
    expect(compatXml).not.toContain('revMinor="4"');

    const dsl = await runCli(
      ["export", instanceFile, "--format", "osc-2.2", "--out", dslPath],
      { expectExit: 0 },
    );
    const dslResult = payload<ExportResult>(dsl);
    expect(dslResult.standard).toBe("ASAM OpenSCENARIO DSL 2.2.0");
    expect(await readFile(dslPath, "utf8")).toContain("import osc.standard");

    // Each profile states its own round-trip and external-validation posture;
    // a consumer reads the capability report, not the file extension.
    for (const result of [nativeResult, compatResult, dslResult]) {
      expect(result.capabilityReport.roundTrip, result.standard).toBeTruthy();
      expect(result.capabilityReport.externalSimulatorValidation, result.standard).toBeTruthy();
      expect(result.bytes, result.standard).toBeGreaterThan(0);
    }
    // Three formats, three distinct artifacts.
    expect(new Set([nativeResult.standard, compatResult.standard, dslResult.standard]).size).toBe(3);

    await writeEvidence(e2e, "interop-export-profiles", {
      outcome: "verified",
      mapId,
      instanceId: instance.manifest.instanceId,
      inputHash: instance.manifest.inputHash,
      profiles: [nativeResult, compatResult, dslResult].map((result) => ({
        format: result.format,
        standard: result.standard,
        profile: result.profile,
        intent: result.intent,
        roundTrip: result.capabilityReport.roundTrip,
        externalSimulatorValidation: result.capabilityReport.externalSimulatorValidation,
        bytes: result.bytes,
        warnings: result.warnings.length,
      })),
    });
  });

  test("fails closed, per profile, on semantics no target can carry", async ({ e2e }) => {
    const mapId = await realMap(e2e);
    const workspace = join(e2e.runsRoot, "interop-unsupported");
    const { instance } = await materialize(mapId, workspace, "unsupported");

    // Deferred spawn: the actor is absent at t=0 and is added mid-clip. Neither
    // trajectory replay (which cannot atomically add an entity and start its
    // timed trajectory) nor DSL 2.2 (which has no standard spawn action) can
    // express this, and each must say so in its own words.
    const deferred = structuredClone(instance);
    const subject = deferred.input.actors.at(-1);
    expect(subject, "the materialized instance must carry actors").toBeTruthy();
    if (subject) {
      subject.presentAtStart = false;
      deferred.input.interactions.push({
        id: "e2e-deferred-spawn",
        actorId: subject.id,
        trigger: { kind: "at", t: 1 },
        verb: "exist",
        target: { state: "present" },
      });
    }
    const deferredFile = join(workspace, "deferred-spawn.instance.json");
    await writeFile(deferredFile, `${JSON.stringify(deferred, null, 2)}\n`, "utf8");

    const xmlRejected = await runCli([
      "export", deferredFile, "--format", "xosc-1.4", "--out", join(workspace, "rejected.xosc"),
    ]);
    expect(xmlRejected.code).toBe(2);
    expect(existsSync(join(workspace, "rejected.xosc"))).toBe(false);
    const xmlError = JSON.parse(xmlRejected.stderr) as CliErrorDetail;
    expect(xmlError.code).toBe("asam_export_unsupported");
    expect(xmlError.detail?.format).toBe("xosc-1.4");
    const xmlIssues = xmlError.detail?.issues ?? [];
    expect(xmlIssues.length).toBeGreaterThan(0);
    expect(xmlIssues.map((issue) => issue.code)).toContain("unsupported_trajectory_spawn");

    const dslRejected = await runCli([
      "export", deferredFile, "--format", "osc-2.2", "--out", join(workspace, "rejected.osc"),
    ]);
    expect(dslRejected.code).toBe(2);
    expect(existsSync(join(workspace, "rejected.osc"))).toBe(false);
    const dslError = JSON.parse(dslRejected.stderr) as CliErrorDetail;
    expect(dslError.code).toBe("asam_export_unsupported");
    expect(dslError.detail?.format).toBe("osc-2.2");
    const dslIssues = dslError.detail?.issues ?? [];
    expect(dslIssues.map((issue) => issue.code)).toContain("unsupported_entity_lifecycle");

    // The two profiles reject for their own reasons. A shared, generic refusal
    // would mean one of them is guessing about the other's semantics.
    expect([...xmlIssues.map((issue) => issue.code)].sort()).not.toEqual(
      [...dslIssues.map((issue) => issue.code)].sort(),
    );
    // Every issue is addressable: a code, the path that caused it, a reason.
    for (const issue of [...xmlIssues, ...dslIssues]) {
      expect(issue.path, issue.code).toBeTruthy();
      expect(issue.reason, issue.code).toBeTruthy();
    }

    await writeEvidence(e2e, "interop-export-fail-closed", {
      outcome: "verified",
      mapId,
      xml14Issues: xmlIssues,
      dsl22Issues: dslIssues,
    });
  });
});

test.describe("OpenSCENARIO external execution — pinned runner and quantitative parity", () => {
  test("runs the exported compatibility package on pinned esmini and scores trajectory parity", async ({ e2e }) => {
    const mapId = await realMap(e2e);
    await requirePrerequisites(e2e, [PINNED_ESMINI, BUILT_INTERCHANGE]);
    const binary = process.env["SIMFORGE_E2E_ESMINI_BIN"] ?? "";

    const workspace = join(e2e.runsRoot, "interop-esmini");
    const bundleDir = join(workspace, "bundle");
    const outputDir = join(workspace, "out");
    await mkdir(bundleDir, { recursive: true });
    await mkdir(outputDir, { recursive: true });

    const { instanceFile, traceFile, instance } = await materialize(mapId, workspace, "esmini");

    // The external runner needs the complete immutable OpenDRIVE beside the
    // scenario; a preview or a relative guess would change what it executed.
    const roadSource = join(e2e.mapsCacheRoot, "dev-assets", mapId, "map.xodr");
    expect(existsSync(roadSource), `the installed corpus must carry ${mapId}/map.xodr`).toBe(true);
    const roadFile = join(bundleDir, "map.xodr");
    await copyFile(roadSource, roadFile);

    const scenarioPath = join(bundleDir, "scenario.xosc");
    const exported = await runCli(
      ["export", instanceFile, "--format", "xosc-1.3-esmini", "--out", scenarioPath, "--road-file", "map.xodr"],
      { expectExit: 0 },
    );
    const exportResult = payload<ExportResult>(exported);
    expect(exportResult.standard).toBe("ASAM OpenSCENARIO XML 1.3.1 · esmini compatibility");

    // Exactly the pinned local invocation the product uses: headless, fixed
    // 20 ms step, trajectory filtering disabled, collision detection on.
    // Loaded dynamically so that an unbuilt workspace surfaces as the
    // prerequisite outcome asserted above rather than a module-load crash
    // that would also take down the export and import flows in this file.
    const esmini: typeof Esmini = await import("../../packages/openscenario/dist/esmini/index.js");
    const traceDiff: typeof TraceDiff = await import("../../packages/openscenario/dist/trace-diff/index.js");
    const args = [...esmini.buildLocalEsminiArguments(scenarioPath, outputDir, ["csv", "log"])];
    const run = await new Promise<{ code: number | null; stdout: string; stderr: string }>((settle) => {
      const child = spawn(binary, args, { cwd: bundleDir });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      child.on("error", (error) => settle({ code: null, stdout, stderr: `${stderr}${error.message}` }));
      child.on("close", (code) => settle({ code, stdout, stderr }));
    });

    const csvPath = join(outputDir, "replay.csv");
    expect(
      existsSync(csvPath),
      `pinned esmini produced no CSV (exit ${String(run.code)}): ${run.stderr.slice(0, 500)}`,
    ).toBe(true);

    // A zero exit can still carry error-level diagnostics; severity comes from
    // the runner's own log lines, never from the exit code alone.
    const esminiErrors = `${run.stdout}\n${run.stderr}`
      .split("\n")
      .filter((line) => line.toLowerCase().includes("[error]"));

    const rawTrace = JSON.parse(gunzipSync(await readFile(traceFile)).toString("utf8")) as CanonicalTrace;
    const canonical = traceDiff.normalizeCanonicalTrace(rawTrace);
    const canonicalActorIds = rawTrace.header.actorIds;

    const external = traceDiff.normalizeExternalTrace(
      esmini.parseEsminiCsv(await readFile(csvPath, "utf8"), {
        durationS: instance.input.clipSeconds,
        requireCompleteClip: false,
      }),
      canonicalActorIds,
    );

    // Mapping must be unambiguous: a parity number computed across a guessed
    // actor correspondence would be worse than no number.
    expect(external.mapping.ambiguousExternalIds).toEqual([]);
    expect(external.mapping.entries.length, "no canonical actor was recognised in the esmini trace")
      .toBeGreaterThan(0);

    const report = traceDiff.compareNormalizedTraces(canonical, external.trace, external.mapping);

    // The verdict is quantitative and attributed: real per-actor error
    // distributions, and every failure carries a class a human can act on.
    expect(["pass", "fail"]).toContain(report.verdict);
    expect(report.globalMetrics.xyM.samples).toBeGreaterThan(0);
    expect(Number.isFinite(report.globalMetrics.xyM.rmse)).toBe(true);
    expect(Number.isFinite(report.globalMetrics.headingRad.p95)).toBe(true);
    expect(report.actorMetrics.length).toBe(external.mapping.entries.length);
    expect(report.canonicalTraceHash).not.toBe(report.externalTraceHash);
    expect(report.reportHash).toMatch(/^[0-9a-f]{64}$/);
    if (report.verdict === "fail") {
      expect(report.failureClasses.length, "a failing verdict must name its failure classes").toBeGreaterThan(0);
      for (const finding of report.findings.filter((item) => item.severity === "error")) {
        expect(finding.classification, finding.code).toBeTruthy();
      }
    } else {
      expect(report.findings.filter((item) => item.severity === "error")).toEqual([]);
    }

    await writeEvidence(e2e, "interop-esmini-parity", {
      outcome: "verified",
      mapId,
      instanceId: instance.manifest.instanceId,
      inputHash: instance.manifest.inputHash,
      runner: { binary, args, exitCode: run.code, errorDiagnostics: esminiErrors },
      export: { standard: exportResult.standard, bytes: exportResult.bytes },
      parity: {
        verdict: report.verdict,
        failureClasses: report.failureClasses,
        profile: report.profile.id,
        globalMetrics: report.globalMetrics,
        metricDelta: report.metricDelta,
        duration: report.duration,
        mappedActors: external.mapping.entries.length,
        unmappedCanonicalActors: external.mapping.missingCanonicalIds,
        findings: report.findings.map((finding) => ({
          code: finding.code,
          severity: finding.severity,
          classification: finding.classification,
        })),
      },
    });
  });
});
