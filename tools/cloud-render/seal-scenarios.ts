/**
 * Seal approved documents and wait for their compiled execution packages.
 *
 *   node tools/cloud-render/seal-scenarios.ts /tmp/wanted-docs.json \
 *     --base https://dev.simforge.ai --token-file /path/to/token
 *
 * Plan-only unless --confirm is present. Traffic evidence is required by the
 * revision API, even with ambient traffic disabled; never manufacture it.
 */

import { appendFileSync, existsSync, readFileSync, truncateSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';

interface Candidate {
  doc: string;
  dataset: string;
  city: string;
  collision: 'Collision' | 'No Collision' | null;
}

interface Evidence {
  workspaceId: string;
  expectedVersion: number;
  ambient: Record<string, unknown> & { mode: string; resultSha256: string };
  materializedTraffic: {
    artifactId: string;
    sha256: string;
    sizeBytes: number;
    sourceInputDigest: string;
    mapAssetId: string;
    mapVersionId: string;
  };
}

type RevisionBody = Omit<Evidence, 'workspaceId'> & { idempotencyKey: string };
interface ManifestRow {
  base: string;
  document: string;
  revision: string | null;
  export: string | null;
  executionPackage: string | null;
  status: 'pending' | 'compiling' | 'sealed' | 'failed';
  workspaceId: string;
  body?: RevisionBody;
  error?: string;
}

// CreateScenarioRevisionResultDto and ScenarioExportDto, from the platform's
// app/lib/scenario/contracts.ts. The execution package belongs to the export,
// not the revision-creation response.
interface RevisionResult {
  revisionId: string;
  exportId: string;
  exportStatus: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  revision: { id: string; documentId: string; export: { id: string } };
}
interface ExportResult {
  id: string;
  revisionId: string;
  status: RevisionResult['exportStatus'];
  executionPackageId: string | null;
  errorCode: string | null;
}

function validateEvidence(evidence: Evidence): void {
  const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const text = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
  const traffic = evidence.materializedTraffic;
  const ambient = evidence.ambient;
  if (!text(evidence.workspaceId) || !Number.isSafeInteger(evidence.expectedVersion) || evidence.expectedVersion < 1
    || !traffic || !text(traffic.artifactId) || !digest(traffic.sha256) || !digest(traffic.sourceInputDigest)
    || !Number.isSafeInteger(traffic.sizeBytes) || traffic.sizeBytes < 1 || traffic.sizeBytes > 512 * 1024 * 1024
    || !text(traffic.mapAssetId) || !text(traffic.mapVersionId)
    || !ambient || !digest(ambient.configSha256) || ambient.resultSha256 !== traffic.sha256
    || !ambient.ambientConfig || typeof ambient.ambientConfig !== 'object' || Array.isArray(ambient.ambientConfig)) {
    throw new Error('Invalid saved-draft traffic evidence');
  }
  const common = ['mode', 'ambientConfig', 'configSha256', 'resultSha256'];
  let allowed = common;
  if (ambient.mode === 'disabled') {
    if (Object.keys(ambient.ambientConfig).length !== 0
      || ambient.configSha256 !== '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a') {
      throw new Error('Invalid disabled ambient provenance');
    }
  } else if (ambient.mode === 'native' || ambient.mode === 'sumo') {
    const version = ambient.mode === 'native' ? ambient.runtimeVersion : ambient.sumoVersion;
    if (!text(version) || String(version).trim().length > (ambient.mode === 'native' ? 128 : 64)
      || !(typeof ambient.seed === 'string' ? text(ambient.seed) && ambient.seed.trim().length <= 256 : Number.isSafeInteger(ambient.seed))
      || (ambient.mode === 'sumo' && !digest(ambient.networkSha256))) throw new Error('Invalid ambient provenance');
    allowed = [...common, 'seed', ...(ambient.mode === 'native' ? ['runtimeVersion'] : ['sumoVersion', 'networkSha256'])];
  } else throw new Error('Invalid ambient mode');
  if (Object.keys(ambient).some((key) => !allowed.includes(key))
    || Object.keys(traffic).some((key) => !['artifactId', 'sha256', 'sizeBytes', 'sourceInputDigest', 'mapAssetId', 'mapVersionId'].includes(key))) {
    throw new Error('Unexpected traffic evidence fields');
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      base: { type: 'string' },
      'token-file': { type: 'string' },
      'evidence-file': { type: 'string' },
      manifest: { type: 'string', default: '/tmp/seal-scenarios.jsonl' },
      concurrency: { type: 'string', default: '3' },
      'poll-ms': { type: 'string', default: '2000' },
      'timeout-ms': { type: 'string', default: '600000' },
      confirm: { type: 'boolean', default: false },
    },
  });
  if (positionals.length !== 1 || !values.base || !values['token-file']) {
    throw new Error('Usage: seal-scenarios.ts <documents.json> --base <origin> --token-file <file> [--evidence-file <file>] [--manifest <jsonl>] [--concurrency 3] [--poll-ms 2000] [--timeout-ms 600000] [--confirm]');
  }
  const baseUrl = new URL(values.base);
  if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password
    || baseUrl.pathname !== '/' || baseUrl.search || baseUrl.hash) throw new Error('--base must be an HTTP(S) origin');
  const base = baseUrl.origin;
  const concurrency = Number(values.concurrency);
  const pollMs = Number(values['poll-ms']);
  const timeoutMs = Number(values['timeout-ms']);
  if (![concurrency, pollMs, timeoutMs].every((value) => Number.isSafeInteger(value) && value > 0)
    || concurrency > 32) throw new Error('Concurrency must be 1–32; polling and timeout must be positive integer milliseconds');
  const candidates: Candidate[] = JSON.parse(readFileSync(positionals[0]!, 'utf8'));
  if (!Array.isArray(candidates) || candidates.some((item) => !item || typeof item.doc !== 'string' || !item.doc.startsWith('uscn_'))) {
    throw new Error('Input must be an array of scenario documents with uscn_ doc IDs');
  }
  const evidenceByDocument: Record<string, Evidence> = values['evidence-file']
    ? JSON.parse(readFileSync(values['evidence-file'], 'utf8')) : {};
  const manifest = values.manifest!;
  const prior = new Map<string, ManifestRow>();
  if (existsSync(manifest)) {
    const content = readFileSync(manifest, 'utf8');
    let completeBytes = 0;
    const lines = content.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (!line.trim()) {
        completeBytes += Buffer.byteLength(line + '\n');
        continue;
      }
      let row: ManifestRow;
      try { row = JSON.parse(line); } catch {
        if (index !== lines.length - 1) throw new Error(`Invalid manifest line ${index + 1}`);
        console.log('manifest: ignoring interrupted final write');
        if (values.confirm) truncateSync(manifest, completeBytes);
        break;
      }
      if (row.base !== base) throw new Error(`Manifest line ${index + 1} belongs to another base`);
      if (!row.document || !['pending', 'compiling', 'sealed', 'failed'].includes(row.status)
        || (row.status === 'sealed' && (!row.revision || !row.executionPackage))) throw new Error(`Invalid manifest line ${index + 1}`);
      prior.set(row.document, row);
      completeBytes += Buffer.byteLength(line + '\n');
      if (index === lines.length - 1 && values.confirm) appendFileSync(manifest, '\n', { flush: true });
    }
  }
  // No token read, fetch, or manifest write is needed for planning.
  const token = values.confirm ? readFileSync(values['token-file'], 'utf8').trim() : '';
  if (values.confirm && !token) throw new Error('Token file is empty');
  let mutations = 0;
  let planned = 0;
  let skipped = 0;
  let sealed = 0;
  let failed = 0;
  let blocked = 0;
  const seen = new Set<string>();
  const record = (row: ManifestRow) => {
    appendFileSync(manifest, JSON.stringify(row) + '\n', { flush: true });
    prior.set(row.document, row);
  };
  async function request<T>(path: string, workspaceId: string, body?: RevisionBody): Promise<T> {
    if (!values.confirm) throw new Error('Network disabled in dry run');
    if (body) mutations += 1;
    const response = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${token}`, Origin: base, 'X-SimForge-Workspace-Id': workspaceId, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(Math.min(timeoutMs, 30000)),
    });
    // Do not echo response bodies: an upstream error can contain credentials.
    if (!response.ok) throw new Error(`HTTP ${response.status} ${body ? 'POST' : 'GET'} ${path}`);
    return await response.json() as T;
  }
  async function seal(candidate: Candidate): Promise<void> {
    const label = candidate.doc.padEnd(46);
    const old = prior.get(candidate.doc);
    if (old?.status === 'sealed' || seen.has(candidate.doc)) {
      skipped += 1;
      console.log(`${label} SKIP ${old?.status === 'sealed' ? `sealed revision=${old.revision} executionPackage=${old.executionPackage}` : 'duplicate document'}`);
      return;
    }
    seen.add(candidate.doc);
    const path = `/api/simforge/documents/${encodeURIComponent(candidate.doc)}/revisions`;
    const idempotencyKey = `seal-scenarios:${createHash('sha256').update(`${base}\n${candidate.doc}`).digest('hex')}`;
    let row: ManifestRow | undefined;
    try {
      const evidence = old?.body ? { ...old.body, workspaceId: old.workspaceId } : evidenceByDocument[candidate.doc];
      if (!evidence) {
        if (values.confirm) throw new Error('Missing --evidence-file entry: saved draft version, workspace and materialized traffic required');
        blocked += 1;
        console.log(`${label} WOULD POST ${base}${path} ${JSON.stringify({ expectedVersion: '<saved draft version>', idempotencyKey, ambient: '<saved draft ambient provenance>', materializedTraffic: '<completed saved draft traffic reference>' })} origin=${base} workspace=<document workspace> BLOCKED missing evidence (template, not a valid request)`);
        return;
      }
      validateEvidence(evidence);
      const body: RevisionBody = old?.body ?? { expectedVersion: evidence.expectedVersion, idempotencyKey, ambient: evidence.ambient, materializedTraffic: evidence.materializedTraffic };
      row = { base, document: candidate.doc, revision: old?.revision ?? null, export: old?.export ?? null, executionPackage: null, status: 'pending', workspaceId: evidence.workspaceId, body };
      if (!values.confirm) {
        planned += 1;
        console.log(`${label} ${row.export ? `WOULD RESUME GET ${base}/api/simforge/exports/${encodeURIComponent(row.export)}` : `WOULD POST ${base}${path} ${JSON.stringify(body)}`} origin=${base} workspace=${row.workspaceId}`);
        return;
      }
      record(row); // Persist the exact body before sending; retries use the same key and draft.
      if (!row.export) {
        const result = await request<RevisionResult>(path, row.workspaceId, body);
        if (!result.revisionId || !result.exportId || result.revision?.id !== result.revisionId
          || result.revision.documentId !== candidate.doc || result.revision.export.id !== result.exportId) throw new Error('Invalid revision response');
        row.revision = result.revisionId;
        row.export = result.exportId;
      }
      row.status = 'compiling';
      record(row);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const result = await request<ExportResult>(`/api/simforge/exports/${encodeURIComponent(row.export)}`, row.workspaceId);
        if (result.id !== row.export || result.revisionId !== row.revision) throw new Error('Export identity mismatch');
        if (result.status === 'failed' || result.status === 'cancelled') throw new Error(`Export ${result.status}`);
        if (result.status === 'succeeded' && result.executionPackageId) {
          row.executionPackage = result.executionPackageId;
          row.status = 'sealed';
          record(row);
          sealed += 1;
          console.log(`${label} SEALED revision=${row.revision} executionPackage=${row.executionPackage}`);
          return;
        }
        await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
      }
      throw new Error('Timed out waiting for execution package; resume with the same manifest');
    } catch (error) {
      failed += 1;
      const message = (token ? String(error).split(token).join('[redacted]') : String(error)).slice(0, 240);
      if (values.confirm) record({ ...(row ?? old ?? { base, document: candidate.doc, revision: null, export: null, executionPackage: null, workspaceId: '' }), status: 'failed', error: message });
      console.log(`${label} FAILED ${message}`);
    }
  }
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, async () => {
    while (next < candidates.length) await seal(candidates[next++]!);
  }));
  console.log(`\nsummary: documents=${candidates.length} planned=${planned} blocked=${blocked} skipped=${skipped} sealed=${sealed} failed=${failed} networkMutations=${mutations} mode=${values.confirm ? 'confirm' : 'dry-run'}`);
  console.log(`results: ${manifest}${values.confirm ? '' : ' (unchanged; dry-run)'}`);
  if (failed > 0 || (values.confirm && blocked > 0)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(String(error));
  process.exitCode = 1;
});
