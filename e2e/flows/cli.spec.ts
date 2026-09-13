/**
 * Stack-level CLI flows: the map catalog, the authoring run, render identity
 * and the artifact/receipt contracts the rest of the product reads back.
 *
 * These assert the *consumer-visible* surface of `simforge` — stdout is one
 * JSON document, stderr is one structured error, exit 1 means "you called me
 * wrong" and exit 2 means "your document is wrong" — plus the files and
 * manifests a downstream consumer is told were written. Nothing here inspects
 * product source text, and nothing is mocked: every command runs as a real
 * child process through the harness' isolated data/map roots.
 *
 * Heavyweight inputs (a real installed map corpus, a reachable map registry, a
 * GPU) are never silently skipped. They resolve through the harness
 * prerequisite gate, which records a machine-readable `prerequisite-missing`
 * outcome and fails the test explicitly.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

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

/**
 * The CLI's published contract is "stdout is one JSON document"; the shape of
 * that document per command is the thing under test. Each caller names the
 * fields it is about to assert, and asserts them — the annotation is the
 * expectation, never a substitute for one.
 */
function payload<T>(run: { readonly stdout: string }): T {
  return JSON.parse(run.stdout) as T;
}

/** One structured error object on stderr, per the CLI contract. */
function cliError(run: { readonly stderr: string }): { code: string; path?: string; reason?: string; detail?: Record<string, unknown> } {
  return JSON.parse(run.stderr) as { code: string; path?: string; reason?: string; detail?: Record<string, unknown> };
}

/**
 * `maps list` and `maps pull` talk to a registry. The public CloudFront
 * default would make the suite depend on the open internet, so the flow needs
 * the registry named explicitly — a `file://` mirror is the cheap local form.
 */
const MAP_REGISTRY = definePrerequisite({
  id: "map-registry",
  title: "A reachable SimForge map registry",
  env: ["SIMFORGE_E2E_MAP_REGISTRY_URL"],
  hint: "an https:// or file:// registry URL holding at least one published map version",
});

/** The map version `maps pull` is expected to materialize. */
const MAP_REFERENCE = definePrerequisite({
  id: "map-reference",
  title: "A pullable map reference",
  env: ["SIMFORGE_E2E_MAP_REFERENCE"],
  hint: "for example richmond-field-station or richmond-field-station@v3",
});

/** The worked template every authoring flow drives; it ships in the repo. */
const LTAP_TEMPLATE = resolve(
  import.meta.dirname,
  "..",
  "..",
  "examples",
  "ltap-opposing.template.json",
);

const RENDER_INTENT = resolve(import.meta.dirname, "..", "fixtures", "interop", "render-intent.json");

/**
 * `hashRenderIntent` is the identity a render cache, a receipt and a resumed
 * job all key on, so it is pinned rather than merely self-consistent: a change
 * to the canonicalization is a breaking change for every stored artifact.
 */
const RENDER_INTENT_SHA256 = "b8d564113e92d4b313afcc4a526240eafc68e4736f35b37e94b10fa3da140f0f";

interface CommandSurface {
  commands: { name: string }[];
}

interface RegistryIndex {
  registry: string;
  maps: Record<string, { latest: string }>;
}

interface PullResult {
  name: string;
  version: string;
  closureDigest: string;
  releaseDigest: string;
  materialized: Record<string, string>;
  nativeWorkerInputs: {
    inputId: string;
    relativePath: string;
    materializedPath: string;
    sha256: string;
    sizeBytes: number;
  }[];
}

interface SiteMatch {
  maps: { sites: { siteId: string }[] }[];
}

interface InstanceFile {
  manifest: {
    instanceId: string;
    inputHash: string;
    replayKey: { mapId: string; siteId: string; drawIndex: number };
  };
  input: { actors: { initial: { speedMps: number } }[] };
}

interface SimulateResult {
  traceDigest: string;
  metrics: { minTTC: { value: number } | null };
}

interface EvidenceReceipt {
  ok: boolean;
  actorCount: number;
  issues: { code: string; reason: string }[];
}

interface RenderIdentity {
  schema: string;
  intentId: string;
  intentSha256: string;
}

interface RenderRunSummary {
  intentSha256: string;
  manifestPath: string;
  artifactCount: number;
}

interface RenderArtifactManifest {
  intentSha256: string;
  artifacts: { relativePath: string; sha256: string; sizeBytes: number }[];
}

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

/** Resolve the map this run authors against, linking it into the isolated cache root. */
async function realMap(e2e: E2eContext): Promise<string> {
  await requirePrerequisites(e2e, [PREREQUISITES.realMaps]);
  const corpusRoot = process.env["SIMFORGE_E2E_MAPS_FIXTURE_ROOT"] ?? "";
  const mapId = installedMapId(corpusRoot);
  expect(mapId, `the configured corpus at ${corpusRoot} has no map with derived topology`).not.toBeNull();
  await linkInstalledMaps(e2e, [mapId ?? ""]);
  return mapId ?? "";
}

/** The first executable site for the worked template on `mapId`. */
async function firstSite(mapId: string): Promise<string> {
  const match = await runCli(["sites", "match", LTAP_TEMPLATE, "--map", mapId], { expectExit: 0 });
  const sites = payload<SiteMatch>(match).maps[0]?.sites ?? [];
  expect(sites.length, "the worked template must match at least one concrete site").toBeGreaterThan(0);
  return sites[0]?.siteId ?? "";
}

test.describe("simforge CLI — command surface", () => {
  test("answers with one JSON document and separates caller error from input finding", async ({ e2e }) => {
    const surface = await runCli([], { expectExit: 0 });
    const commands = payload<CommandSurface>(surface).commands.map((command) => command.name);
    for (const name of ["maps list", "maps pull", "simulate", "export", "import", "evidence verify"]) {
      expect(commands, `\`${name}\` must be discoverable from the machine-readable surface`).toContain(name);
    }

    // Exit 1 — the command could not run. stdout stays empty so a caller never
    // parses a half-answer, and stderr is one structured error object.
    const badFlag = await runCli(["maps", "list", "--definitely-not-a-flag"]);
    expect(badFlag.code).toBe(1);
    expect(badFlag.stdout).toBe("");
    const flagError = cliError(badFlag);
    expect(flagError.code).toBe("unknown_flag");

    const badFormat = await runCli(["export", "instance.json", "--format", "xosc-1.9", "--out", "x.xosc"]);
    expect(badFormat.code).toBe(1);
    const formatError = cliError(badFormat);
    expect(formatError).toMatchObject({ code: "bad_value", path: "--format" });
    // The error carries the whole closed set, so a repair loop never guesses.
    expect(formatError.detail?.["known"]).toEqual(["xosc-1.4", "xosc-1.3-esmini", "osc-2.2"]);

    const badSubcommand = await runCli(["maps", "teleport"]);
    expect(badSubcommand.code).toBe(1);
    const subError = cliError(badSubcommand);
    expect(subError.code).toBe("unknown_command");
    expect(subError.detail?.["known"]).toContain("pull");

    await writeEvidence(e2e, "cli-command-surface", {
      outcome: "verified",
      commands,
      errors: { unknownFlag: flagError, badFormat: formatError, unknownCommand: subError },
    });
  });
});

test.describe("simforge CLI — map catalog and downloads", () => {
  test("lists published map versions from the configured registry", async ({ e2e }) => {
    await requirePrerequisites(e2e, [MAP_REGISTRY]);
    const registry = process.env["SIMFORGE_E2E_MAP_REGISTRY_URL"] ?? "";

    const listed = await runCli(["maps", "list", "--registry", registry], { expectExit: 0 });
    const index = payload<RegistryIndex>(listed);
    expect(index.registry).toBe(registry);
    const names = Object.keys(index.maps);
    expect(names.length, "a configured registry must publish at least one map").toBeGreaterThan(0);
    for (const name of names) {
      // `latest` is the immutable version a puller would resolve to.
      expect(index.maps[name]?.latest, name).toMatch(/^v[1-9][0-9]*$/);
    }

    await writeEvidence(e2e, "cli-maps-list", {
      outcome: "verified",
      registry,
      maps: Object.fromEntries(names.map((name) => [name, index.maps[name]?.latest ?? null])),
    });
  });

  test("pull materializes every layout and a byte-verified native input manifest", async ({ e2e }) => {
    await requirePrerequisites(e2e, [MAP_REGISTRY, MAP_REFERENCE]);
    const registry = process.env["SIMFORGE_E2E_MAP_REGISTRY_URL"] ?? "";
    const reference = process.env["SIMFORGE_E2E_MAP_REFERENCE"] ?? "";

    const pulled = await runCli(
      ["maps", "pull", reference, "--registry", registry, "--cache-root", e2e.mapsCacheRoot],
      { expectExit: 0, timeoutMs: 900_000 },
    );
    const result = payload<PullResult>(pulled);

    expect(result.version).toMatch(/^v[1-9][0-9]*$/);
    expect(result.closureDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.releaseDigest).toMatch(/^[0-9a-f]{64}$/);

    // The three profile roots are the product's contract with the native
    // renderer, the viewer and the compiler respectively.
    for (const profile of ["dev-assets", "map-bundles", ".corpus"]) {
      expect(
        existsSync(join(e2e.mapsCacheRoot, profile, result.name)),
        `pull must materialize ${profile}/${result.name}`,
      ).toBe(true);
    }

    // The manifest is a download receipt. Every declared member must exist and
    // hash to its declared digest, or the renderer is being handed a claim
    // rather than a verified closure.
    expect(result.nativeWorkerInputs.length).toBeGreaterThan(0);
    const master = result.nativeWorkerInputs.find((input) => input.relativePath === "master.gltf");
    expect(master?.inputId, "the master document is the renderer's tile zero").toBe("map.tile.000000");
    for (const input of result.nativeWorkerInputs) {
      const bytes = await readFile(input.materializedPath);
      expect(createHash("sha256").update(bytes).digest("hex"), input.relativePath).toBe(input.sha256);
      expect(bytes.byteLength, input.relativePath).toBe(input.sizeBytes);
      expect(input.inputId).toMatch(/^map\.(tile|resource)\./);
    }

    // Source rasters are deliberately excluded from the native closure.
    expect(result.nativeWorkerInputs.some((input) => input.relativePath.endsWith(".png"))).toBe(false);

    await writeEvidence(e2e, "cli-maps-pull", {
      outcome: "verified",
      registry,
      reference,
      name: result.name,
      version: result.version,
      closureDigest: result.closureDigest,
      releaseDigest: result.releaseDigest,
      materialized: result.materialized,
      verifiedInputs: result.nativeWorkerInputs.map((input) => ({
        inputId: input.inputId,
        relativePath: input.relativePath,
        sha256: input.sha256,
        sizeBytes: input.sizeBytes,
      })),
    });
  });
});

test.describe("simforge CLI — authoring run and evidence receipts", () => {
  test("drives template → site → instance → trace → verdict on a real map", async ({ e2e }) => {
    const mapId = await realMap(e2e);
    const workspace = join(e2e.runsRoot, "cli-run");
    await mkdir(workspace, { recursive: true });
    const instanceFile = join(workspace, "run.instance.json");
    const traceFile = join(workspace, "run.trace.json.gz");

    const validated = await runCli(["template", "validate", LTAP_TEMPLATE], { expectExit: 0 });
    expect(payload<{ ok: boolean; counts: { error: number } }>(validated)).toMatchObject({
      ok: true,
      counts: { error: 0 },
    });

    const siteId = await firstSite(mapId);
    const instantiated = await runCli([
      "instantiate", LTAP_TEMPLATE,
      "--map", mapId,
      "--site", siteId,
      "--draw", "0",
      "--out", instanceFile,
    ]);
    // 2 is "the document has findings", not "the command failed"; either way the
    // concrete instance is on disk and carries its replay key.
    expect([0, 2]).toContain(instantiated.code);
    const instance = payload<InstanceFile>(instantiated);
    expect(instance.manifest.replayKey).toMatchObject({ mapId, siteId, drawIndex: 0 });
    expect(instance.manifest.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(instanceFile)).toBe(true);

    const simulated = await runCli(["simulate", instanceFile, "--trace", traceFile]);
    expect([0, 2]).toContain(simulated.code);
    const trace = payload<SimulateResult>(simulated);
    expect(trace.traceDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(traceFile)).toBe(true);

    const evaluated = await runCli(["evaluate", traceFile]);
    expect([0, 2]).toContain(evaluated.code);
    const verdict = payload<{ verdict: string; band: string }>(evaluated);
    expect(["accept", "reject"]).toContain(verdict.verdict);
    expect(verdict.band).toBeTruthy();

    // Same pinned inputs, same seed ⇒ the same trace. A replayable corpus is
    // the whole point of the replay key.
    const replayInstance = join(workspace, "replay.instance.json");
    const replayFile = join(workspace, "replay.trace.json.gz");
    await runCli([
      "instantiate", LTAP_TEMPLATE, "--map", mapId, "--site", siteId, "--draw", "0", "--out", replayInstance,
    ]);
    const replayed = await runCli(["simulate", replayInstance, "--trace", replayFile]);
    expect(payload<SimulateResult>(replayed).traceDigest).toBe(trace.traceDigest);

    await writeEvidence(e2e, "cli-authoring-run", {
      outcome: "verified",
      mapId,
      siteId,
      instanceId: instance.manifest.instanceId,
      inputHash: instance.manifest.inputHash,
      traceDigest: trace.traceDigest,
      verdict,
    });
  });

  test("invalidates a stale evidence receipt once the instance is edited", async ({ e2e }) => {
    const mapId = await realMap(e2e);
    const workspace = join(e2e.runsRoot, "cli-receipt");
    await mkdir(workspace, { recursive: true });
    const instanceFile = join(workspace, "receipt.instance.json");
    const traceFile = join(workspace, "receipt.trace.json.gz");

    const siteId = await firstSite(mapId);
    await runCli([
      "instantiate", LTAP_TEMPLATE, "--map", mapId, "--site", siteId, "--draw", "0", "--out", instanceFile,
    ]);
    const simulated = await runCli(["simulate", instanceFile, "--trace", traceFile]);
    const originalDigest = payload<SimulateResult>(simulated).traceDigest;

    const fresh = await runCli(["evidence", "verify", instanceFile, traceFile], { expectExit: 0 });
    const freshReceipt = payload<EvidenceReceipt>(fresh);
    expect(freshReceipt.ok).toBe(true);
    expect(freshReceipt.actorCount).toBeGreaterThan(0);
    expect(freshReceipt.issues).toEqual([]);

    // Edit the scenario the way an author would: nudge an actor's initial
    // speed. The trace on disk now describes a different scenario, so the
    // receipt joining them must break instead of quietly certifying metrics.
    const edited = JSON.parse(await readFile(instanceFile, "utf8")) as InstanceFile;
    const firstActor = edited.input.actors[0];
    expect(firstActor, "the materialized instance must carry at least one actor").toBeTruthy();
    if (firstActor) firstActor.initial.speedMps += 0.5;
    const editedFile = join(workspace, "receipt-edited.instance.json");
    await writeFile(editedFile, `${JSON.stringify(edited, null, 2)}\n`, "utf8");

    const stale = await runCli(["evidence", "verify", editedFile, traceFile]);
    expect(stale.code).toBe(2);
    const staleReceipt = payload<EvidenceReceipt>(stale);
    expect(staleReceipt.ok).toBe(false);
    expect(staleReceipt.issues.map((issue) => issue.code)).toContain("instance_input_hash_mismatch");

    // Re-running the edited scenario mints a genuinely new receipt: a
    // different trace identity that verifies against the edited instance.
    const reTraceFile = join(workspace, "receipt-edited.trace.json.gz");
    const reSimulated = await runCli(["simulate", editedFile, "--trace", reTraceFile]);
    const newDigest = payload<SimulateResult>(reSimulated).traceDigest;
    expect(newDigest).not.toBe(originalDigest);
    const revalidated = await runCli(["evidence", "verify", editedFile, reTraceFile], { expectExit: 0 });
    expect(payload<EvidenceReceipt>(revalidated).ok).toBe(true);

    // And the superseded trace is still rejected against the edited instance.
    const stillStale = await runCli(["evidence", "verify", editedFile, traceFile]);
    expect(stillStale.code).toBe(2);

    await writeEvidence(e2e, "cli-stale-receipt", {
      outcome: "verified",
      mapId,
      siteId,
      originalTraceDigest: originalDigest,
      editedTraceDigest: newDigest,
      staleIssues: staleReceipt.issues.map((issue) => issue.code),
    });
  });
});

test.describe("simforge CLI — render identity and artifact manifests", () => {
  test("render hash is a stable content identity for a render intent", async ({ e2e }) => {
    const hashed = await runCli(["render", "hash", RENDER_INTENT], { expectExit: 0 });
    const identity = payload<RenderIdentity>(hashed);
    expect(identity).toMatchObject({
      schema: "simforge.render-intent/v1",
      intentId: "usri_e2e_interop",
      intentSha256: RENDER_INTENT_SHA256,
    });

    await mkdir(e2e.runsRoot, { recursive: true });

    // The identity is over intent content, not over file bytes: reformatting
    // the document must not invent a new render job.
    const reformatted = join(e2e.runsRoot, "render-intent-reformatted.json");
    await writeFile(reformatted, JSON.stringify(JSON.parse(await readFile(RENDER_INTENT, "utf8"))), "utf8");
    const rehashed = await runCli(["render", "hash", reformatted], { expectExit: 0 });
    expect(payload<RenderIdentity>(rehashed).intentSha256).toBe(RENDER_INTENT_SHA256);

    // An authored edit is a different job.
    const editedIntent = JSON.parse(await readFile(RENDER_INTENT, "utf8")) as { seed: number };
    editedIntent.seed = 8;
    const editedPath = join(e2e.runsRoot, "render-intent-edited.json");
    await writeFile(editedPath, JSON.stringify(editedIntent), "utf8");
    const editedHash = await runCli(["render", "hash", editedPath], { expectExit: 0 });
    const editedSha256 = payload<RenderIdentity>(editedHash).intentSha256;
    expect(editedSha256).not.toBe(RENDER_INTENT_SHA256);

    await writeEvidence(e2e, "cli-render-identity", {
      outcome: "verified",
      intentSha256: identity.intentSha256,
      editedIntentSha256: editedSha256,
    });
  });

  test("render run writes an artifact manifest whose every entry is verified on disk", async ({ e2e }) => {
    // A real render needs a real engine. Nothing below is meaningful against a
    // stub, so the GPU prerequisite fails loudly rather than pretending.
    await requirePrerequisites(e2e, [PREREQUISITES.gpu]);
    const mapId = await realMap(e2e);

    const workspace = join(e2e.runsRoot, "render-run");
    await mkdir(workspace, { recursive: true });
    const inputsPath = join(workspace, "inputs.json");
    const xodr = join(e2e.mapsCacheRoot, "dev-assets", mapId, "map.xodr");
    expect(existsSync(xodr), `the installed corpus must carry ${mapId}/map.xodr`).toBe(true);
    await writeFile(inputsPath, JSON.stringify({ "map.xodr": xodr }), "utf8");

    const run = await runCli(
      ["render", "run", RENDER_INTENT, "--engine", "browser", "--inputs", inputsPath, "--out", workspace],
      { expectExit: 0, timeoutMs: 900_000 },
    );
    const summary = payload<RenderRunSummary>(run);
    expect(summary.intentSha256).toBe(RENDER_INTENT_SHA256);
    expect(summary.artifactCount).toBeGreaterThan(0);

    const manifest = JSON.parse(await readFile(summary.manifestPath, "utf8")) as RenderArtifactManifest;
    expect(manifest.intentSha256).toBe(RENDER_INTENT_SHA256);
    expect(manifest.artifacts.length).toBe(summary.artifactCount);
    for (const artifact of manifest.artifacts) {
      const bytes = await readFile(join(workspace, artifact.relativePath));
      expect(createHash("sha256").update(bytes).digest("hex"), artifact.relativePath).toBe(artifact.sha256);
      expect(bytes.byteLength, artifact.relativePath).toBe(artifact.sizeBytes);
      // The manifest may never point outside the directory it describes.
      expect(resolve(workspace, artifact.relativePath).startsWith(`${workspace}/`)).toBe(true);
    }

    await writeEvidence(e2e, "cli-render-artifacts", {
      outcome: "verified",
      mapId,
      intentSha256: manifest.intentSha256,
      artifacts: manifest.artifacts.map((artifact) => ({
        relativePath: artifact.relativePath,
        sha256: artifact.sha256,
        sizeBytes: artifact.sizeBytes,
      })),
    });
  });
});
