import { spawn } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MODEL_CATALOG, type ModelFamilyId, type ModelQuant } from "./catalog";
import { lockEntry, type ModelLockEntry } from "./lock";
import { hfCacheRoot, installLayout, venvPython, type InstallLayout } from "./paths";

/**
 * Provisioning the isolated Python runtime for one installed family.
 *
 * Kept as a separate, explicitly invoked step rather than folded into the
 * download, for two reasons that both bite in practice:
 *
 *  - A user who only wants weights for cloud execution should not be made to
 *    build a multi-gigabyte torch/CUDA environment.
 *  - A venv build failure must never discard 22-72 GB of verified weights.
 *    `install` completes and records `runtime: "not-prepared"`; this step can
 *    then fail, be retried, or be skipped forever without touching the
 *    checkpoint.
 *
 * The environment is pinned to the upstream lockfile, not resolved fresh:
 * `uv sync --locked` against the `uv.lock` committed in the upstream repo at
 * the pinned code commit. The three families are provisioned into three
 * separate venvs because their locks are mutually incompatible — one
 * environment holding two of them cannot exist.
 *
 * flash-attn is excluded by default: upstream supports an SDPA fallback and
 * building flash-attn requires nvcc, which most machines do not have. It is
 * opt-in and only when `nvcc` is actually present.
 */
export const RUNTIME_SCHEMA = "simforge.model-runtime/v1";

export type PrepareStep =
  | "uv"
  | "clone-code"
  | "checkout-code"
  | "venv"
  | "sync-locked"
  | "install-extras"
  | "install-adapter"
  | "record";

export type PrepareProgress = {
  readonly step: PrepareStep;
  readonly detail: string;
};

export type RuntimeRecord = {
  readonly schema: typeof RUNTIME_SCHEMA;
  readonly family: ModelFamilyId;
  readonly revision: string;
  readonly quant: ModelQuant;
  readonly python: string;
  readonly pythonVersion: string | null;
  readonly codeCommit: string;
  readonly upstreamLock: string;
  readonly flashAttn: boolean;
  readonly preparedAt: string;
  readonly steps: readonly PrepareStep[];
};

export class PrepareError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not_installed"
      | "uv_missing"
      | "git_missing"
      | "command_failed"
      | "unsupported_platform",
    readonly step: PrepareStep | null,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "PrepareError";
  }
}

type RunResult = { code: number; stdout: string; stderr: string };

/**
 * A local deferred, rather than `Promise.withResolvers` or a shared helper.
 *
 * `Promise.withResolvers` needs `lib: es2024`, and raising this package's
 * target alone would be exactly the kind of per-package divergence that bites
 * later. Importing the equivalent helper from `packages/evaluation` would make
 * this package depend on one that is on zod 4 while this one is on zod 3 — a
 * dependency edge far more expensive than three lines. The runtime is
 * identical either way.
 */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolveFn, rejectFn) => {
    resolve = resolveFn;
    reject = rejectFn;
  });
  return { promise, resolve, reject };
}

async function run(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: Record<string, string>; step: PrepareStep },
): Promise<RunResult> {
  const { promise, resolve, reject } = deferred<RunResult>();
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  child.once("error", (error) => {
    reject(
      new PrepareError(
        `${command} could not be started: ${error.message}`,
        command === "uv" ? "uv_missing" : command === "git" ? "git_missing" : "command_failed",
        options.step,
      ),
    );
  });
  child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  const result = await promise;
  if (result.code !== 0) {
    // Keep only the tail: a failed `uv sync` can emit megabytes of resolver
    // output, and the actionable part is always at the end.
    throw new PrepareError(
      `${command} ${args.join(" ")} exited ${result.code}`,
      "command_failed",
      options.step,
      { exitCode: result.code, stderr: result.stderr.slice(-4000) },
    );
  }
  return result;
}

export function runtimeRecordPath(layout: InstallLayout): string {
  return join(layout.root, "runtime.json");
}

export async function readRuntimeRecord(
  family: ModelFamilyId,
): Promise<RuntimeRecord | null> {
  const entry = await lockEntry(family);
  const layout = installLayout(family, entry.weights.revision);
  try {
    const parsed = JSON.parse(await readFile(runtimeRecordPath(layout), "utf8")) as RuntimeRecord;
    return parsed.schema === RUNTIME_SCHEMA ? parsed : null;
  } catch {
    return null;
  }
}

export type PrepareOptions = {
  readonly family: ModelFamilyId;
  readonly quant: ModelQuant;
  /** Build flash-attn instead of using the SDPA fallback. Requires nvcc. */
  readonly flashAttn?: boolean;
  /** Rebuild from scratch, discarding an existing venv and code checkout. */
  readonly force?: boolean;
  /** Path to this repository, whose adapters/alpamayo is installed --no-deps. */
  readonly adapterRoot?: string;
  readonly onProgress?: (progress: PrepareProgress) => void;
};

/**
 * Build the isolated runtime for one installed family.
 *
 * Requires the weights to be installed already: provisioning an environment
 * for a checkpoint that is not on disk would produce something that cannot be
 * used and would report success for it.
 */
export async function prepareRuntime(options: PrepareOptions): Promise<RuntimeRecord> {
  const { family, quant } = options;
  const catalog = MODEL_CATALOG[family];
  if (!catalog.platforms.includes(`${process.platform}-${process.arch === "x64" ? "x64" : process.arch}`)) {
    throw new PrepareError(
      `${catalog.displayName} runs on ${catalog.platforms.join("/")} only; this ` +
        `machine is ${process.platform}-${process.arch}. Use cloud execution.`,
      "unsupported_platform",
      null,
      { platforms: catalog.platforms },
    );
  }

  const entry = await lockEntry(family);
  const layout = installLayout(family, entry.weights.revision);
  try {
    await stat(join(layout.weights, "config.json"));
  } catch {
    throw new PrepareError(
      `${family} is not installed at ${entry.weights.revision}; install the ` +
        "weights before provisioning a runtime for them",
      "not_installed",
      null,
    );
  }

  const steps: PrepareStep[] = [];
  const report = (step: PrepareStep, detail: string) => {
    steps.push(step);
    options.onProgress?.({ step, detail });
  };

  if (options.force) {
    await rm(layout.venv, { recursive: true, force: true });
    await rm(layout.code, { recursive: true, force: true });
  }

  // uv is resolved from PATH rather than downloaded here: fetching a
  // toolchain binary is the desktop stage's job, and silently pulling one
  // from the network mid-install would bypass its digest pinning.
  const uv = await run("uv", ["--version"], { step: "uv" });
  report("uv", uv.stdout.trim());

  const codeExists = await stat(join(layout.code, ".git")).then(() => true, () => false);
  if (!codeExists) {
    await mkdir(layout.root, { recursive: true });
    await run("git", ["clone", entry.code.git, layout.code], { step: "clone-code" });
    report("clone-code", `${entry.code.git} -> ${layout.code}`);
  }
  // Detached checkout of the pinned commit: the install must not follow the
  // upstream default branch after the lock was generated.
  await run("git", ["fetch", "--quiet", "origin"], { cwd: layout.code, step: "checkout-code" });
  await run("git", ["checkout", "--quiet", "--detach", entry.code.commit], {
    cwd: layout.code,
    step: "checkout-code",
  });
  const head = await run("git", ["rev-parse", "HEAD"], { cwd: layout.code, step: "checkout-code" });
  if (head.stdout.trim() !== entry.code.commit) {
    throw new PrepareError(
      `code checkout is at ${head.stdout.trim()}, expected the pinned ` +
        `${entry.code.commit}`,
      "command_failed",
      "checkout-code",
    );
  }
  report("checkout-code", entry.code.commit);

  await run("uv", ["venv", "--python", entry.runtime.python, "--allow-existing", layout.venv], {
    cwd: layout.code,
    step: "venv",
  });
  report("venv", layout.venv);

  const venvEnv = { VIRTUAL_ENV: layout.venv, HF_HOME: hfCacheRoot() };
  const syncArgs = ["sync", "--active", "--locked"];
  if (!options.flashAttn) syncArgs.push("--no-install-package", "flash-attn");
  await run("uv", syncArgs, { cwd: layout.code, env: venvEnv, step: "sync-locked" });
  report("sync-locked", `uv.lock@${entry.code.commit}${options.flashAttn ? "" : " (flash-attn excluded, SDPA fallback)"}`);

  // Quantizers only where a quantized recipe exists. Installing bitsandbytes
  // for a family that has no quantized path would advertise a capability the
  // engine refuses.
  const quantized = catalog.quants.some(
    (offer) => offer.quant !== "bf16" && offer.status !== "unsupported",
  );
  const extras = quantized
    ? ["bitsandbytes==0.49.2", "torchao==0.12.0", "msgpack"]
    : ["msgpack"];
  await run("uv", ["pip", "install", ...extras], {
    cwd: layout.code,
    env: venvEnv,
    step: "install-extras",
  });
  report("install-extras", extras.join(" "));

  const adapterRoot = options.adapterRoot ?? process.env.SIMFORGE_ALPAMAYO_ADAPTER_ROOT;
  if (adapterRoot) {
    // --no-deps: the adapter adds only numpy/msgpack, which the upstream lock
    // already pins. Resolving its dependencies would be free to move a
    // version the lock fixed.
    await run("uv", ["pip", "install", "--no-deps", "-e", adapterRoot], {
      cwd: layout.code,
      env: venvEnv,
      step: "install-adapter",
    });
    report("install-adapter", adapterRoot);
  }

  const python = venvPython(layout);
  const version = await run(python, ["--version"], { step: "record" }).then(
    (result) => (result.stdout || result.stderr).trim(),
    () => null,
  );
  const record: RuntimeRecord = {
    schema: RUNTIME_SCHEMA,
    family,
    revision: entry.weights.revision,
    quant,
    python,
    pythonVersion: version,
    codeCommit: entry.code.commit,
    upstreamLock: entry.code.lock,
    flashAttn: options.flashAttn ?? false,
    preparedAt: new Date().toISOString(),
    steps,
  };
  await writeFile(runtimeRecordPath(layout), `${JSON.stringify(record, null, 2)}\n`);
  await markInstallRuntimePrepared(layout, entry);
  report("record", runtimeRecordPath(layout));
  return record;
}

/** Flip the install record's `register` detail from not-prepared to prepared. */
async function markInstallRuntimePrepared(
  layout: InstallLayout,
  entry: ModelLockEntry,
): Promise<void> {
  try {
    const raw = JSON.parse(await readFile(layout.installJson, "utf8")) as {
      steps?: Record<string, { completedAt: string; detail?: unknown }>;
    };
    if (!raw.steps) return;
    raw.steps.register = {
      completedAt: new Date().toISOString(),
      detail: { runtime: "prepared", codeCommit: entry.code.commit },
    };
    await writeFile(layout.installJson, `${JSON.stringify(raw, null, 2)}\n`);
  } catch {
    // The runtime record is the authority for runtime state; a missing or
    // unreadable install record is reported by `verify`, not repaired here.
  }
}
