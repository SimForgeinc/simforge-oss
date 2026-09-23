import { readFile } from "node:fs/promises";
import { bevInsetSvg } from "@simforge-oss/evaluation/drive-evidence";
import { requireScenarioContext } from "@/app/lib/scenario/http";
import { resolveRunDirectory, runEvidenceFile } from "@/app/lib/evaluation/run-directory";

export async function GET(request: Request) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  try {
    const query = new URL(request.url).searchParams;
    const step = Number(query.get("step"));
    if (!Number.isSafeInteger(step) || step < 0) throw new Error("Invalid step");
    const directory = await resolveRunDirectory(auth.context, query.get("ref") ?? "");
    const rows = (await readFile(await runEvidenceFile(directory, "steps.jsonl"), "utf8")).trim().split("\n");
    const row = rows[step] ? JSON.parse(rows[step]!) : null;
    if (!row || row.step !== step || !row.extras?.bev) return Response.json({ error: "BEV not reported at this decision" }, { status: 404 });
    const body = bevInsetSvg(row.extras.bev);
    return new Response(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="8 96 220 280">${body}</svg>`, { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "private, no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
