import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { nativeExecutableName, nativeRuntimeRoot } from "@simforge-oss/native-runtime";
import { NATIVE_RUNTIME_MANIFEST_SCHEMA, type NativeRuntimeCapability, type NativeRuntimeManifest } from "../capabilities";

const execFileAsync = promisify(execFile);

export const NATIVE_RUNNER_BINARY = nativeExecutableName("simforge-runner");

/**
 * Discovery order fixed by the runner: `SIMFORGE_RUNNER_BIN`, then the runtime
 * root's `bin/`, then every `PATH` entry (`simforge-runner.exe` on Windows).
 */
export function nativeRunnerCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates: string[] = [];
  const explicit = env.SIMFORGE_RUNNER_BIN?.trim();
  if (explicit) candidates.push(explicit);
  candidates.push(join(nativeRuntimeRoot(env), "bin", NATIVE_RUNNER_BINARY));
  for (const entry of (env.PATH ?? "").split(delimiter)) {
    if (entry) candidates.push(join(entry, NATIVE_RUNNER_BINARY));
  }
  return candidates;
}

export async function locateNativeRunner(env: NodeJS.ProcessEnv = process.env): Promise<{ binaryPath: string | null; searchedPaths: string[] }> {
  const searchedPaths = nativeRunnerCandidates(env);
  for (const candidate of searchedPaths) {
    try {
      await access(candidate, constants.X_OK);
      return { binaryPath: candidate, searchedPaths };
    } catch {
      // keep searching
    }
  }
  return { binaryPath: null, searchedPaths };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseManifest(stdout: string): NativeRuntimeManifest | null {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isRecord(value) || !isRecord(value.binary)) return null;
  if (
    value.schema !== NATIVE_RUNTIME_MANIFEST_SCHEMA
    || typeof value.runtimeId !== "string"
    || typeof value.version !== "string"
    || typeof value.revision !== "string"
    || typeof value.target !== "string"
    || typeof value.binary.sha256 !== "string"
    || typeof value.binary.sizeBytes !== "number"
    || !Array.isArray(value.engines)
    || !Array.isArray(value.supportTiers)
  ) {
    return null;
  }
  // Every required field was checked above; the manifest is the runner's own document.
  const manifest = value as unknown as NativeRuntimeManifest;
  return manifest;
}

/**
 * Probe the installed runner with `simforge-runner runtime show`.
 *
 * The runner refuses to run when its manifest does not match its own binary
 * hash; that refusal (exit 1, structured stderr) is reported as `unavailable`
 * with the runner's code rather than treated as a crash.
 */
export async function probeNativeRuntime(env: NodeJS.ProcessEnv = process.env): Promise<NativeRuntimeCapability> {
  const { binaryPath, searchedPaths } = await locateNativeRunner(env);
  if (!binaryPath) {
    return {
      state: "unavailable",
      code: "not_installed",
      reason: `${NATIVE_RUNNER_BINARY} is not installed. Install it under ${join(nativeRuntimeRoot(env), "bin")} or set SIMFORGE_RUNNER_BIN.`,
      searchedPaths,
    };
  }
  try {
    const { stdout } = await execFileAsync(binaryPath, ["runtime", "show"], {
      env,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      // A console runner spawned from a GUI host must not open a window.
      windowsHide: true,
    });
    const runtime = parseManifest(stdout);
    if (!runtime) {
      return {
        state: "unavailable",
        code: "probe_failed",
        reason: `${binaryPath} answered \`runtime show\` with an unrecognized document.`,
        searchedPaths,
      };
    }
    return { state: "available", binaryPath, runtime };
  } catch (error) {
    const stderr = isRecord(error) && typeof error.stderr === "string" ? error.stderr : "";
    let code: "runtime.manifest_missing" | "runtime.manifest_invalid" | "probe_failed" = "probe_failed";
    let reason = error instanceof Error ? error.message : String(error);
    let failure: unknown = null;
    try {
      failure = JSON.parse(stderr);
    } catch {
      // stderr was not the runner's structured error; keep the process error
    }
    if (isRecord(failure)) {
      if (failure.code === "runtime.manifest_missing" || failure.code === "runtime.manifest_invalid") code = failure.code;
      if (typeof failure.reason === "string") reason = failure.reason;
    }
    return { state: "unavailable", code, reason, searchedPaths };
  }
}
