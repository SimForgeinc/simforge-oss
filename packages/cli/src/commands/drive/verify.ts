import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { EPISODE_TRACE_SCHEMA, ResultManifestSchema, verifyEpisodeTrace } from '@simforge-oss/evaluation';

import { getProfile } from './profiles.js';
import { safeRunId } from './run-dir.js';
import { assessDriveModelHealth } from '@simforge-oss/evaluation/drive-evidence';
import type { ModelHealthAssessment } from '@simforge-oss/evaluation/drive-evidence';

export interface DriveVerifyReport {
  readonly runDir: string;
  readonly runId: string;
  readonly steps: number;
  readonly framesPerSensor: Record<string, number>;
  readonly expectedFrames: number;
  readonly frameDigestsVerified: number;
  readonly passFrameDigestsVerified?: number;
  readonly traceDigest: string | null;
  readonly modelHealth: ModelHealthAssessment;
  readonly manifestValid: true;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function jsonLines(file: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(file, 'utf8');
  return text.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function frameFiles(dir: string): Promise<string[]> {
  const names = await readdir(dir);
  return names.filter((name) => /^\d+\.png$/.test(name)).sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('appearance evidence must be a JSON object');
  return value as Record<string, unknown>;
}

function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error('appearance trace field must be an array');
  return value.map(record);
}

export async function verifyRunDirectory(runDir: string): Promise<DriveVerifyReport> {
  const absolute = path.resolve(runDir);
  const run = JSON.parse(await readFile(path.join(absolute, 'run.json'), 'utf8')) as Record<string, unknown>;
  const result = ResultManifestSchema.parse(JSON.parse(await readFile(path.join(absolute, 'result.json'), 'utf8')));
  if (result.kind !== 'closedloop-episode') throw new Error(`result kind must be closedloop-episode, got ${result.kind}`);
  if (result.status !== 'succeeded') throw new Error(`result status is ${result.status}, not succeeded`);
  for (const required of ['run.json', 'score.json', 'steps.jsonl', 'trace.jsonl', 'drive.mp4', 'log.txt']) {
    if (!result.artifacts.some((artifact) => artifact.path === required)) throw new Error(`manifest is missing required evidence: ${required}`);
  }
  if (result.runId !== safeRunId(String(run['scenarioId']), String(run['policyId']), Number(run['seed']))) throw new Error('result runId does not match run.json identity');
  const steps = await jsonLines(path.join(absolute, 'steps.jsonl'));
  if (steps.length === 0) throw new Error('run has no policy decisions');
  const expectedFrames = steps.length + Number(run['warmupFrames'] ?? 0);
  if (steps.some((row, index) => row['step'] !== index)) throw new Error('steps.jsonl must contain contiguous zero-based step rows');
  const frameDigests = run['frameDigests'];
  if (!frameDigests || typeof frameDigests !== 'object') throw new Error('run.json is missing frameDigests');
  const framesPerSensor: Record<string, number> = {};
  let frameDigestsVerified = 0;
  for (const [sensorId, expected] of Object.entries(frameDigests as Record<string, unknown>)) {
    const dir = path.join(absolute, 'frames', sensorId);
    const files = await frameFiles(dir);
    framesPerSensor[sensorId] = files.length;
    if (files.length !== expectedFrames) throw new Error(`${sensorId} has ${files.length} frames; expected ${expectedFrames}`);
    if (!Array.isArray(expected) || expected.length !== files.length) throw new Error(`${sensorId} frame digest list length mismatch`);
    for (const [index, file] of files.entries()) {
      const digest = sha256(await readFile(path.join(dir, file)));
      if (digest !== expected[index]) throw new Error(`${sensorId}/${file} digest mismatch`);
      frameDigestsVerified += 1;
    }
  }
  if (Object.keys(framesPerSensor).length === 0) throw new Error('run has no rendered frame sensors');
  let passFrameDigestsVerified = 0;
  const extraPasses = record(run['passFrameDigests'] ?? {});
  const requiredPasses = [...(run['appearance'] ? ['enhanced'] : []), ...(run['controls'] ? ['seg', 'depth'] : [])];
  for (const pass of requiredPasses) {
    if (!extraPasses[pass]) throw new Error(`run.json is missing ${pass} frame digests`);
    for (const sensor of Object.keys(framesPerSensor)) {
      if (!record(extraPasses[pass])[sensor]) throw new Error(`${pass} is missing sensor ${sensor}`);
    }
  }
  for (const [pass, sensors] of Object.entries(extraPasses)) {
    if (!['enhanced', 'depth', 'seg'].includes(pass)) throw new Error(`unknown recorded pass ${pass}`);
    for (const [sensor, digests] of Object.entries(record(sensors))) {
      if (!(sensor in framesPerSensor) || !Array.isArray(digests) || digests.length !== expectedFrames
        || !digests.every((digest) => typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest))) throw new Error(`${pass}/${sensor} frame digest inventory invalid`);
      const directory = path.join(absolute, `frames-${pass}`, sensor);
      const extension = pass === 'depth' ? 'f32' : 'png';
      const files = (await readdir(directory)).filter((name) => name.endsWith(`.${extension}`));
      if (files.length !== expectedFrames) throw new Error(`${pass}/${sensor} contains an unexpected number of frames`);
      for (const [index, expected] of digests.entries()) {
        if (sha256(await readFile(path.join(directory, `${index}.${extension}`))) !== expected) throw new Error(`${pass}/${sensor}/${index} digest mismatch`);
        passFrameDigestsVerified += 1;
      }
    }
  }
  const traceRows = await jsonLines(path.join(absolute, 'trace.jsonl'));
  let chain: string | null = null;
  if ((traceRows[0]?.['reset'] as Record<string, unknown> | undefined)?.['schema'] === EPISODE_TRACE_SCHEMA) {
    chain = verifyEpisodeTrace(traceRows);
    const core = traceRows.at(-1)!['summary'] as Record<string, unknown>;
    if (core['decisions'] !== steps.length) throw new Error('kernel decision count does not match steps');
    if (core['mode'] !== run['mode'] || core['status'] !== result.status) throw new Error('kernel result disagrees with run manifest');
    if (run['appearance']) {
      const appearance = record(run['appearance']);
      for (const row of traceRows.slice(0, -1)) {
        const reset = row['reset'] === undefined ? undefined : record(row['reset']);
        const cameras = record(reset ? record(reset['observation'])['cameras'] : row['cameras']);
        const frames = records(cameras['frames']);
        for (const raw of frames.filter((frame) => frame['pass'] === 'rgb')) {
          const enhanced = frames.find((frame) => frame['pass'] === 'enhanced' && frame['sensorId'] === raw['sensorId']);
          if (!enhanced || enhanced['tick'] !== raw['tick'] || !/^[a-f0-9]{64}$/.test(String(enhanced['sha256']))) throw new Error('trace lacks synchronized enhanced frame identity');
        }
        if (reset) {
          const observation = record(record(reset['options'])['observation']);
          const channels = records(observation['channels']);
          const enhance = record(channels.find((channel) => channel['kind'] === 'cameras')?.['enhance']);
          if (enhance['identity'] !== appearance['identity']) throw new Error('trace enhancement identity disagrees with run.json');
        }
      }
    }
  } else {
    // Existing drive runs keep their insertion-ordered, latency-bearing v1 chain.
    for (const row of traceRows) {
      if (typeof row['step'] !== 'number') continue;
      const { digest: claimed, ...deterministic } = row;
      chain = createHash('sha256').update(chain ?? '').update(JSON.stringify(deterministic)).digest('hex');
      if (claimed !== chain) throw new Error(`trace digest mismatch at step ${row['step']}`);
    }
  }
  const profileName = String(run['cameraProfile'] ?? 'none');
  const profile = getProfile(profileName);
  for (const spec of profile) {
    if (!(spec.sensorId in framesPerSensor)) throw new Error(`policy camera ${spec.sensorId} has no recorded frames`);
  }
  for (const artifact of result.artifacts) {
    const artifactPath = path.join(absolute, artifact.path);
    const bytes = await readFile(artifactPath);
    const metadata = await stat(artifactPath);
    if (metadata.size !== artifact.bytes || sha256(bytes) !== artifact.sha256) throw new Error(`manifest artifact digest mismatch: ${artifact.path}`);
  }
  const rawHealth = result.metrics['modelHealth'];
  if (!rawHealth || typeof rawHealth !== 'object') throw new Error('result is missing modelHealth');
  const health = rawHealth as Record<string, unknown>;
  if (health['decisions'] !== steps.length) throw new Error('modelHealth decision count does not match steps');
  const modelHealth = assessDriveModelHealth(health);
  return { runDir: absolute, runId: result.runId, steps: steps.length, framesPerSensor, expectedFrames, frameDigestsVerified,
    ...(passFrameDigestsVerified ? { passFrameDigestsVerified } : {}), traceDigest: chain, modelHealth, manifestValid: true };
}

export async function verifyDriveRun(runDir: string, pretty = false): Promise<number> {
  const report = await verifyRunDirectory(runDir);
  process.stdout.write(`${JSON.stringify({ ok: true, ...report }, null, pretty ? 2 : 0)}\n`);
  return 0;
}
