import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getModelRun } from "@/app/lib/models/model-run-store";
import { requireScenarioContext } from "@/app/lib/scenario/http";
import { benchRunDirectories, driveAttemptRoot } from "@/worker/drive-bench";

type Context = { params: Promise<{ jobId: string }> };
export async function GET(request: Request, route: Context) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const context = auth.context;
  const { jobId } = await route.params;
  const first = await getModelRun(auth.context, jobId);
  if (!first || first.run.kind !== "drive_bench") return Response.json({ error: "bench_job_not_found" }, { status: 404 });
  const runsRoot = process.env.SIMFORGE_RUNS_ROOT?.trim() || join(homedir(), "simforge-assets", "runs");
  const encoder = new TextEncoder();
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const stop = () => { stopped = true; clearTimeout(timer); };
      request.signal.addEventListener("abort", stop, { once: true });
      async function tick() {
        try {
          const detail = await getModelRun(context, jobId);
          if (stopped) return;
          if (!detail) throw new Error("Bench job disappeared");
          const root = driveAttemptRoot(runsRoot, jobId, Math.max(1, detail.run.attemptCount));
          const directories = await benchRunDirectories(root);
          const logs = await Promise.all([join(root, "worker.log"), ...directories.map((dir) => join(dir, "log.txt"))].map(async (path) => {
            try { return await readFile(path, "utf8"); }
            catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; }
          }));
          if (stopped) return;
          const runRef = detail.run.outputRefs.find((ref): ref is { kind: string; path: string } => !!ref && typeof ref === "object" && "kind" in ref && ref.kind === "directory" && "path" in ref && typeof ref.path === "string");
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ status: detail.run.status, log: logs.join("\n").slice(-200_000), runDir: runRef?.path ?? null, events: detail.events })}\n\n`));
          if (detail.run.status === "succeeded" || detail.run.status === "failed") {
            stop(); request.signal.removeEventListener("abort", stop); controller.close();
          } else timer = setTimeout(() => void tick(), 750);
        } catch (error) {
          if (!stopped) { stop(); controller.error(error); }
        }
      }
      void tick();
    },
    cancel() { stopped = true; clearTimeout(timer); },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "private, no-store", "X-Accel-Buffering": "no" } });
}
