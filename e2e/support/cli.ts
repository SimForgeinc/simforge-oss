import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { E2eContext } from "./context";
import { CLI_BIN, CLI_DIST, REPO_ROOT } from "./paths";

/**
 * Run the `simforge` CLI the same way a user does, inside a test's isolated
 * roots. The CLI contract is "stdout is the result": one JSON document, exit
 * 0 ok / 1 could not run / 2 ran and rejected the input, so `json` is parsed
 * whenever stdout holds a document and `expectExit` asserts the code.
 */
export type CliResult = {
  readonly args: readonly string[];
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Parsed stdout, or `null` when stdout was empty or not JSON. */
  readonly json: unknown;
};

export type RunCliOptions = {
  /** Supplies the isolated data and map-cache roots. */
  ctx?: E2eContext;
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
  /** Throw unless the CLI exits with exactly this code. */
  expectExit?: number;
};

/**
 * `bin/simforge.js` is a thin loader over the package's build output; without
 * it Node fails with a bare module-resolution error that says nothing about
 * the missing build step.
 */
function assertCliBuilt(): void {
  if (existsSync(CLI_DIST)) return;
  throw new Error(`The simforge CLI is not built (${CLI_DIST} is missing); run \`pnpm --filter @simforge-oss/cli build\` before the CLI-backed suites`);
}

export async function runCli(args: readonly string[], options: RunCliOptions = {}): Promise<CliResult> {
  assertCliBuilt();
  const child = spawn(process.execPath, [CLI_BIN, ...args], {
    cwd: options.cwd ?? options.ctx?.dataRoot ?? REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...options.ctx?.env, ...options.env },
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
  const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 600_000);
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolve(exitCode ?? (signal ? 128 : 1)));
  }).finally(() => clearTimeout(timer));

  const stdout = Buffer.concat(stdoutChunks).toString("utf8");
  const stderr = Buffer.concat(stderrChunks).toString("utf8");
  let json: unknown = null;
  if (stdout.trim()) {
    try {
      json = JSON.parse(stdout);
    } catch {
      json = null;
    }
  }
  if (options.expectExit !== undefined && code !== options.expectExit) {
    throw new Error(`simforge ${args.join(" ")} exited ${code}, expected ${options.expectExit}\nstdout: ${stdout.slice(0, 1000)}\nstderr: ${stderr.slice(0, 1000)}`);
  }
  return { args: [...args], code, stdout, stderr, json };
}
