import { createHash } from 'node:crypto';
import { catalogEntry, MODEL_CATALOG, MODEL_FAMILIES, MODEL_QUANTS_BY_FAMILY, type ModelFamilyId, type ModelQuant } from '@simforge-oss/model-store/catalog';
import { ALPAMAYO_CAMERA_INDEX } from '@simforge-oss/scenario';
import {
  buildOpenLoopParams,
  createHttpEvaluationGateway,
  DESKTOP_COMPUTE_PROXY_PATH,
  type ComputeJob,
  type ComputeJobSubmission,
  type EvaluationGateway,
  type UploadedVideoCamera,
} from '@simforge-oss/evaluation/client';
import { boolFlag, optionalNumber, optionalString, parseArgs } from '../args.js';
import { CliError, EXIT } from '../errors.js';
import { hostRequest } from '../host-client.js';
import { emit } from '../output.js';
import { downloadTo, extensionFor, hostSession, pollUntil, requireSubcommand, type HostSession } from './local.js';

export const CLOUD_EVAL_COMMANDS = ['capabilities', 'submit', 'list', 'status', 'wait', 'artifacts'] as const;

const TERMINAL = new Set<ComputeJob['status']>(['succeeded', 'partial', 'failed', 'cancelled']);
/** The launcher's order of preference for which uploaded view is the primary one. */
const PRIMARY_PREFERENCE = [1, 0, 2, 6, 3, 5, 4] as const;
const WORKSPACE_HEADER = 'X-SimForge-Workspace-Id';

/** Families whose camera contract accepts whatever uploaded views it is given. */
const VIDEO_FAMILIES = MODEL_FAMILIES.filter((family) => {
  const cameras = MODEL_CATALOG[family].cameras;
  return cameras.required === null || cameras.variable;
});

type CloudSession = HostSession & { gateway: EvaluationGateway; workspaceHeaders: Record<string, string> };

/**
 * The compute proxy resolves the workspace from the session's active
 * organisation; `--workspace` is only an explicit override for accounts that
 * belong to several.
 */
async function cloudSession(dataRoot: string | undefined, workspace: string | undefined): Promise<CloudSession> {
  const session = await hostSession(dataRoot);
  const status = await hostRequest<{ state: string }>('/api/simforge/cloud/status', { dataRoot });
  if (status.state !== 'connected') {
    throw new CliError('cloud_disconnected', 'The local host has no SimCloud session. Run `simforge cloud connect` first.', { detail: status });
  }
  const workspaceHeaders: Record<string, string> = workspace ? { [WORKSPACE_HEADER]: workspace } : {};
  const gateway = createHttpEvaluationGateway({
    baseUrl: session.baseUrl,
    basePath: DESKTOP_COMPUTE_PROXY_PATH,
    workspaceId: workspace ?? null,
    headers: session.headers,
  });
  return { ...session, gateway, workspaceHeaders };
}

function jobSummary(job: ComputeJob) {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    model: job.model,
    inputs: job.inputs,
    scored: job.scored,
    error: job.error,
    estimateCents: job.estimateCents,
    settledCents: job.settledCents,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    result: job.result ? { status: job.result.status, metrics: job.result.metrics, artifacts: job.result.artifacts.length } : null,
  };
}

/** Upload one local artifact's bytes into the workspace; dedup by digest is the server's call. */
async function uploadVideo(session: CloudSession, url: string, label: string) {
  const response = await fetch(new URL(url, session.baseUrl), { headers: session.headers, redirect: 'error' });
  if (!response.ok) throw new CliError('artifact_download_failed', `Download of ${label} failed (${response.status}).`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const reservation = await session.gateway.reserveUpload({ purpose: 'video', mediaType: 'video/mp4', sha256, sizeBytes: bytes.byteLength, filename: `${label}.mp4` });
  if (!reservation.uploadRequired) return { artifactId: reservation.artifactId, sha256, bytes: bytes.byteLength, deduplicated: true };
  const grant = reservation.grant;
  if (!grant) throw new CliError('grant_missing', 'The upload reservation requires a transfer but carried no storage grant.');
  let parts: { partNumber: number; etag: string }[] | undefined;
  if (grant.mode === 'put') {
    const put = await fetch(grant.url, { method: 'PUT', headers: grant.headers, body: bytes });
    if (!put.ok) throw new CliError('upload_failed', `Storage refused ${label} (${put.status}).`);
  } else {
    parts = [];
    for (const part of grant.parts) {
      const start = (part.partNumber - 1) * grant.partSizeBytes;
      if (start >= bytes.byteLength) break;
      const put = await fetch(part.url, { method: 'PUT', body: bytes.subarray(start, Math.min(start + grant.partSizeBytes, bytes.byteLength)) });
      const etag = put.headers.get('etag');
      if (!put.ok || !etag) throw new CliError('upload_failed', `Storage refused part ${part.partNumber} of ${label} (${put.status}).`);
      parts.push({ partNumber: part.partNumber, etag: etag.replace(/"/g, '') });
    }
  }
  const completion = await session.gateway.completeUpload(reservation.uploadId, parts ? { parts } : undefined);
  return { artifactId: completion.artifactId, sha256, bytes: bytes.byteLength, deduplicated: false };
}

type SubmitOptions = {
  job: string;
  family: ModelFamilyId;
  quant: ModelQuant;
  seed: number;
  egoSpeedMps: number;
  cameraHeightM: number;
  horizontalFovDeg: number;
  predictionHz: number;
  numTrajSamples: number;
  dryRun: boolean;
};

/**
 * Turn a finished local render into an open-loop evaluation, the way the
 * launcher submits uploaded footage: each rendered camera video becomes a
 * `video` input at its Alpamayo camera slot, explicitly exploratory and
 * unscored (`reference: none`).
 */
async function submitRender(session: CloudSession, options: SubmitOptions, pretty: boolean): Promise<number> {
  const entry = MODEL_CATALOG[options.family];
  const renderJob = await session.host.jobs.getRenderJob(options.job);
  if (renderJob.status !== 'succeeded') throw new CliError('render_not_finished', `Render ${renderJob.id} is ${renderJob.status}; only a succeeded render can be evaluated.`);
  const videos = (await session.host.jobs.listDownloads(renderJob.id)).filter((item) => item.identity?.role === 'video' && item.identity.modality === 'rgb' && item.url);

  const slotTable: Readonly<Record<string, number>> = ALPAMAYO_CAMERA_INDEX;
  const mapped: { sensorId: string; slot: number; artifact: (typeof videos)[number] }[] = [];
  const unmapped: string[] = [];
  for (const artifact of videos) {
    const sensorId = artifact.identity?.sensorId ?? artifact.id;
    const slot = slotTable[sensorId];
    if (slot === undefined) unmapped.push(sensorId);
    else mapped.push({ sensorId, slot, artifact });
  }
  mapped.sort((a, b) => a.slot - b.slot);
  const rendered = mapped.map((camera) => camera.slot);
  const required = entry.cameras.required;
  const missing = required ? required.filter((slot) => !rendered.includes(slot)) : [];
  if (rendered.length === 0 || missing.length > 0) {
    throw new CliError('rig_incompatible', required
      ? `${entry.displayName} requires camera slots ${required.join(', ')} and this render has ${rendered.length > 0 ? rendered.join(', ') : 'none of them'}. Fit the matching Alpamayo rig preset and render again.`
      : `None of this render's cameras map to a model camera slot. Fit an Alpamayo rig preset and render again.`, {
      detail: { family: options.family, requiredSlots: required, renderedSlots: rendered, missingSlots: missing, unmappedSensorIds: unmapped, slotTable },
    });
  }

  const primaryCameraId = PRIMARY_PREFERENCE.find((slot) => rendered.includes(slot)) ?? rendered[0]!;
  const { egoSpeedMps, horizontalFovDeg, cameraHeightM } = options;
  const cameras: UploadedVideoCamera[] = mapped.map((camera, inputIndex) => ({ cameraId: camera.slot, inputIndex, offsetSeconds: 0 }));
  const params = buildOpenLoopParams({
    items: mapped.map(() => ({ kind: 'user-clip', role: 'video', cameraProfile: 'uploaded-video' })),
    reference: 'none',
    sampling: { numTrajSamples: options.numTrajSamples },
    task: 'act',
    seed: options.seed,
    ood: { exploratory: true, assumedStationaryEgo: egoSpeedMps === 0, assumedIntrinsics: { model: 'pinhole', horizontalFovDeg, cameraHeightM } },
    video: { cameras, primaryCameraId, horizontalFovDeg, cameraHeightM, egoSpeedMps, predictionHz: options.predictionHz },
  });
  const model = { family: options.family, revision: entry.weightsRevision, quant: options.quant };
  const plan = {
    renderJobId: renderJob.id,
    revisionId: renderJob.revisionId,
    model,
    cameras: mapped.map((camera) => ({ slot: camera.slot, sensorId: camera.sensorId, artifactId: camera.artifact.id, bytes: camera.artifact.byteLength })),
    ignoredSensorIds: unmapped,
    primaryCameraId,
    params,
  };
  if (options.dryRun) {
    emit({ dryRun: true, ...plan }, { pretty });
    return EXIT.ok;
  }
  const uploads = [];
  for (const camera of mapped) uploads.push(await uploadVideo(session, camera.artifact.url!, `${renderJob.id}-${camera.sensorId}`));
  const submission: ComputeJobSubmission = {
    kind: 'alpamayo.openloop',
    // Stable per render+model so a retried command replays the job instead of paying twice.
    idempotencyKey: `render:${renderJob.id}:${model.family}:${model.quant}`,
    input: { model, inputs: uploads.map((upload) => ({ role: 'video' as const, artifactId: upload.artifactId })), params },
  };
  const estimate = await session.gateway.estimate({ kind: submission.kind, input: submission.input });
  const job = await session.gateway.submitJob(submission);
  emit({ ...jobSummary(job), estimate, uploads, ...plan }, { pretty });
  return EXIT.ok;
}

export async function cloudEvalCommand(argv: readonly string[]): Promise<number> {
  const sub = requireSubcommand('cloud eval', argv[0], CLOUD_EVAL_COMMANDS);
  const common = ['data-root', 'workspace'];
  switch (sub) {
    case 'capabilities': {
      const args = parseArgs(argv.slice(1), { booleans: ['pretty'], values: common });
      const session = await cloudSession(optionalString(args, 'data-root'), optionalString(args, 'workspace'));
      emit(await hostRequest(`${DESKTOP_COMPUTE_PROXY_PATH}/capabilities`, { dataRoot: optionalString(args, 'data-root'), headers: session.workspaceHeaders }), { pretty: boolFlag(args, 'pretty') });
      return EXIT.ok;
    }
    case 'submit': {
      const args = parseArgs(argv.slice(1), {
        booleans: ['pretty', 'dry-run'],
        values: [...common, 'job', 'family', 'quant', 'seed', 'ego-speed', 'camera-height', 'fov', 'prediction-hz', 'samples'],
      });
      const job = optionalString(args, 'job');
      if (!job) throw new CliError('missing_argument', '--job <renderJobId> is required.', { path: '--job' });
      const familyArg = optionalString(args, 'family');
      if (!familyArg) throw new CliError('missing_argument', `--family is required (${VIDEO_FAMILIES.join(', ')}).`, { path: '--family' });
      const entry = catalogEntry(familyArg);
      if (!entry || !(VIDEO_FAMILIES as readonly string[]).includes(familyArg)) {
        throw new CliError('bad_value', `${familyArg} cannot evaluate uploaded camera video.`, { path: '--family', detail: { known: VIDEO_FAMILIES } });
      }
      const family = familyArg as ModelFamilyId;
      const quant = (optionalString(args, 'quant') ?? 'bf16') as ModelQuant;
      if (!MODEL_QUANTS_BY_FAMILY[family].includes(quant)) {
        throw new CliError('bad_value', `${family} does not ship ${quant}.`, { path: '--quant', detail: { known: MODEL_QUANTS_BY_FAMILY[family] } });
      }
      const num = (name: string, fallback: number, min: number) => {
        const value = optionalNumber(args, name) ?? fallback;
        if (!Number.isFinite(value) || value < min) throw new CliError('bad_value', `--${name} must be a number >= ${min}`, { path: `--${name}` });
        return value;
      };
      const options: SubmitOptions = {
        job,
        family,
        quant,
        seed: num('seed', 1, 0),
        egoSpeedMps: num('ego-speed', 0, 0),
        cameraHeightM: num('camera-height', 1.5, 0),
        horizontalFovDeg: num('fov', 90, 1),
        predictionHz: num('prediction-hz', 1, 0.1),
        numTrajSamples: num('samples', 4, 1),
        dryRun: boolFlag(args, 'dry-run'),
      };
      const session = await cloudSession(optionalString(args, 'data-root'), optionalString(args, 'workspace'));
      return submitRender(session, options, boolFlag(args, 'pretty'));
    }
    case 'list': {
      const args = parseArgs(argv.slice(1), { booleans: ['pretty'], values: common });
      const session = await cloudSession(optionalString(args, 'data-root'), optionalString(args, 'workspace'));
      const page = await session.gateway.listJobs({ kind: 'alpamayo.openloop', limit: 100 });
      emit(page.jobs.map(jobSummary), { pretty: boolFlag(args, 'pretty') });
      return EXIT.ok;
    }
    case 'status': {
      const args = parseArgs(argv.slice(1), { booleans: ['pretty'], values: common });
      const jobId = args.positionals[0];
      if (!jobId) throw new CliError('missing_argument', '`simforge cloud eval status` requires an evaluation job id.');
      const session = await cloudSession(optionalString(args, 'data-root'), optionalString(args, 'workspace'));
      emit(jobSummary(await session.gateway.getJob(jobId)), { pretty: boolFlag(args, 'pretty') });
      return EXIT.ok;
    }
    case 'wait': {
      const args = parseArgs(argv.slice(1), { booleans: ['pretty'], values: [...common, 'timeout'] });
      const jobId = args.positionals[0];
      if (!jobId) throw new CliError('missing_argument', '`simforge cloud eval wait` requires an evaluation job id.');
      const timeoutSeconds = optionalNumber(args, 'timeout') ?? 1_800;
      const session = await cloudSession(optionalString(args, 'data-root'), optionalString(args, 'workspace'));
      const job = await pollUntil(() => session.gateway.getJob(jobId), (value) => TERMINAL.has(value.status), {
        timeoutSeconds,
        intervalMs: 10_000,
        onTimeout: (last) => new CliError('eval_timeout', `Evaluation ${jobId} is still ${last.status} after ${timeoutSeconds}s.`, { detail: jobSummary(last) }),
      });
      emit(jobSummary(job), { pretty: boolFlag(args, 'pretty') });
      if (job.status !== 'succeeded') throw new CliError('eval_failed', `Evaluation ${job.id} ${job.status}.`, { detail: { error: job.error } });
      return EXIT.ok;
    }
    case 'artifacts': {
      const args = parseArgs(argv.slice(1), { booleans: ['pretty'], values: [...common, 'out'] });
      const jobId = args.positionals[0];
      if (!jobId) throw new CliError('missing_argument', '`simforge cloud eval artifacts` requires an evaluation job id.');
      const out = optionalString(args, 'out');
      const pretty = boolFlag(args, 'pretty');
      const session = await cloudSession(optionalString(args, 'data-root'), optionalString(args, 'workspace'));
      const job = await session.gateway.getJob(jobId);
      if (!job.result) throw new CliError('result_not_available', `Evaluation ${jobId} is ${job.status}; no result manifest yet.`);
      const artifacts = job.result.artifacts;
      if (!out) {
        emit({ status: job.result.status, scored: job.result.scored, metrics: job.result.metrics, artifacts }, { pretty });
        return EXIT.ok;
      }
      // The job summary widens roles to the control plane's vocabulary; the
      // result manifest names each artifact precisely. Join on digest.
      const manifest = await session.gateway.getJobResult(jobId);
      const named = new Map(manifest.artifacts.map((entry) => [entry.sha256, entry]));
      const written = [];
      for (const artifact of artifacts) {
        const grant = await session.gateway.artifactDownloadGrant(jobId, artifact.artifactId);
        const entry = named.get(artifact.sha256);
        const role = entry?.role ?? artifact.role;
        const path = await downloadTo(grant.url, out, entry?.path ?? `${role}-${artifact.sha256.slice(0, 8)}.${extensionFor(artifact.mediaType)}`);
        written.push({ artifactId: artifact.artifactId, role, path, bytes: artifact.bytes });
      }
      emit({ jobId, out, metrics: job.result.metrics, artifacts: written }, { pretty });
      return EXIT.ok;
    }
  }
}
