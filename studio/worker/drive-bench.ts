import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, mkdir, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DriveBenchParamsSchema } from "../app/lib/models/contracts";
import type { LeasedModelRun } from "../app/lib/models/model-run-store";

/** Each queue attempt has a fresh output root: the bench never overwrites another run. */
export function driveAttemptRoot(runsRoot: string, runId: string, attempt: number): string {
  return join(runsRoot, "drive", "studio", runId, `attempt-${attempt}`);
}

export async function benchRunDirectories(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name));
}

export async function executeDriveBenchRun(lease: LeasedModelRun, options: { runsRoot: string; signal: AbortSignal }) {
  const params = DriveBenchParamsSchema.parse(lease.params);
  const out = driveAttemptRoot(options.runsRoot, lease.runId, lease.attemptNumber);
  await mkdir(out, { recursive: true });
  const root = process.env.SIMFORGE_REPO_ROOT || resolve(process.cwd(), process.cwd().endsWith("/studio") ? ".." : ".");
  const source = join(root, "packages", "cli", "src", "main.ts");
  const hasSource = await access(source).then(() => true, () => false);
  const command = process.env.SIMFORGE_CLI_BINARY || (hasSource ? process.execPath : "simforge");
  const prefix = !process.env.SIMFORGE_CLI_BINARY && hasSource ? ["--import", "tsx", source] : [];
  const output = createWriteStream(join(out, "worker.log"), { flags: "a" });
  async function run(args: string[]) {
    if (options.signal.aborted) throw options.signal.reason;
    await new Promise<void>((resolveRun, reject) => {
      const child = spawn(command, [...prefix, ...args], {
        cwd: root, stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --conditions=development` },
      });
      child.stdout.pipe(output, { end: false });
      child.stderr.pipe(output, { end: false });
      const cancel = () => child.kill("SIGTERM");
      options.signal.addEventListener("abort", cancel, { once: true });
      child.once("error", reject);
      child.once("close", (code) => {
        options.signal.removeEventListener("abort", cancel);
        if (code === 0) resolveRun();
        else reject(new Error(`simforge ${args.slice(0, 2).join(" ")} exited ${code}; see ${out}/worker.log`));
      });
    });
  }
  try {
    await run(["drive", "run", "--policy", params.policy, "--scenario", params.scenario,
      "--seed", String(lease.seed), "--duration", String(params.duration), "--out", out]);
    const directories = await benchRunDirectories(out);
    if (directories.length !== 1) throw new Error(`Expected one bench run, found ${directories.length}`);
    const runDir = directories[0]!;
    await run(["drive", "verify", runDir]);
    const result = JSON.parse(await readFile(join(runDir, "result.json"), "utf8"));
    return { metrics: { ...result.metrics, benchStatus: result.status, verified: true }, outputRefs: [
      { kind: "directory", path: runDir }, { kind: "file", path: join(runDir, "result.json"), role: "result" },
    ] };
  } finally {
    await new Promise<void>((done) => output.end(done));
  }
}
