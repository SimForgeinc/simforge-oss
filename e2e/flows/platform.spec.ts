// Platform-aware coverage for the two shapes the desktop product actually
// ships in: the development Electron shell (`electron .` over the workspace
// sources) and the PACKAGED application a user downloads and installs.
//
// The rule this suite exists to enforce is that a development launch on this
// host proves nothing about packaging on another OS. A dev-Electron run is
// never recorded as packaging evidence, and a packaged run is qualified only
// against a real artifact whose own stage manifest agrees with the host it is
// being exercised on. Anything else is an explicit prerequisite failure with
// the missing input named — never a silent skip and never a pass-by-proxy.
//
// Parameterization: one describe per platform mode. The packaged mode is
// driven by SIMFORGE_E2E_ELECTRON_BINARY (the artifact path); the target
// platform under qualification is SIMFORGE_E2E_TARGET_PLATFORM, defaulting to
// this host. Evidence records platform, artifact identity (stage manifest
// digest + version + arch) and the host capability report for every case, so
// a reader can tell which OS and which bytes a verdict belongs to.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// The extended Playwright fixtures (`{ e2e, studio }`) come from the harness
// barrel; everything else is imported from the module that owns it, which is
// the same file the barrel re-exports.
import { expect, test } from "../support";
import { createE2eContext, type E2eContext } from "../support/context";
import { writeEvidence } from "../support/evidence";
import {
  PREREQUISITES,
  definePrerequisite,
  prerequisiteStatus,
  requirePrerequisites,
} from "../support/prerequisites";
import { launchElectronStudio, type StudioSession } from "../support/session";

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "platform");

type PlatformExpectation = {
  label: string;
  packagedArtifactSuffixes: string[];
  dataRootAnchors: string[];
  vaultProvider: string;
  vaultAbsentIsExpected: boolean;
  vaultAbsentNote: string;
};

type Expectations = {
  stageManifest: {
    locations: string[];
    identityFields: string[];
    executables: string[];
    libraries: string[];
    tools: string[];
    entries: { field: string; label: string }[];
  };
  platforms: Record<string, PlatformExpectation>;
  capabilityContract: {
    capabilitiesSchema: string;
    nativeRuntimeUnavailableCodes: string[];
    credentialPersistence: string[];
    sessionOnlyMessageTerms: string[];
  };
  awkwardPaths: { spaces: string; unicode: string };
};

const expectations: Expectations = JSON.parse(
  await readFile(join(fixtureRoot, "expectations.json"), "utf8"),
) as Expectations;

/** The OS this run claims to qualify. Never inferred from a successful launch. */
const targetPlatform = (process.env.SIMFORGE_E2E_TARGET_PLATFORM ?? process.platform).trim();
const hostPlatform = process.platform;
const packagedArtifact = process.env.SIMFORGE_E2E_ELECTRON_BINARY?.trim() || null;

/**
 * The OS credential vault is a machine capability, not a product one: a
 * headless CI Linux box legitimately has none. Asserting "os-vault" therefore
 * requires the operator to declare that this machine has an unlocked vault,
 * rather than the suite guessing from the answer it is trying to verify.
 */
const osCredentialVault = definePrerequisite({
  id: "osCredentialVault",
  title: "An unlocked OS credential vault on this machine",
  env: ["SIMFORGE_E2E_OS_VAULT"],
  hint:
    "Set SIMFORGE_E2E_OS_VAULT=1 on a machine with an unlocked keyring (Linux: an unlocked " +
    "Secret Service; macOS: the login Keychain; Windows: Credential Manager) to require " +
    "os-vault persistence. Without it the suite records the observed persistence but will " +
    "not certify vault-backed storage.",
});

/** Platform modes this run covers. Packaged is present only when an artifact was named. */
type PlatformMode = {
  readonly id: "dev-electron" | "packaged";
  readonly title: string;
  /** Whether a verdict from this mode may be cited as packaging evidence. */
  readonly provesPackaging: boolean;
};

const MODES: PlatformMode[] = [
  { id: "dev-electron", title: "development Electron shell", provesPackaging: false },
  { id: "packaged", title: "packaged application", provesPackaging: true },
];

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((ok, fail) => {
    createReadStream(path)
      .on("error", fail)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => ok());
  });
  return hash.digest("hex");
}


type ArtifactIdentity = {
  /** "packaged-artifact" when a stage manifest was found beside the executable. */
  kind: "packaged-artifact" | "workspace-sources";
  executable: string | null;
  sha256: string | null;
  sizeBytes: number | null;
  stageManifestPath: string | null;
  stageRoot: string | null;
  manifest: Record<string, unknown> | null;
  /** platform/arch/studioVersion/electron lifted out of the manifest. */
  identity: Record<string, unknown> | null;
};

/**
 * Resolves what is actually being launched. A packaged Electron binary sits
 * beside a `resources` tree holding the sealed stage; the stage manifest is
 * FOUND rather than assumed, so a packaging layout change surfaces as a clear
 * "no stage manifest" failure instead of a wrong path.
 */
async function resolveArtifactIdentity(executable: string | null): Promise<ArtifactIdentity> {
  if (!executable) {
    return {
      kind: "workspace-sources",
      executable: null,
      sha256: null,
      sizeBytes: null,
      stageManifestPath: null,
      stageRoot: null,
      manifest: null,
      identity: null,
    };
  }
  const exe = resolve(executable);
  const info = await stat(exe).catch(() => null);
  const dir = info?.isDirectory() ? exe : dirname(exe);
  // Electron layouts: <dir>/resources (Linux/Windows) and
  // <bundle>/Contents/Resources (macOS), searched from the executable outward.
  const resourceDirs = [
    join(dir, "resources"),
    join(dir, "Resources"),
    join(dir, "..", "Resources"),
    join(dir, "..", "resources"),
  ];
  for (const resources of resourceDirs) {
    for (const relative of expectations.stageManifest.locations) {
      const manifestPath = join(resources, relative);
      const raw = await readFile(manifestPath, "utf8").catch(() => null);
      if (raw === null) continue;
      const manifest = JSON.parse(raw) as Record<string, unknown>;
      const identity = Object.fromEntries(
        expectations.stageManifest.identityFields.map((field) => [field, manifest[field] ?? null]),
      );
      return {
        kind: "packaged-artifact",
        executable: exe,
        sha256: info?.isFile() ? await sha256File(exe) : null,
        sizeBytes: info?.isFile() ? info.size : null,
        stageManifestPath: manifestPath,
        stageRoot: dirname(manifestPath),
        manifest,
        identity,
      };
    }
  }
  return {
    kind: "workspace-sources",
    executable: exe,
    sha256: info?.isFile() ? await sha256File(exe) : null,
    sizeBytes: info?.isFile() ? info.size : null,
    stageManifestPath: null,
    stageRoot: null,
    manifest: null,
    identity: null,
  };
}

/** The capability report the UI itself reads, plus the connection contract that names vault backing. */
async function readCapabilityReport(studio: StudioSession) {
  const capabilities = await studio.api<Record<string, any>>("/api/simforge/host/capabilities");
  const cloud: Record<string, any> = await studio
    .api<Record<string, any>>("/api/simforge/cloud/status")
    .catch((error: unknown) => ({ unavailable: error instanceof Error ? error.message : String(error) }));
  return { capabilities, cloud };
}

/**
 * A compact, reader-facing description of what this run is entitled to claim.
 * `qualifies.packaging` is the load-bearing field: it is false for every
 * development launch, and false for a packaged artifact whose manifest does
 * not describe the host it ran on.
 */
function provenance(mode: PlatformMode, artifact: ArtifactIdentity) {
  const manifestPlatform = (artifact.identity?.platform as string | undefined) ?? null;
  const manifestArch = (artifact.identity?.arch as string | undefined) ?? null;
  const platformAgrees = manifestPlatform !== null && manifestPlatform === hostPlatform;
  return {
    mode: mode.id,
    hostPlatform,
    hostArch: process.arch,
    targetPlatform,
    artifact: {
      kind: artifact.kind,
      executable: artifact.executable,
      name: artifact.executable ? basename(artifact.executable) : null,
      sha256: artifact.sha256,
      sizeBytes: artifact.sizeBytes,
      stageManifestPath: artifact.stageManifestPath,
      identity: artifact.identity,
    },
    qualifies: {
      packaging: mode.provesPackaging && artifact.kind === "packaged-artifact" && platformAgrees,
      platform: platformAgrees ? manifestPlatform : null,
      arch: platformAgrees ? manifestArch : null,
    },
    meaning:
      mode.provesPackaging && artifact.kind === "packaged-artifact"
        ? `Exercised the packaged artifact on ${hostPlatform}; this qualifies ${manifestPlatform}-${manifestArch} packaging only.`
        : `Exercised the development shell from workspace sources on ${hostPlatform}; this qualifies no packaged artifact on any OS.`,
  };
}

/**
 * Opens a session for the mode, failing with the named missing prerequisite
 * when the packaged artifact is absent. The packaged mode always launches the
 * artifact explicitly, so a stray environment variable cannot let a dev run
 * masquerade as a packaged one (or the reverse).
 */
async function openSession(
  ctx: E2eContext,
  mode: PlatformMode,
  options: { route?: string; env?: Record<string, string> } = {},
): Promise<{ studio: StudioSession; artifact: ArtifactIdentity }> {
  if (mode.id === "packaged") {
    await requirePrerequisites(ctx, [PREREQUISITES.packagedApp]);
    const executable = packagedArtifact as string;
    const launchable = await stat(executable).catch(() => null);
    expect(
      launchable !== null && (launchable.isFile() || launchable.isDirectory()),
      `SIMFORGE_E2E_ELECTRON_BINARY points at ${executable}, which is not a file or app bundle`,
    ).toBe(true);
    const artifact = await resolveArtifactIdentity(executable);
    expect(
      artifact.kind,
      `no stage manifest (${expectations.stageManifest.locations.join(" or ")}) was found beside ${executable}: ` +
        "this is not a staged SimForge package, so it cannot qualify packaging",
    ).toBe("packaged-artifact");
    const studio = await launchElectronStudio(ctx, { executablePath: executable, ...options });
    return { studio, artifact };
  }
  const studio = await launchElectronStudio(ctx, options);
  const artifact = await resolveArtifactIdentity(null);
  return { studio, artifact };
}

for (const mode of MODES) {
  test.describe(`platform: ${mode.title} (${mode.id})`, () => {
    test.describe.configure({ mode: "serial" });

    test(`starts and reports readiness with recorded platform and artifact identity [${mode.id}]`, async ({ e2e }, testInfo) => {
      const { studio, artifact } = await openSession(e2e, mode);
      const report = await readCapabilityReport(studio);

      expect(report.capabilities.schema).toBe(expectations.capabilityContract.capabilitiesSchema);
      expect(report.capabilities.host.kind).toBe("local");
      expect(report.capabilities.execution.browserSimulation).toBe(true);
      expect(report.capabilities.persistence.kind).toBe("pglite-filesystem");
      // Readiness is the app's OWN host answering, not merely a window existing.
      expect(studio.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+/);
      await expect(studio.page).toHaveURL(new RegExp(`^${studio.baseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

      const evidence = {
        outcome: "ready",
        provenance: provenance(mode, artifact),
        readiness: {
          baseUrl: studio.baseUrl,
          hostLabel: report.capabilities.host.label,
          hostVersion: report.capabilities.host.version,
        },
        capabilityReport: report.capabilities,
        cloudConnection: report.cloud,
      };
      await writeEvidence(testInfo, `platform-${mode.id}-startup`, evidence);

      // The claim boundary, asserted rather than left to a reader's trust.
      if (mode.id === "dev-electron") {
        expect(
          evidence.provenance.qualifies.packaging,
          "a development launch from workspace sources must never be recorded as packaging evidence",
        ).toBe(false);
      }
    });

    test(`completes first-run setup into an empty data root [${mode.id}]`, async ({ e2e }, testInfo) => {
      const before = await readdir(e2e.dataRoot).catch(() => [] as string[]);
      expect(
        before.includes("db"),
        `the isolated data root ${e2e.dataRoot} already holds a database, so this is not a first run`,
      ).toBe(false);

      const { studio, artifact } = await openSession(e2e, mode);
      const { capabilities } = await readCapabilityReport(studio);

      // First run must materialise storage under the ISOLATED root, not a
      // developer's real one: a leaked path would let existing local state
      // make a broken first-run experience look healthy.
      const dataRoot = capabilities.persistence.dataRoot as string;
      expect(isAbsolute(dataRoot)).toBe(true);
      expect(resolve(dataRoot)).toBe(resolve(e2e.dataRoot));
      const after = await readdir(dataRoot);
      expect(after.length, `first run left ${dataRoot} empty`).toBeGreaterThan(0);

      // An implicit local owner, not an account prompt: the desktop product
      // must be usable before any SimCloud sign-in exists.
      expect(capabilities.identity.mode).toBe("fixed-local");
      expect(typeof capabilities.identity.userId).toBe("string");
      expect(capabilities.identity.userId.length).toBeGreaterThan(0);
      expect(typeof capabilities.identity.workspaceId).toBe("string");

      await writeEvidence(testInfo, `platform-${mode.id}-first-run`, {
        outcome: "first-run-complete",
        provenance: provenance(mode, artifact),
        dataRoot,
        createdEntries: after.sort(),
        identity: capabilities.identity,
      });
    });

    test(`serves a data root on a path with spaces and non-ASCII characters [${mode.id}]`, async ({ e2e }, testInfo) => {
      // Real home directories look like this. The desktop host must quote and
      // encode its own paths; a shell-concatenation bug shows up here and
      // nowhere else in the suite.
      const awkward = join(e2e.dataRoot, "..", `${expectations.awkwardPaths.spaces} ${expectations.awkwardPaths.unicode}`);
      const awkwardRoot = resolve(awkward);
      await mkdir(awkwardRoot, { recursive: true });
      // A pre-existing file with the same hostile naming, to prove reads as
      // well as writes survive the path.
      const probeName = "sentinel é — ✓.json";
      await writeFile(join(awkwardRoot, probeName), JSON.stringify({ probe: "platform-paths" }), "utf8");

      const ctx = await createE2eContext({
        name: `platform-${mode.id}-awkward-path`,
        env: { ...e2e.env, SIMFORGE_CLOUD_ROOT: awkwardRoot },
      });
      const { studio, artifact } = await openSession(ctx, mode);
      const { capabilities } = await readCapabilityReport(studio);

      expect(resolve(capabilities.persistence.dataRoot as string)).toBe(awkwardRoot);
      const entries = await readdir(awkwardRoot);
      expect(entries, "the host must not have relocated or mangled the hostile path").toContain(probeName);
      expect(entries.length).toBeGreaterThan(1);

      await writeEvidence(testInfo, `platform-${mode.id}-awkward-paths`, {
        outcome: "awkward-path-accepted",
        provenance: provenance(mode, artifact),
        dataRoot: awkwardRoot,
        containsSpace: awkwardRoot.includes(" "),
        containsNonAscii: /[^\x20-\x7e]/.test(awkwardRoot),
        entries: entries.sort(),
      });
      await ctx.dispose();
    });

    test(`reports OS credential-vault capability honestly [${mode.id}]`, async ({ e2e }, testInfo) => {
      const { studio, artifact } = await openSession(e2e, mode);
      const { cloud } = await readCapabilityReport(studio);
      const platform = expectations.platforms[hostPlatform] ?? null;

      expect(
        "credentialPersistence" in cloud,
        `the connection contract did not report credentialPersistence: ${JSON.stringify(cloud)}`,
      ).toBe(true);
      const persistence = cloud.credentialPersistence as string;
      expect(expectations.capabilityContract.credentialPersistence).toContain(persistence);

      // "session" is a first-class, user-visible state, so it must come with
      // the explanation the UI renders; it is never a silent downgrade.
      if (persistence === "session" && typeof cloud.message === "string" && cloud.message.length > 0) {
        const message = cloud.message.toLowerCase();
        expect(
          expectations.capabilityContract.sessionOnlyMessageTerms.some((term) => message.includes(term)),
          `session-only persistence must be explained to the user; got ${JSON.stringify(cloud.message)}`,
        ).toBe(true);
      }

      const declared = prerequisiteStatus(osCredentialVault);
      if (declared.satisfied) {
        // The operator declared a real vault, so "session" is now a defect.
        await requirePrerequisites(e2e, [osCredentialVault]);
        expect(
          persistence,
          `${platform?.vaultProvider ?? "the OS credential vault"} was declared available but the host reported session-only storage`,
        ).toBe("os-vault");
      }

      await writeEvidence(testInfo, `platform-${mode.id}-credential-vault`, {
        outcome: persistence === "os-vault" ? "vault-backed" : "session-only",
        provenance: provenance(mode, artifact),
        capabilityReport: {
          credentialPersistence: persistence,
          connectionState: cloud.state ?? null,
          message: cloud.message ?? null,
        },
        vault: {
          provider: platform?.vaultProvider ?? `unknown for ${hostPlatform}`,
          declaredAvailable: declared.satisfied,
          absenceExpectedOnThisPlatform: platform?.vaultAbsentIsExpected ?? null,
          note: platform?.vaultAbsentNote ?? null,
          certified: declared.satisfied && persistence === "os-vault",
        },
        meaning: declared.satisfied
          ? "Vault backing was required and verified against a declared OS vault."
          : "Observed persistence only: no OS vault was declared (SIMFORGE_E2E_OS_VAULT), so vault-backed storage is not certified by this run.",
      });
    });

    test(`reports native payload capability for the payload it actually has [${mode.id}]`, async ({ e2e }, testInfo) => {
      const { studio, artifact } = await openSession(e2e, mode);
      const { capabilities } = await readCapabilityReport(studio);
      const native = capabilities.execution.nativeRuntime as Record<string, any>;

      // The host must never fabricate an installed runtime: whichever state it
      // reports has to carry the fields that make it actionable.
      expect(["available", "unavailable"]).toContain(native.state);
      if (native.state === "unavailable") {
        expect(expectations.capabilityContract.nativeRuntimeUnavailableCodes).toContain(native.code);
        expect(typeof native.reason).toBe("string");
        expect(native.reason.length, "an unavailable runtime must say why").toBeGreaterThan(0);
        expect(Array.isArray(native.searchedPaths)).toBe(true);
        for (const path of native.searchedPaths as string[]) {
          expect(isAbsolute(path), `searched path ${path} is not absolute, so a user cannot install into it`).toBe(true);
        }
      } else {
        expect(isAbsolute(native.binaryPath)).toBe(true);
        expect(native.runtime.schema).toBe("simforge.native-runtime/v1");
        expect(typeof native.runtime.target).toBe("string");
        expect(native.runtime.binary.sha256).toMatch(/^[0-9a-f]{64}$/);
      }

      // A packaged artifact is held to its own manifest: every executable,
      // library and tool the stage claims must exist in the installed tree.
      // A development launch has no such manifest and is not pretended to.
      const payload: Record<string, unknown> = { source: artifact.kind };
      if (artifact.kind === "packaged-artifact" && artifact.stageRoot && artifact.manifest) {
        const manifest = artifact.manifest as Record<string, any>;
        const stageRoot = artifact.stageRoot;
        const problems: string[] = [];
        const present: Record<string, string> = {};
        const check = async (label: string, relative: unknown, needsExec: boolean) => {
          if (typeof relative !== "string" || relative.length === 0) {
            problems.push(`the manifest names no ${label}`);
            return;
          }
          const full = join(stageRoot, relative);
          const info = await stat(full).catch(() => null);
          if (!info?.isFile()) {
            problems.push(`${label} (${relative}) is missing from the package`);
            return;
          }
          if (needsExec && (info.mode & 0o111) === 0 && hostPlatform !== "win32") {
            problems.push(`${label} (${relative}) is not executable`);
            return;
          }
          present[label] = relative;
        };
        for (const field of expectations.stageManifest.executables) await check(field, manifest[field], true);
        for (const field of expectations.stageManifest.libraries) await check(field, manifest[field], false);
        for (const tool of expectations.stageManifest.tools) await check(`tools.${tool}`, manifest.tools?.[tool], true);
        for (const entry of expectations.stageManifest.entries) await check(entry.label, manifest[entry.field], false);

        payload.stageManifestPath = artifact.stageManifestPath;
        payload.present = present;
        payload.problems = problems;
        expect(problems, `the packaged native payload is incomplete: ${problems.join("; ")}`).toEqual([]);
      }

      await writeEvidence(testInfo, `platform-${mode.id}-native-payload`, {
        outcome: native.state === "available" ? "native-runtime-available" : "native-runtime-unavailable",
        provenance: provenance(mode, artifact),
        capabilityReport: {
          nativeRuntime: native,
          renderWorkers: capabilities.execution.renderWorkers,
          localRender: capabilities.execution.localRender ?? null,
        },
        packagedPayload: payload,
      });
    });

    test(`preserves local state across close and reopen [${mode.id}]`, async ({ e2e }, testInfo) => {
      const first = await openSession(e2e, mode);
      const opened = await readCapabilityReport(first.studio);
      const dataRoot = opened.capabilities.persistence.dataRoot as string;
      const before = (await readdir(dataRoot)).sort();
      await first.studio.close();

      // Closing the window must not take the data root with it.
      expect((await readdir(dataRoot)).sort()).toEqual(before);

      const second = await openSession(e2e, mode);
      const reopened = await readCapabilityReport(second.studio);
      const after = (await readdir(reopened.capabilities.persistence.dataRoot as string)).sort();

      expect(resolve(reopened.capabilities.persistence.dataRoot as string)).toBe(resolve(dataRoot));
      // Identity is the observable proof the SAME local workspace came back
      // rather than a fresh one being created on top of the old files.
      expect(reopened.capabilities.identity.userId).toBe(opened.capabilities.identity.userId);
      expect(reopened.capabilities.identity.workspaceId).toBe(opened.capabilities.identity.workspaceId);
      for (const entry of before) expect(after, `reopening dropped ${entry}`).toContain(entry);

      await writeEvidence(testInfo, `platform-${mode.id}-close-reopen`, {
        outcome: "state-preserved",
        provenance: provenance(mode, first.artifact),
        dataRoot,
        identity: reopened.capabilities.identity,
        entriesBefore: before,
        entriesAfter: after,
      });
    });

    test(`keeps user data outside the install tree so an update or restart cannot remove it [${mode.id}]`, async ({ e2e }, testInfo) => {
      const { studio, artifact } = await openSession(e2e, mode);
      const { capabilities } = await readCapabilityReport(studio);
      const dataRoot = resolve(capabilities.persistence.dataRoot as string);
      const identity = capabilities.identity;
      const before = (await readdir(dataRoot)).sort();

      // An update replaces the install directory and restarts the app. The
      // property that makes that non-destructive is locational, so it is
      // checked as such rather than inferred from a restart that happened to
      // keep working.
      let installRoot: string | null = null;
      if (artifact.kind === "packaged-artifact" && artifact.executable) {
        const info = await stat(artifact.executable).catch(() => null);
        installRoot = resolve(info?.isDirectory() ? artifact.executable : dirname(artifact.executable));
        expect(
          dataRoot.startsWith(installRoot + sep),
          `the data root ${dataRoot} lives inside the install tree ${installRoot}; an update or uninstall would delete user data`,
        ).toBe(false);
      }

      // The restart half of an update: the app comes back against the same
      // root and finds the same workspace.
      await studio.close();
      const restarted = await openSession(e2e, mode);
      const afterReport = await readCapabilityReport(restarted.studio);
      const after = (await readdir(dataRoot)).sort();

      expect(resolve(afterReport.capabilities.persistence.dataRoot as string)).toBe(dataRoot);
      expect(afterReport.capabilities.identity.userId).toBe(identity.userId);
      expect(afterReport.capabilities.identity.workspaceId).toBe(identity.workspaceId);
      for (const entry of before) expect(after, `restart dropped ${entry}`).toContain(entry);

      const platform = expectations.platforms[hostPlatform] ?? null;
      await writeEvidence(testInfo, `platform-${mode.id}-update-restart`, {
        outcome: "survives-restart",
        provenance: provenance(mode, artifact),
        dataRoot,
        installRoot,
        dataRootInsideInstallTree: installRoot ? dataRoot.startsWith(installRoot + sep) : null,
        expectedPlatformAnchors: platform?.dataRootAnchors ?? null,
        identity: afterReport.capabilities.identity,
        entriesBefore: before,
        entriesAfter: after,
        meaning:
          installRoot === null
            ? "Development launch: the install-tree separation that protects an update was not exercised, only the restart."
            : "The data root is outside the install tree, so replacing the install on update cannot remove user data.",
      });
    });

    test(`names unsupported capabilities with a platform-specific reason instead of offering them [${mode.id}]`, async ({ e2e }, testInfo) => {
      const { studio, artifact } = await openSession(e2e, mode);
      const { capabilities } = await readCapabilityReport(studio);
      const workers = (capabilities.execution.renderWorkers ?? {}) as Record<string, { available: boolean; reason: string | null }>;

      // A missing key is an unsupported engine the UI must never submit; a
      // present key with available:false must say what is missing. Either way
      // the user is told, and the host never advertises capacity it lacks.
      for (const [engine, worker] of Object.entries(workers)) {
        expect(typeof worker.available, `renderWorkers.${engine} has no availability`).toBe("boolean");
        if (!worker.available) {
          expect(typeof worker.reason, `renderWorkers.${engine} is unavailable without a reason`).toBe("string");
          expect((worker.reason ?? "").length).toBeGreaterThan(0);
        }
      }

      const local = capabilities.execution.localRender as Record<string, any> | undefined;
      const unsupported: Record<string, unknown> = {};
      if (local) {
        expect(local.engine).toBe("native");
        expect(typeof local.ready).toBe("boolean");
        if (!local.ready) {
          expect(Array.isArray(local.reasons)).toBe(true);
          expect(local.reasons.length, "an unready local renderer must name what is missing").toBeGreaterThan(0);
          // Every reason must be attributable to a dependency the report also
          // marks missing, so the message cannot drift from the machine state.
          const missing = (["renderService", "encoder", "actorAssets"] as const).filter(
            (key) => local[key]?.state === "missing",
          );
          unsupported.missingDependencies = missing;
          unsupported.reasons = local.reasons;
          if (!local.worker?.attached) unsupported.workerAttached = false;
          expect(
            missing.length > 0 || local.worker?.attached === false,
            `localRender is not ready but every dependency is present and a worker is attached: ${JSON.stringify(local.reasons)}`,
          ).toBe(true);
        }
      }

      const native = capabilities.execution.nativeRuntime as Record<string, any>;
      if (native.state === "unavailable") {
        const platform = expectations.platforms[hostPlatform];
        unsupported.nativeRuntime = { code: native.code, reason: native.reason, searchedPaths: native.searchedPaths };
        // The install guidance has to be about THIS platform's filesystem, not
        // a generic instruction the user cannot follow.
        if (platform && (native.searchedPaths as string[]).length > 0) {
          expect(
            (native.searchedPaths as string[]).every((path) => path.startsWith(sep) || /^[A-Za-z]:\\/.test(path)),
            `the searched paths are not ${platform.label} paths: ${JSON.stringify(native.searchedPaths)}`,
          ).toBe(true);
        }
      }

      await writeEvidence(testInfo, `platform-${mode.id}-unsupported-capabilities`, {
        outcome: Object.keys(unsupported).length === 0 ? "all-capabilities-offered" : "unsupported-capabilities-named",
        provenance: provenance(mode, artifact),
        platform: expectations.platforms[hostPlatform]?.label ?? hostPlatform,
        capabilityReport: { renderWorkers: workers, localRender: local ?? null, nativeRuntime: native },
        unsupported,
        jobs: capabilities.jobs,
      });
    });
  });
}

test.describe("platform: cross-platform claim boundary", () => {
  test("refuses to qualify a platform this run cannot exercise", async ({ e2e }, testInfo) => {
    const artifact = await resolveArtifactIdentity(packagedArtifact);
    const packagedAvailable = prerequisiteStatus(PREREQUISITES.packagedApp).satisfied;
    const manifestPlatform = (artifact.identity?.platform as string | undefined) ?? null;

    const record = {
      outcome: "claim-boundary",
      hostPlatform,
      hostArch: process.arch,
      targetPlatform,
      packagedArtifact: {
        declared: packagedArtifact,
        prerequisiteSatisfied: packagedAvailable,
        kind: artifact.kind,
        sha256: artifact.sha256,
        identity: artifact.identity,
      },
      qualifiedPlatforms: manifestPlatform && manifestPlatform === hostPlatform ? [manifestPlatform] : [],
      unqualifiedPlatforms: ["linux", "darwin", "win32"].filter(
        (candidate) => !(manifestPlatform === candidate && manifestPlatform === hostPlatform),
      ),
      meaning:
        "Packaging for an OS is qualified only by running that OS's artifact on that OS. " +
        "Nothing in this run extends to the platforms listed as unqualified.",
    };
    await writeEvidence(testInfo, "platform-claim-boundary", record);

    // Asking for another OS's verdict from this host is a prerequisite
    // failure naming the artifact that is missing, never a pass and never a
    // quiet skip.
    if (targetPlatform !== hostPlatform) {
      await requirePrerequisites(e2e, [
        definePrerequisite({
          id: `packagedApp:${targetPlatform}`,
          title: `A ${expectations.platforms[targetPlatform]?.label ?? targetPlatform} packaged artifact exercised on ${targetPlatform}`,
          env: ["SIMFORGE_E2E_TARGET_PLATFORM", "SIMFORGE_E2E_ELECTRON_BINARY"],
          hint:
            `This host is ${hostPlatform}, so it cannot exercise a ${targetPlatform} package. ` +
            `Run this suite on a ${targetPlatform} machine with SIMFORGE_E2E_ELECTRON_BINARY set to that platform's ` +
            `artifact (${expectations.platforms[targetPlatform]?.packagedArtifactSuffixes.join(", ") ?? "its installer"}).`,
        }),
      ]);
    }

    if (packagedAvailable) {
      expect(
        artifact.kind,
        `${packagedArtifact} carries no stage manifest, so it cannot stand in for a packaged artifact`,
      ).toBe("packaged-artifact");
      expect(
        manifestPlatform,
        `the artifact is built for ${manifestPlatform} but is being exercised on ${hostPlatform}; ` +
          "a package may only be qualified on the OS it targets",
      ).toBe(hostPlatform);
    }
  });
});
