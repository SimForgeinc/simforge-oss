import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, basename, resolve, dirname } from "node:path";
import { safeParseSimScenarioInput } from "@simforge-oss/engine";
import { CreateModelRunSchema, DriveBenchParamsSchema } from "@/app/lib/models/contracts";
import { createModelRun } from "@/app/lib/models/model-run-store";
import { readJson, requireScenarioContext } from "@/app/lib/scenario/http";

export async function POST(request: Request) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  try {
    const body = await readJson(request) as Record<string, unknown>;
    let bytes: string;
    if (body.input) {
      const input = safeParseSimScenarioInput(body.input);
      if (!input.ok) throw new Error("Invalid materialized scenario input");
      bytes = JSON.stringify({ scenarioId: String(body.scenarioId || "studio-scenario").replace(/[^A-Za-z0-9_.-]/g, "-"), instances: [input.value] });
    } else {
      let file = String(body.scenario ?? "");
      if (file.startsWith("~/")) file = join(homedir(), file.slice(2));
      file = await realpath(file);
      // Freeze path inputs too, including form-B references, before enqueueing.
      const document = JSON.parse(await readFile(file, "utf8"));
      if (Array.isArray(document.instances)) {
        const first = document.instances[0];
        const ref = typeof first === "string" ? first : typeof first?.input === "string" ? first.input : null;
        if (ref) {
          const instance = JSON.parse(await readFile(resolve(dirname(file), ref), "utf8"));
          document.instances = [instance.input ?? instance];
        }
        document.scenarioId ??= basename(file, ".json");
      }
      bytes = JSON.stringify(document);
    }
    const root = process.env.SIMFORGE_RUNS_ROOT?.trim() || join(homedir(), "simforge-assets", "runs");
    const inputs = join(root, "drive", "studio", "inputs");
    await mkdir(inputs, { recursive: true });
    const scenario = join(inputs, `${createHash("sha256").update(bytes).digest("hex")}.episodes.json`);
    await writeFile(scenario, bytes);
    const params = DriveBenchParamsSchema.parse({ scenario, policy: body.policy, duration: body.duration });
    const input = CreateModelRunSchema.parse({ kind: "drive_bench", params, seed: body.seed, maxAttempts: 1 });
    const queued = await createModelRun(auth.context, input);
    if (queued.kind !== "created") throw new Error("Bench queue rejected submission");
    return Response.json({ job: queued.run }, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
