/**
 * Seed a running local Studio host for flows/sim-history.spec.ts: create a document per exported
 * JSON (title, content, mapVersionId), resolve its authoritative simulation and cut Version 1.
 * Run it while the host runs the OLDER engine (SIMFORGE_NATIVE_RUNTIME_ADDON=<older addon>), then
 * restart the host on the current engine: every draft whose motion changed shows the banner.
 *
 *   SIMFORGE_CLOUD_ROOT=<host root> npx tsx e2e/tools/sim-history-seed.mts <docs dir> <seeded.json>
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { hostFetch } from "../../packages/cli/src/host-client.ts";

const SEED_DIR = process.argv[2]; const OUT = process.argv[3];
if (!SEED_DIR || !OUT) throw new Error('usage: sim-history-seed.mts <dir of exported documents> <seeded.json>');
async function call(path: string, init: RequestInit = {}) {
  const response = await hostFetch(path, {}, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}
const datasets = await call("/api/simforge/datasets");
const datasetId = (datasets.body.datasets ?? datasets.body)[0].id;
console.log("dataset", datasetId);
const made: Record<string, unknown>[] = [];
for (const file of readdirSync(SEED_DIR)) {
  const src = JSON.parse(readFileSync(`${SEED_DIR}/${file}`, "utf8"));
  const created = await call("/api/simforge/documents", {
    method: "POST",
    body: JSON.stringify({ title: `History ${src.title}`, content: src.content, mapVersionId: src.mapVersionId, datasetId, authoringQualityId: src.authoringQualityId ?? "medium" }),
  });
  if (created.status >= 300) { console.log("create failed", file, created.status, JSON.stringify(created.body).slice(0, 400)); continue; }
  const doc = created.body;
  let sim = await call(`/api/simforge/documents/${doc.id}/simulation`, { method: "POST", body: JSON.stringify({ expectedVersion: doc.draftVersion, waitMs: 25000 }) });
  for (let i = 0; i < 6 && sim.body?.state !== "succeeded" && sim.body?.state !== "failed"; i += 1) {
    sim = await call(`/api/simforge/documents/${doc.id}/simulation`, { method: "POST", body: JSON.stringify({ expectedVersion: doc.draftVersion, waitMs: 25000 }) });
  }
  console.log(doc.id, "sim", sim.status, sim.body?.state, sim.body?.result?.engineSemVer, sim.body?.failureCode ?? "");
  const rev = await call(`/api/simforge/documents/${doc.id}/revisions`, { method: "POST", body: JSON.stringify({ expectedVersion: doc.draftVersion, idempotencyKey: `seed-${doc.id}` }) });
  console.log(doc.id, "revision", rev.status, rev.body?.revision?.revisionNumber ?? JSON.stringify(rev.body).slice(0, 300));
  made.push({ file, id: doc.id, draftVersion: doc.draftVersion, simKey: sim.body?.result?.simKey, engine: sim.body?.result?.engineSemVer, revisionId: rev.body?.revisionId });
}
writeFileSync(OUT, JSON.stringify({ datasetId, made }, null, 2));
