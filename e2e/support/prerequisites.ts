import { statSync } from "node:fs";
import { E2E_ENV, envValue } from "./env";
import { writeEvidence, type EvidenceTarget } from "./evidence";

/**
 * A heavyweight input the harness cannot synthesize: a real installed map
 * corpus, a native runner binary, a staging model endpoint, a GPU, a packaged
 * desktop artifact. A suite that needs one declares it; when it is absent the
 * run *fails* with the exact variables to set. Silently skipping would report
 * green for coverage nobody executed.
 */
export type PrerequisiteSpec = {
  readonly id: string;
  readonly title: string;
  /** Environment variables that must all be set (and name existing paths, when they look like paths). */
  readonly env: readonly string[];
  readonly hint: string;
  /** Extra check beyond "the variables are set"; receives the resolved values. */
  readonly verify?: (values: Record<string, string>) => string | null;
};

export type PrerequisiteStatus = {
  readonly satisfied: boolean;
  readonly missing: readonly { id: string; title: string; env: readonly string[]; hint: string; reason: string }[];
};

export class PrerequisiteError extends Error {
  readonly status: PrerequisiteStatus;
  constructor(status: PrerequisiteStatus) {
    super(
      `Missing E2E prerequisites: ${status.missing.map((entry) => `${entry.id} (${entry.reason})`).join("; ")}. `
      + status.missing.map((entry) => `${entry.title}: set ${entry.env.join(", ")} — ${entry.hint}`).join(" | "),
    );
    this.name = "PrerequisiteError";
    this.status = status;
  }
}

function existingDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function existingFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function definePrerequisite(spec: PrerequisiteSpec): PrerequisiteSpec {
  return spec;
}

export const PREREQUISITES = {
  realMaps: definePrerequisite({
    id: "real-maps",
    title: "A real installed map corpus",
    env: [E2E_ENV.mapsFixtureRoot],
    hint: "point it at a directory containing dev-assets/, map-bundles/ and .corpus/, populated by `simforge maps pull`",
    verify: (values) =>
      existingDirectory(values[E2E_ENV.mapsFixtureRoot] ?? "") ? null : "the configured corpus root is not a directory",
  }),
  nativeRunner: definePrerequisite({
    id: "native-runner",
    title: "The native runtime/render binary",
    env: [E2E_ENV.nativeRunnerBin],
    hint: "build the Rust runner and point the variable at the executable",
    verify: (values) =>
      existingFile(values[E2E_ENV.nativeRunnerBin] ?? "") ? null : "the configured runner path is not a file",
  }),
  cloudModels: definePrerequisite({
    id: "cloud-models",
    title: "A staging cloud model endpoint",
    env: [E2E_ENV.modelBaseUrl, E2E_ENV.modelApiKey],
    hint: "a reachable base URL plus an API key for the staging model service",
  }),
  gpu: definePrerequisite({
    id: "gpu",
    title: "A usable GPU for hifi work",
    env: [E2E_ENV.gpu],
    hint: `set ${E2E_ENV.gpu}=1 only on a runner with a working GPU`,
    verify: (values) => (values[E2E_ENV.gpu] === "1" ? null : `${E2E_ENV.gpu} must be exactly "1"`),
  }),
  packagedApp: definePrerequisite({
    id: "packaged-app",
    title: "A packaged desktop artifact",
    env: [E2E_ENV.electronBinary],
    hint: "run `pnpm --filter @simforge-oss/studio desktop:dist` and point the variable at the built executable",
    verify: (values) =>
      existingFile(values[E2E_ENV.electronBinary] ?? "") ? null : "the configured desktop binary is not a file",
  }),
} as const;

/** Evaluate specs without failing; use it to branch between fixture and real-asset paths. */
export function prerequisiteStatus(...specs: readonly PrerequisiteSpec[]): PrerequisiteStatus {
  const missing: { id: string; title: string; env: readonly string[]; hint: string; reason: string }[] = [];
  for (const spec of specs) {
    const values: Record<string, string> = {};
    const unset: string[] = [];
    for (const name of spec.env) {
      const value = envValue(name);
      if (value === undefined) unset.push(name);
      else values[name] = value;
    }
    if (unset.length > 0) {
      missing.push({ ...spec, reason: `unset: ${unset.join(", ")}` });
      continue;
    }
    const problem = spec.verify?.(values) ?? null;
    if (problem !== null) missing.push({ ...spec, reason: problem });
  }
  return { satisfied: missing.length === 0, missing };
}

/**
 * Fail the current test with a machine-readable record when a heavyweight
 * input is absent: an evidence document, a `prerequisite-missing` annotation,
 * and a {@link PrerequisiteError} naming the variables to set.
 */
export async function requirePrerequisites(
  target: EvidenceTarget,
  specs: readonly PrerequisiteSpec[] | PrerequisiteSpec,
): Promise<void> {
  const list = Array.isArray(specs) ? specs : [specs];
  const status = prerequisiteStatus(...list);
  if (status.satisfied) return;
  await writeEvidence(target, `prerequisite-missing-${status.missing.map((entry) => entry.id).join("-")}`, {
    outcome: "prerequisite-missing",
    missing: status.missing.map((entry) => ({ id: entry.id, title: entry.title, env: entry.env, hint: entry.hint, reason: entry.reason })),
  });
  if (target && "annotations" in target && Array.isArray(target.annotations)) {
    for (const entry of status.missing) {
      target.annotations.push({ type: "prerequisite-missing", description: `${entry.id}: ${entry.reason} (${entry.env.join(", ")})` });
    }
  }
  throw new PrerequisiteError(status);
}

/** Single-spec form of {@link requirePrerequisites}. */
export async function requirePrerequisite(target: EvidenceTarget, spec: PrerequisiteSpec): Promise<void> {
  await requirePrerequisites(target, [spec]);
}
