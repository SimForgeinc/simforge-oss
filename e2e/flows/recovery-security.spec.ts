import { gzipSync } from "node:zlib";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  PREREQUISITES,
  expect,
  launchBrowserStudio,
  prerequisiteStatus,
  requirePrerequisites,
  runCli,
  startFixtureServer,
  test,
  writeEvidence,
  type CliResult,
  type FixtureResponse,
  type FixtureServer,
  type RecordedRequest,
  type StudioSession,
} from "../support";

/**
 * The negative half of the product: every path where SimForge must refuse.
 *
 * A generation pipeline that fails loudly is usable; one that fails quietly is
 * worse than one that does not run at all, because a silent failure is
 * indistinguishable from a result. So each test here asserts two things, never
 * one:
 *
 *   1. **Classification** — the refusal carries the product's own code or
 *      message, not a stack trace and not a generic 500.
 *   2. **No false receipt, and a clean root** — nothing downstream may look
 *      like it succeeded: no installed map, no job row, no partial file, no
 *      session cookie.
 *
 * Expected codes live in `e2e/fixtures/recovery/expectations.json` beside the
 * production file each one comes from, so a rename is a fixture diff.
 */

type RecoveryExpectations = {
  sessionGate: {
    unauthorizedCode: string;
    replayedTicketCode: string;
    invalidTargetCode: string;
    rejectedTargets: string[];
    acceptedTarget: string;
  };
  cliContract: { failureExits: number[]; structuredErrorFields: string[]; successReceiptPatterns: string[] };
  registryDenial: { status: number; body: { error: string; message: string }; reasonTerms: string[] };
  transferIntegrity: {
    truncatedBodyBytes: number;
    declaredContentLength: number;
    corruptDigest: string;
    partialArtifactSuffixes: string[];
    integrityReasonTerms: string[];
  };
  storageRefusal: { reasonTerms: string[] };
  renderJobs: { invalidSubmissionCode: string; unknownJobCode: string; workerFailureCodes: string[] };
  modelRuns: {
    unknownRunCode: string;
    notInstalledState: string;
    verifySchema: string;
    cancelSchema: string;
    offeredFamilies: string[];
    unknownFamilyCode: string;
  };
  jobs: { unknownJobCode: string };
  validationRuns: { invalidBodyCode: string };
  secretHygiene: {
    decoySecret: string;
    decoyEnvVar: string;
    redactionPlaceholder: string;
    forbiddenUrlTerms: string[];
  };
};

/** The error envelope every Studio route uses for a refusal. */
type RouteErrorBody = {
  error?: string;
  message?: string;
  detail?: string;
  details?: unknown;
  url?: string;
};

/** What a failing CLI invocation puts on stderr, per the repository CLI contract. */
type CliErrorEnvelope = {
  code: string;
  reason?: string;
  path?: string;
  detail?: unknown;
};

type TicketMintBody = { url: string };
type ValidationRunListBody = { validationRuns: unknown[] };
type RenderJobListBody = { renderJobs?: unknown[] };
type ModelsVerifyReport = { schema?: string; ok?: boolean; failed?: unknown[]; checkpointDigest?: string };
type ModelsCancelReport = { schema?: string; state?: { state?: string } };
/** `simforge template validate` — `ok`, the issue list and the severity counts. */
type TemplateValidateReport = { ok?: boolean; issues?: unknown[]; counts?: { error?: number } };
type SiteMatchReport = { sites?: { siteId: string; map: string }[] };

const FIXTURE_ROOT = new URL("../fixtures/recovery/", import.meta.url);

let cachedExpectations: RecoveryExpectations | undefined;

async function expectations(): Promise<RecoveryExpectations> {
  // This suite's own data file, parsed once per worker.
  cachedExpectations ??= JSON.parse(
    await readFile(new URL("expectations.json", FIXTURE_ROOT), "utf8"),
  ) as RecoveryExpectations;
  return cachedExpectations;
}

/** Every file under a root, relative to it, so a test can prove nothing was left behind. */
async function walk(root: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      // A directory the refusal never created is the strongest possible result.
      return;
    }
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(join(directory, entry.name), relative);
      else found.push(relative);
    }
  };
  await visit(root, "");
  return found.sort();
}

/** Half-written downloads a refused or interrupted transfer must never leave behind. */
async function partialArtifacts(root: string): Promise<string[]> {
  const suffixes = (await expectations()).transferIntegrity.partialArtifactSuffixes;
  return (await walk(root)).filter((entry) => suffixes.some((suffix) => entry.endsWith(suffix)));
}

/**
 * The refusal contract shared by every failing CLI invocation: a non-zero exit
 * from the documented set, a structured `{code, reason}` on stderr rather than
 * a crash, a stdout no repair loop could mistake for a success receipt, and a
 * reason naming something the operator can act on.
 */
async function expectClassifiedCliFailure(
  result: CliResult,
  actionableTerms: readonly string[],
): Promise<CliErrorEnvelope> {
  const contract = (await expectations()).cliContract;
  expect(
    contract.failureExits,
    `expected a documented failure exit, got ${result.code}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  ).toContain(result.code);

  let envelope: CliErrorEnvelope | undefined;
  for (const line of result.stderr.split("\n")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed !== null && typeof parsed === "object" && "code" in parsed && typeof parsed.code === "string") {
      // Narrowed here: a string `code` is the whole contract this helper needs.
      envelope = parsed as CliErrorEnvelope;
    }
  }
  expect(
    envelope,
    `stderr must carry a structured {code, reason} error, received:\n${result.stderr}`,
  ).toBeTruthy();
  for (const field of contract.structuredErrorFields) expect(envelope).toHaveProperty(field);
  // A stack trace on stderr means the failure escaped instead of being classified.
  expect(result.stderr).not.toMatch(/\n\s+at .*\(.*:\d+:\d+\)/);
  for (const pattern of contract.successReceiptPatterns) {
    expect(result.stdout).not.toMatch(new RegExp(pattern));
  }

  const haystack = [envelope?.code, envelope?.reason, envelope?.path, JSON.stringify(envelope?.detail ?? "")]
    .join(" ")
    .toLowerCase();
  expect(
    actionableTerms.some((term) => haystack.includes(term.toLowerCase())),
    `refusal must be actionable — expected one of [${actionableTerms.join(", ")}] in: ${haystack}`,
  ).toBe(true);
  return envelope!;
}

/**
 * Drive `maps pull` against a hostile registry without hard-coding the registry
 * wire paths into this suite.
 *
 * The fixture server matches routes by exact path, and which paths the client
 * asks for is the map-registry protocol's business, not this test's. So the
 * pull runs, the paths it requested are recorded, the responder is installed on
 * each of them, and it runs again — repeating until no new path appears. The
 * returned result is the run where the registry answered with the fault under
 * test on every path the client touched.
 */
async function pullAgainstRegistry(
  server: FixtureServer,
  reference: string,
  respond: (request: RecordedRequest) => FixtureResponse,
  run: (registry: string) => Promise<CliResult>,
): Promise<CliResult> {
  const covered = new Set<string>();
  let result = await run(server.origin);
  for (let round = 0; round < 4; round += 1) {
    const fresh = server.requests.map((request) => request.path).filter((path) => !covered.has(path));
    if (fresh.length === 0) break;
    for (const path of fresh) {
      covered.add(path);
      server.setRoute(path, respond);
    }
    result = await run(server.origin);
  }
  expect(
    covered.size,
    `the CLI never contacted the fixture registry for ${reference}`,
  ).toBeGreaterThan(0);
  return result;
}

test.describe("recovery: the local session gate", () => {
  test("a wrong control token cannot mint a browser session", async ({ studio, request }, testInfo) => {
    const gate = (await expectations()).sessionGate;
    const response = await request.post(studio.url("/api/simforge/host/session"), {
      headers: { authorization: "Bearer not-the-control-token" },
      data: { next: gate.acceptedTarget },
    });
    const body: RouteErrorBody = await response.json();

    expect(response.status()).toBe(401);
    expect(body.error).toBe(gate.unauthorizedCode);
    // A refusal that still hands out a cookie is not a refusal.
    expect(response.headers()["set-cookie"]).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(studio.controlToken);

    await writeEvidence(testInfo, "session-control-token-mismatch", {
      outcome: "refused",
      classification: body.error,
      status: response.status(),
      cookieGranted: false,
    });
  });

  test("a browser ticket is single-use: a replay is refused and grants nothing", async ({ studio, request }, testInfo) => {
    const gate = (await expectations()).sessionGate;
    const minted = await request.post(studio.url("/api/simforge/host/session"), {
      headers: { authorization: `Bearer ${studio.controlToken}` },
      data: { next: gate.acceptedTarget },
    });
    expect(minted.status()).toBe(200);
    const ticket: TicketMintBody = await minted.json();
    // The one-use value travels in the redemption URL; the per-start secret never does.
    expect(ticket.url).not.toContain(studio.controlToken);

    const first = await request.get(ticket.url, { maxRedirects: 0 });
    expect(first.status()).toBe(303);
    expect(first.headers()["set-cookie"]).toBeTruthy();

    const replay = await request.get(ticket.url, { maxRedirects: 0 });
    const replayBody: RouteErrorBody = await replay.json();
    expect(replay.status()).toBe(401);
    expect(replayBody.error).toBe(gate.replayedTicketCode);
    expect(replay.headers()["set-cookie"]).toBeUndefined();
    expect(replay.headers()["location"]).toBeUndefined();

    await writeEvidence(testInfo, "session-ticket-replay", {
      outcome: "refused",
      classification: replayBody.error,
      firstRedemptionStatus: first.status(),
      replayStatus: replay.status(),
      replayGrantedCookie: false,
    });
  });

  test("session redemption refuses traversal and foreign redirect targets", async ({ studio, request }, testInfo) => {
    const gate = (await expectations()).sessionGate;
    const rejected: { target: string; status: number; error?: string }[] = [];

    for (const target of gate.rejectedTargets) {
      const response = await request.post(studio.url("/api/simforge/host/session"), {
        headers: { authorization: `Bearer ${studio.controlToken}` },
        data: { next: target },
      });
      const body: RouteErrorBody = await response.json();
      expect(response.status(), `target ${target} must be refused`).toBe(400);
      expect(body.error).toBe(gate.invalidTargetCode);
      // No redeemable ticket may exist for a target the gate rejected.
      expect(body.url).toBeUndefined();
      rejected.push({ target, status: response.status(), error: body.error });
    }

    // The same route still serves the legitimate target, so the refusals above
    // are a policy decision rather than a broken route.
    const accepted = await request.post(studio.url("/api/simforge/host/session"), {
      headers: { authorization: `Bearer ${studio.controlToken}` },
      data: { next: gate.acceptedTarget },
    });
    expect(accepted.status()).toBe(200);
    const acceptedTicket: TicketMintBody = await accepted.json();
    expect(new URL(acceptedTicket.url).origin).toBe(new URL(studio.baseUrl).origin);

    await writeEvidence(testInfo, "session-target-policy", {
      outcome: "refused",
      classification: gate.invalidTargetCode,
      rejected,
      acceptedTarget: gate.acceptedTarget,
    });
  });

  test("a cross-origin mutation is refused and writes nothing", async ({ studio }, testInfo) => {
    const validation = (await expectations()).validationRuns;
    const listBefore = await studio.page.request.get(studio.url("/api/simforge/validation-runs"));
    expect(listBefore.status()).toBe(200);
    const before: ValidationRunListBody = await listBefore.json();

    const foreign = await studio.page.request.post(studio.url("/api/simforge/validation-runs"), {
      headers: { origin: "https://attacker.invalid", "content-type": "application/json" },
      data: { revisionId: "revision-that-never-existed", validatorKind: "tier1" },
    });
    expect(foreign.ok()).toBe(false);
    // A refusal, not a crash.
    expect(foreign.status()).toBeLessThan(500);

    // A same-origin request whose body the contract rejects must be classified
    // with the offending fields named, not answered with a bare 400.
    const malformed = await studio.page.request.post(studio.url("/api/simforge/validation-runs"), {
      headers: { "content-type": "application/json" },
      data: { revisionId: 17 },
    });
    const malformedBody: RouteErrorBody = await malformed.json();
    expect(malformed.status()).toBe(400);
    expect(malformedBody.error).toBe(validation.invalidBodyCode);
    expect(malformedBody.details).toBeTruthy();

    const listAfter = await studio.page.request.get(studio.url("/api/simforge/validation-runs"));
    const after: ValidationRunListBody = await listAfter.json();
    expect(after.validationRuns.length).toBe(before.validationRuns.length);

    await writeEvidence(testInfo, "validation-run-refusals", {
      outcome: "refused",
      crossOriginStatus: foreign.status(),
      malformedClassification: malformedBody.error,
      runsBefore: before.validationRuns.length,
      runsAfter: after.validationRuns.length,
    });
  });
});

test.describe("recovery: private maps and transfer integrity", () => {
  test("an unauthorized private registry is refused and installs nothing", async ({ e2e }, testInfo) => {
    const { registryDenial, transferIntegrity } = await expectations();
    const server = await startFixtureServer();
    e2e.register(() => server.stop());

    const result = await pullAgainstRegistry(
      server,
      "restricted-private-map@1",
      () => ({ status: registryDenial.status, body: registryDenial.body }),
      (registry) =>
        runCli(
          ["maps", "pull", "restricted-private-map@1", "--registry", registry, "--cache-root", e2e.mapsCacheRoot],
          { ctx: e2e },
        ),
    );

    const envelope = await expectClassifiedCliFailure(result, [
      ...registryDenial.reasonTerms,
      ...transferIntegrity.integrityReasonTerms,
    ]);
    // The refusal must be total: an unauthorized map leaves no corpus entry and
    // no half-written blob for a later resume to adopt.
    expect(await partialArtifacts(e2e.mapsCacheRoot)).toEqual([]);
    expect(await walk(e2e.mapsCacheRoot)).toEqual([]);

    await writeEvidence(testInfo, "private-registry-denied", {
      outcome: "refused",
      classification: envelope.code,
      reason: envelope.reason ?? null,
      exitCode: result.code,
      registryStatus: registryDenial.status,
      requestPaths: [...new Set(server.requests.map((request) => request.path))].sort(),
      cacheEntriesAfter: 0,
    });
  });

  test("a transfer that ends mid-stream installs nothing and promotes no partial", async ({ e2e }, testInfo) => {
    const { transferIntegrity } = await expectations();
    // A real gzip stream cut short: what an interrupted download actually leaves
    // behind, and what the consumer must refuse rather than half-read.
    const truncated = gzipSync(Buffer.alloc(transferIntegrity.declaredContentLength, 0x41)).subarray(
      0,
      transferIntegrity.truncatedBodyBytes,
    );
    const server = await startFixtureServer();
    e2e.register(() => server.stop());

    const result = await pullAgainstRegistry(
      server,
      "interrupted-map@1",
      () => ({
        status: 200,
        headers: { "content-type": "application/gzip" },
        body: truncated,
      }),
      (registry) =>
        runCli(["maps", "pull", "interrupted-map@1", "--registry", registry, "--cache-root", e2e.mapsCacheRoot], {
          ctx: e2e,
        }),
    );

    const envelope = await expectClassifiedCliFailure(result, transferIntegrity.integrityReasonTerms);
    expect(await partialArtifacts(e2e.mapsCacheRoot)).toEqual([]);
    expect(await walk(e2e.mapsCacheRoot)).toEqual([]);

    await writeEvidence(testInfo, "map-transfer-interrupted", {
      outcome: "refused",
      classification: envelope.code,
      reason: envelope.reason ?? null,
      exitCode: result.code,
      bytesServed: truncated.byteLength,
      partialsLeft: [],
    });
  });

  test("a bundle whose bytes do not match its digest is refused, not cached", async ({ e2e }, testInfo) => {
    const { transferIntegrity } = await expectations();
    const forged = Buffer.from("this is not the bundle the manifest describes", "utf8");
    const server = await startFixtureServer();
    e2e.register(() => server.stop());

    const result = await pullAgainstRegistry(
      server,
      "corrupt-map@1",
      (request) =>
        request.path.endsWith(".json") || request.path.endsWith("/")
          ? {
              status: 200,
              body: {
                schema: "simforge.map-registry-index/v1",
                maps: [
                  {
                    id: "corrupt-map",
                    version: "1",
                    active: true,
                    bundle: {
                      url: "/corrupt-map-1.bundle",
                      sizeBytes: forged.byteLength,
                      digest: transferIntegrity.corruptDigest,
                    },
                  },
                ],
              },
            }
          : { status: 200, headers: { "content-type": "application/octet-stream" }, body: forged },
      (registry) =>
        runCli(["maps", "pull", "corrupt-map@1", "--registry", registry, "--cache-root", e2e.mapsCacheRoot], {
          ctx: e2e,
        }),
    );

    const envelope = await expectClassifiedCliFailure(result, transferIntegrity.integrityReasonTerms);
    expect(await partialArtifacts(e2e.mapsCacheRoot)).toEqual([]);
    expect(await walk(e2e.mapsCacheRoot)).toEqual([]);

    await writeEvidence(testInfo, "map-bundle-digest-mismatch", {
      outcome: "refused",
      classification: envelope.code,
      reason: envelope.reason ?? null,
      exitCode: result.code,
      advertisedDigest: transferIntegrity.corruptDigest,
      cacheEntriesAfter: 0,
    });
  });

  test("a cache root that cannot hold the corpus is refused with the path named", async ({ e2e }, testInfo) => {
    const { storageRefusal } = await expectations();
    // A regular file standing in for a parent directory: deterministic ENOTDIR on
    // every platform and for every uid, unlike a chmod that root ignores.
    const blocker = join(e2e.runsRoot, "not-a-directory");
    await writeFile(blocker, "occupied", "utf8");
    const cacheRoot = join(blocker, "maps");

    const result = await runCli(["maps", "pull", "richmond-field-station", "--cache-root", cacheRoot], { ctx: e2e });

    const envelope = await expectClassifiedCliFailure(result, storageRefusal.reasonTerms);
    // The blocker is untouched, and no sibling directory was invented beside it.
    expect((await stat(blocker)).isFile()).toBe(true);
    expect(await readFile(blocker, "utf8")).toBe("occupied");
    expect(await walk(e2e.mapsCacheRoot)).toEqual([]);

    await writeEvidence(testInfo, "map-cache-root-refused", {
      outcome: "refused",
      classification: envelope.code,
      reason: envelope.reason ?? null,
      exitCode: result.code,
      cacheRoot,
      blockerIntact: true,
    });
  });
});

test.describe("recovery: render and worker failure", () => {
  test("an invalid render submission is classified and creates no job", async ({ studio }, testInfo) => {
    const { renderJobs } = await expectations();
    const listBefore = await studio.page.request.get(studio.url("/api/simforge/render-jobs"));
    expect(listBefore.status()).toBe(200);
    const before: RenderJobListBody = await listBefore.json();
    const beforeCount = before.renderJobs?.length ?? 0;

    const submitted = await studio.page.request.post(studio.url("/api/simforge/render-jobs"), {
      headers: { "content-type": "application/json" },
      data: { revisionId: "", intent: { engine: "not-an-engine" } },
    });
    const body: RouteErrorBody = await submitted.json();
    expect(submitted.status()).toBe(400);
    expect(body.error).toBe(renderJobs.invalidSubmissionCode);
    // `details` is what makes the refusal actionable: which field, and why.
    expect(body.details).toBeTruthy();
    // No receipt: a rejected submission has no job identity.
    expect(body).not.toHaveProperty("id");

    const listAfter = await studio.page.request.get(studio.url("/api/simforge/render-jobs"));
    const after: RenderJobListBody = await listAfter.json();
    expect(after.renderJobs?.length ?? 0).toBe(beforeCount);

    await writeEvidence(testInfo, "render-submission-rejected", {
      outcome: "refused",
      classification: body.error,
      status: submitted.status(),
      jobsBefore: beforeCount,
      jobsAfter: after.renderJobs?.length ?? 0,
    });
  });

  test("an unknown render job yields no fabricated detail, provenance or download", async ({ studio }, testInfo) => {
    const { renderJobs } = await expectations();
    const unknown = "render-job-that-never-existed";
    const observed: { probe: string; status: number; error?: string }[] = [];

    for (const probe of ["detail", "provenance", "downloads"] as const) {
      const response = await studio.page.request.get(studio.url(`/api/simforge/render-jobs/${unknown}/${probe}`));
      const text = await response.text();
      expect(response.ok(), `${probe} must not succeed for a job that does not exist`).toBe(false);
      expect(response.status()).toBeLessThan(500);
      // Never an artifact list for a job that never ran.
      expect(text).not.toMatch(/"artifacts"\s*:\s*\[\s*\{/);
      let error: string | undefined;
      try {
        const parsed: RouteErrorBody = JSON.parse(text);
        error = parsed.error;
      } catch {
        error = undefined;
      }
      observed.push({ probe, status: response.status(), error });
    }

    expect(
      observed.some((entry) => entry.error === renderJobs.unknownJobCode),
      `at least one probe must classify the miss as ${renderJobs.unknownJobCode}: ${JSON.stringify(observed)}`,
    ).toBe(true);

    await writeEvidence(testInfo, "render-job-unknown", {
      outcome: "refused",
      classification: renderJobs.unknownJobCode,
      probes: observed,
    });
  });

  test("cancelling a job that does not exist never reports a cancellation", async ({ studio }, testInfo) => {
    const { jobs } = await expectations();
    const response = await studio.page.request.delete(studio.url("/api/simforge/jobs/job-that-never-existed"), {
      headers: { "content-type": "application/json" },
    });
    const text = await response.text();
    expect(response.ok()).toBe(false);
    expect(response.status()).toBeLessThan(500);
    // No cancellation receipt for a job that was never scheduled.
    expect(text).not.toMatch(/"cancelRequestedAt"\s*:\s*"/);
    const body: RouteErrorBody = JSON.parse(text);
    expect(body.error).toBe(jobs.unknownJobCode);

    const list = await studio.page.request.get(studio.url("/api/simforge/jobs"));
    expect(list.status()).toBe(200);
    expect(await list.text()).not.toContain("job-that-never-existed");

    await writeEvidence(testInfo, "job-cancel-unknown", {
      outcome: "refused",
      classification: body.error,
      status: response.status(),
    });
  });

  test("the native render path is gated on real assets rather than faked", async ({ e2e }, testInfo) => {
    const status = prerequisiteStatus(PREREQUISITES.nativeRunner, PREREQUISITES.realMaps);
    // Declared, never silently skipped: without the runner and the corpus this
    // suite cannot make a claim about native rendering, and says so by failing.
    await requirePrerequisites(testInfo, [PREREQUISITES.nativeRunner, PREREQUISITES.realMaps]);

    // With the real inputs present, an intent naming a map this corpus does not
    // hold must be refused at hash/preflight rather than rendered blank.
    const intentPath = join(e2e.runsRoot, "unprepared-intent.json");
    await writeFile(
      intentPath,
      `${JSON.stringify({ schema: "simforge.render-intent/v3", map: "map-not-in-this-corpus", shots: [] }, null, 2)}\n`,
      "utf8",
    );
    const result = await runCli(["render", "hash", intentPath], { ctx: e2e });
    const envelope = await expectClassifiedCliFailure(result, [
      "map",
      "schema",
      "intent",
      "unresolved",
      "not_installed",
    ]);

    await writeEvidence(testInfo, "native-render-unprepared", {
      outcome: "refused",
      classification: envelope.code,
      reason: envelope.reason ?? null,
      exitCode: result.code,
      prerequisitesSatisfied: status.satisfied,
    });
  });
});

test.describe("recovery: model installs and runs", () => {
  test("a model that was never installed verifies as failed and stays uninstalled", async ({ e2e }, testInfo) => {
    const { modelRuns } = await expectations();
    // The model store lives outside the data root by design, so it needs its own
    // sandbox variable or this test would read the developer's real weights.
    const assetsRoot = join(e2e.runsRoot, "model-assets");
    await mkdir(assetsRoot, { recursive: true });
    const env = { SIMFORGE_ASSETS_ROOT: assetsRoot };
    const [family] = modelRuns.offeredFamilies;
    if (family === undefined) throw new Error("the expectations fixture must pin at least one model family");

    const listed = await runCli(["models", "list"], { ctx: e2e, env });
    expect(listed.code).toBe(0);
    expect(listed.stdout, "the catalog must still offer the family this test pins").toContain(family);

    const verify = await runCli(["models", "verify", family], { ctx: e2e, env, expectExit: 2 });
    const report: ModelsVerifyReport = JSON.parse(verify.stdout);
    // Exit 2 is the documented "ran, and found the machine wrong" outcome.
    expect(verify.code).toBe(2);
    expect(report.schema).toBe(modelRuns.verifySchema);
    expect(report.ok).toBe(false);
    expect(report.failed?.length ?? 0).toBeGreaterThan(0);
    // The pinned checkpoint is reported even on failure: that is what tells an
    // operator which digest this machine was supposed to have.
    expect(report.checkpointDigest).toMatch(/[0-9a-f]{16}/i);

    // Cancelling an install that is not running still cleans up, and must not
    // invent an installed state.
    const cancelled = await runCli(["models", "cancel", family, "--discard-partials"], { ctx: e2e, env });
    const cancelReport: ModelsCancelReport = JSON.parse(cancelled.stdout);
    expect(cancelled.code).toBe(0);
    expect(cancelReport.schema).toBe(modelRuns.cancelSchema);
    expect(cancelReport.state?.state).toBe(modelRuns.notInstalledState);
    expect(await partialArtifacts(assetsRoot)).toEqual([]);

    // Still not installed after the cancellation: no accidental promotion.
    const reverify = await runCli(["models", "verify", family], { ctx: e2e, env, expectExit: 2 });
    const reverifyReport: ModelsVerifyReport = JSON.parse(reverify.stdout);
    expect(reverify.code).toBe(2);
    expect(reverifyReport.ok).toBe(false);

    await writeEvidence(testInfo, "model-verify-not-installed", {
      outcome: "refused",
      family,
      verifyExit: verify.code,
      verifyOk: report.ok,
      failedFiles: report.failed?.length ?? 0,
      stateAfterCancel: cancelReport.state?.state,
      partialsLeft: [],
    });
  });

  test("an unknown model family is refused with the offered families named", async ({ e2e }, testInfo) => {
    const { modelRuns } = await expectations();
    const assetsRoot = join(e2e.runsRoot, "model-assets-unknown");
    await mkdir(assetsRoot, { recursive: true });

    const result = await runCli(["models", "verify", "not-a-real-family"], {
      ctx: e2e,
      env: { SIMFORGE_ASSETS_ROOT: assetsRoot },
    });

    const envelope = await expectClassifiedCliFailure(result, [modelRuns.unknownFamilyCode, "family"]);
    // Actionable means the alternatives are on screen, not just a rejection.
    const [offered] = modelRuns.offeredFamilies;
    if (offered === undefined) throw new Error("the expectations fixture must pin at least one model family");
    expect(JSON.stringify(envelope.detail ?? {})).toContain(offered);
    // A rejected request creates no install state at all.
    expect(await walk(assetsRoot)).toEqual([]);

    await writeEvidence(testInfo, "model-family-unknown", {
      outcome: "refused",
      classification: envelope.code,
      exitCode: result.code,
      assetsRootUntouched: true,
    });
  });

  test("a model run with no result is reported missing, never synthesized", async ({ studio }, testInfo) => {
    const { modelRuns } = await expectations();
    const response = await studio.page.request.get(
      studio.url("/api/simforge/local-runs/run-that-never-existed/result"),
    );
    const body: RouteErrorBody = await response.json();
    expect(response.status()).toBe(404);
    expect(body.error).toBe(modelRuns.unknownRunCode);
    // No empty-but-successful result object may stand in for a missing one.
    expect(body).not.toHaveProperty("result");

    await writeEvidence(testInfo, "model-run-result-missing", {
      outcome: "refused",
      classification: body.error,
      status: response.status(),
    });
  });
});

test.describe("recovery: stale validation after an edit", () => {
  test("a template that passed stops passing once it is edited", async ({ e2e }, testInfo) => {
    const templatePath = join(e2e.runsRoot, "stale.template.json");
    const created = await runCli(["template", "new", "--out", templatePath], { ctx: e2e });
    expect(created.code).toBe(0);

    const clean = await runCli(["template", "validate", templatePath], { ctx: e2e });
    expect(clean.code, `a fresh skeleton must validate:\n${clean.stdout}\n${clean.stderr}`).toBe(0);

    // The edit a user actually makes and gets wrong: a required identity field
    // emptied out. The earlier pass must not carry over.
    const document: Record<string, unknown> = JSON.parse(await readFile(templatePath, "utf8"));
    document.id = "";
    await writeFile(templatePath, `${JSON.stringify(document, null, 2)}\n`, "utf8");

    const stale = await runCli(["template", "validate", templatePath], { ctx: e2e, expectExit: 2 });
    const report: TemplateValidateReport = JSON.parse(stale.stdout);
    expect(stale.code).toBe(2);
    expect(report.ok).toBe(false);
    // A rejection has to say what to repair, or the repair loop has nothing to act on.
    expect(report.issues?.length ?? 0).toBeGreaterThan(0);
    expect(report.counts?.error ?? 0).toBeGreaterThan(0);
    expect(stale.stdout).not.toMatch(/"ok"\s*:\s*true/);

    await writeEvidence(testInfo, "template-stale-after-edit", {
      outcome: "refused",
      cleanExit: clean.code,
      staleExit: stale.code,
      issues: report.issues?.length ?? 0,
      errorCount: report.counts?.error ?? 0,
    });
  });

  test("evidence verify refuses a trace that does not belong to its instance", async ({ e2e }, testInfo) => {
    await requirePrerequisites(testInfo, [PREREQUISITES.realMaps, PREREQUISITES.nativeRunner]);

    const templatePath = join(e2e.runsRoot, "evidence.template.json");
    expect((await runCli(["template", "new", "--out", templatePath], { ctx: e2e })).code).toBe(0);

    const matched = await runCli(["sites", "match", templatePath, "--all-maps"], { ctx: e2e });
    expect(matched.code).toBe(0);
    const matchReport: SiteMatchReport = JSON.parse(matched.stdout);
    const site = matchReport.sites?.[0];
    expect(site, "the matcher must return at least one concrete site").toBeTruthy();

    const instanceA = join(e2e.runsRoot, "a.instance.json");
    const instanceB = join(e2e.runsRoot, "b.instance.json");
    const traceB = join(e2e.runsRoot, "b.trace.json.gz");
    for (const [out, seed] of [[instanceA, "fixed-seed-1"], [instanceB, "fixed-seed-2"]] as const) {
      const instantiated = await runCli(
        ["instantiate", templatePath, "--map", site!.map, "--site", site!.siteId, "--seed", seed, "--out", out],
        { ctx: e2e },
      );
      expect(instantiated.code).toBe(0);
    }
    expect((await runCli(["simulate", instanceB, "--trace", traceB], { ctx: e2e })).code).toBe(0);

    // Instance A against B's trace: different seeds, so a different input hash.
    // This is the gate that stops metrics being read off the wrong run.
    const verified = await runCli(["evidence", "verify", instanceA, traceB], { ctx: e2e, expectExit: 2 });
    const envelope = await expectClassifiedCliFailure(verified, ["input_hash", "mismatch", "hash"]);
    expect(verified.stdout).not.toMatch(/"ok"\s*:\s*true/);

    await writeEvidence(testInfo, "evidence-cross-verify", {
      outcome: "refused",
      classification: envelope.code,
      reason: envelope.reason ?? null,
      exitCode: verified.code,
    });
  });
});

test.describe("recovery: concurrent hosts and secret hygiene", () => {
  test("a second host on the same data root never shares the first host's session", async ({ e2e, studio }, testInfo) => {
    let second: StudioSession | undefined;
    let refusal: string | undefined;
    try {
      second = await launchBrowserStudio(e2e, { route: "/dashboard/scenario" });
      e2e.register(() => second?.close());
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }

    if (second) {
      // Two live hosts over one data root: their control tokens are per-start
      // secrets, so neither may authorize the other. A shared token would make
      // the access gate a formality across concurrent launches.
      expect(second.baseUrl).not.toBe(studio.baseUrl);
      expect(second.controlToken).not.toBe(studio.controlToken);
      const crossed = await second.page.request.post(second.url("/api/simforge/host/session"), {
        headers: { authorization: `Bearer ${studio.controlToken}` },
        data: { next: "/dashboard/scenario" },
      });
      const crossedBody: RouteErrorBody = await crossed.json();
      expect(crossed.status()).toBe(401);
      expect(crossedBody.error).toBe((await expectations()).sessionGate.unauthorizedCode);
    } else {
      // Or the second launch is locked out, which is equally acceptable —
      // provided the refusal explains itself instead of timing out silently.
      expect(refusal, "a refused second launch must explain itself").toBeTruthy();
      expect(refusal!.toLowerCase()).toMatch(/host|port|already|lock|running|in use/);
    }

    await writeEvidence(testInfo, "concurrent-host-launch", {
      outcome: second ? "isolated" : "refused",
      firstBaseUrl: studio.baseUrl,
      secondBaseUrl: second?.baseUrl ?? null,
      distinctControlTokens: second ? second.controlToken !== studio.controlToken : null,
      refusal: refusal ?? null,
    });
  });

  test("the control token never reaches the browser surface or the evidence on disk", async ({ studio }, testInfo) => {
    const { secretHygiene } = await expectations();
    const token = studio.controlToken;
    expect(token.length, "there must be a real secret to keep out of sight").toBeGreaterThan(16);

    // The production contract on the ticket route: the control token never
    // appears in a URL, browser history or referrer.
    const pageUrl = studio.page.url();
    expect(pageUrl).not.toContain(token);
    for (const term of secretHygiene.forbiddenUrlTerms) expect(pageUrl).not.toContain(term);

    const surface = await studio.page.evaluate(() => ({
      referrer: document.referrer,
      href: location.href,
      local: JSON.stringify({ ...localStorage }),
      session: JSON.stringify({ ...sessionStorage }),
      scriptVisibleCookies: document.cookie,
    }));
    for (const [key, value] of Object.entries(surface)) {
      expect(value, `${key} must not carry the control token`).not.toContain(token);
    }
    // The session cookie is httpOnly, so page script must not see it at all.
    expect(surface.scriptVisibleCookies).not.toContain("simforge");

    const cookies = await studio.page.context().cookies();
    const session = cookies.find((cookie) => cookie.name.toLowerCase().includes("simforge"));
    expect(session, "a redeemed session must leave a cookie").toBeTruthy();
    // Derived from the token, never the token itself.
    expect(session!.value).not.toBe(token);
    expect(session!.httpOnly).toBe(true);
    for (const cookie of cookies) expect(cookie.value).not.toContain(token);

    // Evidence is an artifact reviewers copy around, so a secret that reaches it
    // has left the machine. Redact at the boundary, then prove the file is clean.
    // The decoy is synthetic: no production credential belongs in an E2E run.
    const redact = (value: string): string =>
      value
        .split(token)
        .join(secretHygiene.redactionPlaceholder)
        .split(secretHygiene.decoySecret)
        .join(secretHygiene.redactionPlaceholder);
    const file = await writeEvidence(testInfo, "control-token-hygiene", {
      outcome: "contained",
      baseUrl: studio.baseUrl,
      pageUrl: redact(pageUrl),
      referrer: redact(surface.referrer),
      authorizationHeader: redact(`Bearer ${token}`),
      decoyBearing: redact(`${secretHygiene.decoyEnvVar}=${secretHygiene.decoySecret}`),
      sessionCookie: { name: session!.name, httpOnly: session!.httpOnly, isControlToken: false },
    });

    const written = await readFile(file, "utf8");
    expect(written).not.toContain(token);
    expect(written).not.toContain(secretHygiene.decoySecret);
    expect(written).toContain(secretHygiene.redactionPlaceholder);
  });
});
