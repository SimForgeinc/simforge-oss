import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { assessDriveModelHealth } from "@simforge-oss/evaluation/drive-evidence";
import type { AppContext } from "../db/app-context";
import { queryOne } from "../db/data-api";
import { localObjectPath } from "../s3/s3-object";
import { runFileUrl, type JsonObject, type RunDirectoryView, type RunView } from "../../dashboard/evaluation/run-viewer-contract";

export async function resolveRunDirectory(context: AppContext, ref: string): Promise<string> {
  if (!ref || ref.includes("\0")) throw new Error("A local run path or artifact id is required");
  let path = ref;
  if (ref.startsWith("artifact:") || (!ref.includes("/") && !ref.includes("\\"))) {
    const id = ref.replace(/^artifact:(?:\/\/)?/, "");
    const artifact = await queryOne<{ storage_bucket: string; storage_key: string }>(
      `SELECT storage_bucket, storage_key FROM simforge.artifacts
       WHERE id = :id AND workspace_id = :workspace_id AND artifact_state = 'available' AND deleted_at IS NULL`,
      { id, workspace_id: context.workspaceId },
    );
    if (!artifact) throw new Error("Run artifact not found in this installation");
    path = dirname(localObjectPath(artifact.storage_bucket, artifact.storage_key));
  }
  if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
  path = await realpath(resolve(path));
  if (!(await stat(path)).isDirectory()) {
    if (!["result.json", "run.json", "report.json", "drive.mp4", "heat.mp4"].includes(basename(path))) throw new Error("Expected a run directory or its manifest/video");
    path = dirname(path);
  }
  // Arbitrary directory reads are not a file browser: require bench evidence.
  if (!await exists(join(path, "run.json")) && !await exists(join(path, "heat.mp4"))) throw new Error("Not a drive bench run or heat directory");
  return path;
}

export async function exists(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

async function json(path: string): Promise<JsonObject | null> {
  if (!await exists(path)) return null;
  if ((await stat(path)).size > 32 * 1024 * 1024) throw new Error(`Manifest too large: ${basename(path)}`);
  return JSON.parse(await readFile(path, "utf8")) as JsonObject;
}

export async function runEvidenceFile(root: string, file: string): Promise<string> {
  if (!/^(?:(?:solo\/[A-Za-z0-9_.-]+)\/)?(?:drive\.mp4|heat\.mp4|run\.json|steps\.jsonl|result\.json|score\.json|report\.json|log\.txt)$/.test(file)) throw new Error("Unsupported run evidence file");
  const path = await realpath(join(root, file));
  const child = relative(root, path);
  if (child.startsWith("..") || isAbsolute(child) || !(await stat(path)).isFile()) throw new Error("Run evidence escapes its directory");
  return path;
}

export async function readRunDirectory(root: string): Promise<RunDirectoryView> {
  const heat = await exists(join(root, "heat.mp4"));
  const report = heat ? await json(join(root, "report.json")) : null;
  const declared = Array.isArray(report?.runs) ? report.runs.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || !("runDir" in entry) || typeof entry.runDir !== "string") throw new Error("Invalid heat run reference");
    return resolve(root, entry.runDir);
  }) : null;
  const children = heat
    ? declared ?? (await readdir(root, { withFileTypes: true })).filter((item) => item.isDirectory()).map((item) => join(root, item.name))
    : [root];
  const runs: RunView[] = [];
  for (const directory of children) {
    const run = await json(join(directory, "run.json"));
    if (!run) continue;
    const { frameDigests: _frames, ...metadata } = run;
    const result = await json(join(directory, "result.json"));
    const score = await json(join(directory, "score.json"));
    const metrics = result?.metrics as JsonObject | undefined;
    const health = assessDriveModelHealth(metrics?.modelHealth as JsonObject | undefined);
    const label = String(run.policy ?? basename(directory));
    const solo = `solo/${label}/drive.mp4`;
    runs.push({ ref: directory, label, run: metadata, result, score, health,
      videoUrl: await exists(join(directory, "drive.mp4")) ? runFileUrl(directory, "drive.mp4") : null,
      stepsUrl: await exists(join(directory, "steps.jsonl")) ? runFileUrl(directory, "steps.jsonl") : null,
      soloClipUrl: heat && /^[A-Za-z0-9_.-]+$/.test(label) && await exists(join(root, solo)) ? runFileUrl(root, solo) : null,
    });
  }
  if (!runs.length) throw new Error("No bench run.json found in this directory");
  const warmup = runs[0]!.run.warmupFrames, hz = runs[0]!.run.decisionHz;
  const videoPolicyOffsetS = heat ? 0
    : typeof warmup === "number" && warmup >= 0 && typeof hz === "number" && hz > 0 ? warmup / hz : null;
  return { ref: root, kind: heat ? "heat" : "solo", videoPolicyOffsetS, videoUrl: heat ? runFileUrl(root, "heat.mp4") : runs[0]!.videoUrl, report, runs };
}
