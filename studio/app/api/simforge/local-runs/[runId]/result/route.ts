import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { NextResponse } from "next/server";
import { getModelRun } from "@/app/lib/models/model-run-store";
import { requireScenarioContext, SCENARIO_PRIVATE_CACHE_HEADERS } from "@/app/lib/scenario/http";

/**
 * The durable result manifest of a run executed on this machine.
 *
 * A local run writes `result.json` (`simforge.eval-result-manifest/v1`) to disk
 * and records its path in `outputRefs`; the run row's own `metrics` is a
 * summary. Reading the manifest is what lets the local result screen show the
 * same metrics and provenance a cloud run shows, from the same document, rather
 * than a second rendering of a different shape.
 *
 * The path is not taken on trust even though it comes from our own store: it
 * must be absolute, must be the run's own recorded `result.json`, and must
 * resolve inside the runs root. A path-traversal bug here would turn a run
 * record into an arbitrary file read.
 */

function runsRoot(): string {
  const configured = process.env.SIMFORGE_RUNS_ROOT?.trim();
  return resolve(configured && configured.length > 0 ? configured : `${homedir()}/simforge-assets/runs`);
}

type FileRef = { kind?: unknown; path?: unknown; role?: unknown };

export async function GET(_request: Request, route: { params: Promise<{ runId: string }> }) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const { runId } = await route.params;

  const run = await getModelRun(auth.context, runId);
  if (!run) return NextResponse.json({ error: "model_run_not_found" }, { status: 404 });

  const refs: FileRef[] = Array.isArray(run.outputRefs) ? (run.outputRefs as FileRef[]) : [];
  const manifestRef = refs.find(
    (ref) => typeof ref.path === "string" && ref.path.endsWith("result.json"),
  );
  if (!manifestRef || typeof manifestRef.path !== "string") {
    return NextResponse.json(
      { error: "result_not_available", detail: "this run has not written result.json yet" },
      { status: 404 },
    );
  }

  const path = resolve(manifestRef.path);
  const root = runsRoot();
  if (!isAbsolute(manifestRef.path) || (path !== root && !path.startsWith(`${root}/`))) {
    return NextResponse.json(
      { error: "result_path_rejected", detail: "the recorded result path is outside the runs root" },
      { status: 422 },
    );
  }

  try {
    const raw = await readFile(path, "utf8");
    return new NextResponse(raw, {
      status: 200,
      headers: { ...SCENARIO_PRIVATE_CACHE_HEADERS, "content-type": "application/json" },
    });
  } catch {
    return NextResponse.json(
      { error: "result_unreadable", detail: "result.json is recorded but could not be read" },
      { status: 409 },
    );
  }
}
