/**
 * Render-submission gate, against a running daemon:
 *   pnpm exec tsx scripts/verify-render-submit.ts --root=/tmp/host [--document=uscn_...]
 *
 * Two regressions this exists to catch, both of which shipped silently:
 *
 * 1. THE RENDER PANE OFFERED NO SENSORS. `RenderConfigPanel` lists
 *    `authoredRenderSensors(currentContent)`, and the pane used to take that
 *    content from the open editor session — which the render route deliberately
 *    leaves empty. A scenario with eight authored sensors showed "Add a camera,
 *    LiDAR or radar to an actor in the editor before rendering". So this asserts
 *    the pane's OWN selector, over the record the pane now reads for itself,
 *    yields a non-empty list for a document that authors sensors.
 *
 * 2. `render submit` COULD NOT COMPLETE. Every OpenSCENARIO export failed —
 *    first with `errorCode: "fetch"` (the host minted object URLs on an origin
 *    it was not listening on), then with `RangeError: Map maximum size exceeded`
 *    (a lane width cubic sampled past its own section reported a lane 14,000 km
 *    wide and rasterized a spatial index of ~1e11 cells). Neither is visible
 *    from a unit test: both need a real host, a real worker and a real map. So
 *    this submits a render for that same document and rides it to `succeeded`
 *    with a playable video artifact.
 *
 * Attaches to whichever daemon owns `--root` (via its `host.json`), exactly like
 * `verify-asset-loading.ts`. It submits work, so it wants a daemon with a worker.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { authoredRenderSensors } from "@simforge-oss/scenario";
import type { ScenarioTemplateV2 } from "@simforge-oss/scenario";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const args = new Map(process.argv.slice(2).map((arg) => {
  const match = /^--(root|document|engine|timeout)=(.+)$/.exec(arg);
  if (!match) throw new Error(`unknown argument ${arg}`);
  return [match[1]!, match[2]!] as const;
}));
const root = args.get("root");
assert(root, "--root must name the data root of a running daemon (it is read for host.json)");
const host = JSON.parse(await readFile(join(root, "host.json"), "utf8")) as { baseUrl: string; controlToken: string; withWorker: boolean };
assert(host.withWorker, "this gate submits a render, so the daemon must have been started with its worker");
const authorization = `Bearer ${host.controlToken}`;
const timeoutSeconds = Number(args.get("timeout") ?? 900);
const pass = (message: string) => console.log(`PASS ${message}`);

async function api<T>(path: string): Promise<T> {
  const response = await fetch(new URL(path, host.baseUrl), { headers: { authorization }, signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return await response.json() as T;
}

type DocumentRecord = { id: string; title: string; content: ScenarioTemplateV2 };
type Summary = { id: string };

/** A document that authors at least one enabled sensor — what both regressions need. */
async function sensorDocument(): Promise<DocumentRecord> {
  const explicit = args.get("document");
  if (explicit) return await api<DocumentRecord>(`/api/simforge/documents/${encodeURIComponent(explicit)}`);
  const { datasets } = await api<{ datasets: { id: string }[] }>("/api/simforge/datasets");
  for (const dataset of datasets) {
    const { documents } = await api<{ documents: Summary[] }>(`/api/simforge/documents?datasetId=${encodeURIComponent(dataset.id)}`);
    for (const summary of documents) {
      const record = await api<DocumentRecord>(`/api/simforge/documents/${encodeURIComponent(summary.id)}`);
      if (record.content.roles.some((role) => role.actor.sensors.some((sensor) => sensor.enabled))) return record;
    }
  }
  throw new Error("no document in this root authors an enabled sensor; pass --document=<id>");
}

const document = await sensorDocument();
const authored = document.content.roles.flatMap((role) => role.actor.sensors.filter((sensor) => sensor.enabled));
assert(authored.length > 0, "fixture document must author an enabled sensor");
pass(`${document.id} (${document.title}) authors ${authored.length} enabled sensor(s)`);

// 1. The render pane's own selector, over the record the pane reads for itself.
const options = authoredRenderSensors(document.content);
assert(options.length > 0,
  `the render pane's sensor list is EMPTY for a document with ${authored.length} authored sensors — the pane would show its "add a camera" empty state`);
assert(options.length >= authored.length,
  `the pane offers ${options.length} sources for ${authored.length} authored sensors; every enabled sensor must be offered`);
assert(options.every((option) => option.actorId && option.sensor.id),
  "every offered sensor must carry the actor and sensor identity the render spec is keyed by");
pass(`render pane sensor list: ${options.length} sources (${options.map((option) => option.sensor.label ?? option.sensor.id).join(", ")})`);

// 2. The same intent the wizard submits, end to end, on this host.
// The CLI is invoked as the operator invokes it, in its own process: the gate
// asserts the shipped entry point works, not that a function it imported does.
const engine = args.get("engine") ?? "native";
const cli = join(import.meta.dirname, "..", "..", "packages", "cli", "src", "main.ts");
const { stdout } = await promisify(execFile)(process.execPath, [
  "--import", "tsx", "--conditions=development", cli, "render", "submit",
  "--data-root", root, "--scenario", document.id, "--engine", engine,
  "--seconds", "5", "--fps", "20", "--resolution", "1280x720", "--quality", "standard",
], { timeout: timeoutSeconds * 1_000, maxBuffer: 8 * 1024 * 1024 });
const accepted = JSON.parse(stdout.trim().split("\n").at(-1)!) as { jobId: string; status: string };
assert(accepted.jobId, `render submit produced no job id: ${stdout}`);
pass(`render submit accepted a ${engine} render for ${document.id} (${accepted.jobId}, ${accepted.status})`);

type Job = { id: string; status: string; failureCode: string | null };
const deadline = Date.now() + timeoutSeconds * 1_000;
let job: Job | undefined;
for (;;) {
  const { renderJobs } = await api<{ renderJobs: Job[] }>(`/api/simforge/render-jobs?documentId=${encodeURIComponent(document.id)}&limit=10`);
  job = renderJobs.find((candidate) => candidate.status === "succeeded") ?? renderJobs[0];
  if (job && (job.status === "succeeded" || job.status === "failed" || job.status === "cancelled")) break;
  assert(Date.now() < deadline, `render did not reach a terminal state within ${timeoutSeconds}s (last state ${job?.status ?? "none"})`);
  const tick = Promise.withResolvers<void>();
  setTimeout(tick.resolve, 5_000);
  await tick.promise;
}
assert.equal(job.status, "succeeded", `render ${job.id} ended ${job.status} (${job.failureCode ?? "no failure code"})`);

type Download = { id: string; mediaType: string; byteLength: number; artifactState: string };
const { items } = await api<{ items: Download[] }>(`/api/simforge/render-jobs/${encodeURIComponent(job.id)}/downloads`);
const videos = items.filter((item) => item.mediaType.startsWith("video/"));
assert(videos.length > 0, `render ${job.id} succeeded with no video artifact`);
assert(videos.every((video) => video.artifactState === "available" && video.byteLength > 100_000),
  `every video must be available and non-trivial: ${videos.map((video) => `${video.id}=${video.byteLength}B/${video.artifactState}`).join(", ")}`);
pass(`render ${job.id} succeeded with ${videos.length} video artifact(s), ${videos.reduce((sum, video) => sum + video.byteLength, 0)} bytes total`);
console.log(`PASS verify-render-submit (${document.id})`);
