/** Real daemon jobs, not staged-profile mocks.
 * --root=<throwaway daemon with worker> --scenario=<real RGB scenario>
 * --profile=render|ml [--envs=2] [--timeout=900] [--expect-capacity-refusal=true]
 * ML submits N distinct jobs twice and compares EVERY decoded frame. Serialized
 * scheduling fails the parallel-env assertion rather than claiming parallelism.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { authoredRenderSensors, backendModalities, buildCanonicalRenderSpec, defaultModalities, EnvironmentSchema } from '@simforge-oss/scenario';
import { hostSession } from '../../packages/cli/src/commands/local';
import { freezeScenario } from '../../packages/cli/src/commands/scenario';
import { Checks } from './texture-tier-assertions';

const args = new Map(process.argv.slice(2).map(arg => { const at = arg.indexOf('='); return [arg.slice(2, at), arg.slice(at + 1)]; }));
const root = args.get('root');
assert(root && !resolve(root).includes('/.local/share/simforge/'), '--root must name a throwaway daemon');
assert(args.get('scenario'), '--scenario must name a real scenario with an enabled RGB sensor');
const profile = args.get('profile') ?? 'render';
assert(profile === 'render' || profile === 'ml');
const expectRefusal = args.has('expect-capacity-refusal');
assert(!expectRefusal || profile === 'render', 'refusal fixture is Garching full tier');
const envs = profile === 'ml' ? Number(args.get('envs') ?? 2) : 1;
assert(Number.isInteger(envs) && envs >= (profile === 'ml' ? 2 : 1) && envs <= 16);
// Garching's measured ML estimate is 5.36 GiB; pin 6 GiB, never silently shrink.
const budgetBytes = Number(args.get('budget-bytes') ?? (profile === 'ml' ? 6 : 16) * 1024 ** 3);
assert(Number.isSafeInteger(budgetBytes) && budgetBytes > 0);
const timeoutMs = Number(args.get('timeout') ?? 900) * 1000;
const host = JSON.parse(await readFile(join(root, 'host.json'), 'utf8')) as { baseUrl: string; controlToken: string; withWorker: boolean };
const base = new URL(host.baseUrl);
assert(base.hostname === '127.0.0.1' && Number(base.port) >= 5514 && Number(base.port) <= 5517);
assert(host.withWorker, 'native gate needs the actual daemon worker');
const out = resolve(args.get('out') ?? join(root, 'native-tier-evidence', expectRefusal ? 'garching-full-refusal' : profile));
await mkdir(out, { recursive: true });
const session = await hostSession(root);
const document = await session.host.projects.getDocument(args.get('scenario')!);
const api = async <T>(path: string, body?: unknown): Promise<T> => {
  const response = await fetch(new URL(path, base), { method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${host.controlToken}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
};
const catalog = await api<{ maps: { mapVersionId: string; sourceMapId: string }[] }>('/api/simforge/maps');
const expectedMap = profile === 'ml' || expectRefusal ? 'garching-phase-1-2' : 'belmont-research-center';
assert(catalog.maps.some(map => map.mapVersionId === document.mapVersionId && map.sourceMapId === expectedMap),
  `native ${profile} gate requires ${expectedMap}, not a substituted map`);
const sensors = authoredRenderSensors(document.content);
const selections = sensors.map(option => ({ actorId: option.actorId, sensorId: option.sensor.id,
  modalities: defaultModalities(option.sensor).filter(modality => backendModalities('native', option.sensor).includes(modality)) })).filter(selection => selection.modalities.includes('rgb'));
assert(selections.length > 0, 'Garching fixture must author an enabled RGB sensor');
const width = 1280, height = 720, fps = 20, seconds = 2;
const renderSpec = buildCanonicalRenderSpec({ content: document.content, selections,
  clip: { startSeconds: 0, endSeconds: seconds }, video: { width, height, fps, container: 'mp4', codec: 'h264', quality: 'standard' },
  artifacts: ['video', 'trace', 'manifest'], staticSemantics: false, fidelity: 'dataset',
  environment: document.content.environment ?? EnvironmentSchema.parse({}) });
const frozen = await freezeScenario(session, document, timeoutMs / 1000);
const checks = new Checks();
const execute = promisify(execFile);
type ProfileEvidence = { renderTextures: string; memberCount: number; textureBytes: number; geometryBytes: number; estimatedBytes: number; budgetBytes: number | null; cacheKey: string };
type Artifact = { id: string; url: string | null; mediaType: string; identity: { role: string; actorId: string | null; sensorId: string | null; modality: string | null } | null };
const rounds: { jobIds: string[]; peakActive: number; elapsedSeconds: number; totalFrames: number; framesPerSecond: number; profiles: ProfileEvidence[]; hashes: Record<string, string>[] }[] = [];
const outstanding = new Set<string>();
try {
for (let round = 0; round < (profile === 'ml' ? 2 : 1); round++) {
  const started = performance.now();
  const submissions: PromiseSettledResult<{ id: string }>[] = await Promise.allSettled(Array.from({ length: envs }, () => api<{ id: string }>('/api/simforge/render-jobs', {
    schema: 'uniscenario.render-intent-submission/v1', engine: 'native', revisionId: frozen.revisionId,
    executionPackageId: frozen.executionPackageId, renderSpec, renderProfile: profile,
    nativeVramBudgetBytes: budgetBytes, idempotencyKey: `texture-tier-gate:${randomUUID()}`,
  }).then(job => { outstanding.add(job.id); return job; })));
  const rejected = submissions.filter(result => result.status === 'rejected');
  assert.equal(rejected.length, 0, `native submissions refused: ${rejected.map(result => String(result.reason)).join('; ')}`);
  const jobs: { id: string }[] = submissions.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
  assert.equal(new Set(jobs.map(job => job.id)).size, envs, 'parallel environments must be distinct real jobs');
  let peakActive = 0;
  let refused = false;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { renderJobs } = await api<{ renderJobs: { id: string; status: string; failureCode: string | null }[] }>('/api/simforge/render-jobs');
    const current = jobs.map(job => renderJobs.find(row => row.id === job.id));
    assert(current.every(Boolean), 'submitted job missing from real queue');
    peakActive = Math.max(peakActive, current.filter(job => job?.status === 'running').length);
    const failed = current.find(job => job?.status === 'failed' || job?.status === 'cancelled');
    if (expectRefusal && failed) {
      const detail = await api<{ failureCode: string; failureDetail: unknown }>(`/api/simforge/render-jobs/${failed.id}`);
      checks.check('Garching full tier refuses explicitly with demand/capacity/override knob', detail, () => {
        assert.equal(detail.failureCode, 'native_texture_capacity_exceeded');
        const failure = typeof detail.failureDetail === 'string' ? JSON.parse(detail.failureDetail) as unknown : detail.failureDetail;
        assert(failure && typeof failure === 'object' && 'message' in failure && typeof failure.message === 'string');
        const message = failure.message;
        const amounts = message.match(/calculated demand (\d+) bytes exceeds (?:assumed|explicit) capacity (\d+) bytes/);
        assert(amounts, 'refusal must name calculated demand and declared capacity');
        assert(Number(amounts[1]) > Number(amounts[2]));
        assert.equal(Number(amounts[2]), budgetBytes);
        assert(message.includes('nativeVramBudgetBytes'), 'refusal must name the override knob');
      });
      outstanding.delete(failed.id);
      refused = true;
      break;
    }
    assert(!failed, `native ${profile} job ${failed?.id}: ${failed?.status} ${failed?.failureCode}`);
    if (current.every(job => job?.status === 'succeeded')) break;
    assert(Date.now() < deadline, `native ${profile} jobs timed out: ${JSON.stringify(current)}`);
    const tick = Promise.withResolvers<void>(); setTimeout(tick.resolve, 500); await tick.promise;
  }
  if (expectRefusal) {
    checks.check('Garching full tier never silently downgrades or succeeds beyond capacity', { refused }, () => assert(refused));
    break;
  }
  for (const job of jobs) outstanding.delete(job.id);
  const elapsedSeconds = (performance.now() - started) / 1000;
  const profiles: ProfileEvidence[] = [];
  const hashes: Record<string, string>[] = [];
  let totalFrames = 0;
  for (const [env, job] of jobs.entries()) {
    const { items } = await api<{ items: Artifact[] }>(`/api/simforge/render-jobs/${encodeURIComponent(job.id)}/downloads`);
    const diagnostics = items.find(item => item.identity?.role === 'diagnostics');
    assert(diagnostics?.url, `job ${job.id} has no downloadable native diagnostics`);
    const diagnosticResponse = await fetch(new URL(diagnostics.url, base), { headers: { authorization: `Bearer ${host.controlToken}` } });
    assert(diagnosticResponse.ok);
    const diagnostic = await diagnosticResponse.json() as { textureProfile?: ProfileEvidence };
    checks.check(`${profile}/${round}/${env} selected native representation and ${expectedMap} closure`, diagnostic.textureProfile, () => {
      assert(diagnostic.textureProfile);
      assert.equal(diagnostic.textureProfile.renderTextures, profile === 'render' ? 'uastc-full' : 'bc7-512');
      assert(diagnostic.textureProfile.memberCount >= (profile === 'ml' ? 13_936 : 2305), 'native texture members must survive closure validation');
      assert(diagnostic.textureProfile.textureBytes > 0 && diagnostic.textureProfile.geometryBytes > 0);
      assert(diagnostic.textureProfile.cacheKey);
      assert.equal(diagnostic.textureProfile.budgetBytes, budgetBytes);
      assert(diagnostic.textureProfile.estimatedBytes <= budgetBytes);
    });
    if (diagnostic.textureProfile) profiles.push(diagnostic.textureProfile);
    const videos = items.filter(item => item.mediaType.startsWith('video/'));
    assert(videos.length >= selections.length, 'missing RGB videos');
    const envHashes: Record<string, string> = {};
    for (const [index, video] of videos.entries()) {
      assert(video.url);
      const response = await fetch(new URL(video.url, base), { headers: { authorization: `Bearer ${host.controlToken}` } });
      assert(response.ok);
      const file = join(out, `${round}-${env}-${index}.mp4`);
      await writeFile(file, new Uint8Array(await response.arrayBuffer()));
      const probe = JSON.parse((await execute('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=width,height,nb_read_frames', '-of', 'json', file])).stdout) as { streams: { width: number; height: number; nb_read_frames: string }[] };
      const stream = probe.streams[0];
      checks.check(`${profile}/${round}/${env}/${index} output dimensions and frame count`, stream, () => { assert(stream); assert.equal(stream.width, width); assert.equal(stream.height, height); assert.equal(Number(stream.nb_read_frames), fps * seconds); });
      totalFrames += Number(stream?.nb_read_frames ?? 0);
      const decoded = await execute('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:v:0', '-f', 'framemd5', '-'], { maxBuffer: 8 * 1024 * 1024 });
      envHashes[JSON.stringify(video.identity)] = decoded.stdout;
      const raw = await execute('ffmpeg', ['-v', 'error', '-i', file, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], { encoding: 'buffer', maxBuffer: width * height * 3 + 4096 });
      let sum = 0, squares = 0;
      for (const value of raw.stdout) { sum += value; squares += value * value; }
      const mean = sum / raw.stdout.length;
      const deviation = Math.sqrt(squares / raw.stdout.length - mean * mean);
      checks.check(`${profile}/${round}/${env}/${index} nonblank native frame`, { mean, deviation }, () => { assert.equal(raw.stdout.length, width * height * 3); assert(mean > 10 && deviation > 8); });
    }
    hashes.push(envHashes);
  }
  rounds.push({ jobIds: jobs.map(job => job.id), peakActive, elapsedSeconds, totalFrames, framesPerSecond: totalFrames / elapsedSeconds, profiles, hashes });
  if (profile === 'ml') checks.check(`ml/${round} throughput with N parallel environments`, rounds[round], () => { assert.equal(peakActive, envs, 'scheduler serialized the requested parallel environments'); assert(totalFrames / elapsedSeconds > 0); });
}
if (profile === 'ml') {
  checks.check('ML identical decoded frames across all environments and both runs', { envs, rounds: rounds.length, frames: rounds.map(round => round.totalFrames) }, () => {
    const reference = rounds[0]!.hashes[0];
    assert(reference && Object.keys(reference).length > 0);
    for (const round of rounds) for (const hashes of round.hashes) assert.deepEqual(hashes, reference);
    assert.equal(new Set(rounds.flatMap(round => round.profiles.map(profile => profile.cacheKey))).size, 1, 'persistent native cache identity changed for identical inputs');
  });
}
await writeFile(join(out, 'results.json'), JSON.stringify({ profile, envs, rounds, checks: checks.results }, null, 2));
checks.finish();
} catch (error) {
  console.error(`FAIL native ${profile} execution: ${String(error)}`);
  throw error;
} finally {
  for (const id of outstanding) {
    const cancelled = await fetch(new URL(`/api/simforge/render-jobs/${id}`, base), {
      method: 'DELETE', headers: { authorization: `Bearer ${host.controlToken}` },
    });
    if (!cancelled.ok && cancelled.status !== 409) console.error(`FAIL cancelling unfinished gate job ${id}: ${cancelled.status}`);
  }
}
