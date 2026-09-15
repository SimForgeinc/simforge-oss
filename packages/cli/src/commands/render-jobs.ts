import type { ScenarioRenderJobDto } from '@simforge-oss/studio-host';
import { boolFlag, optionalNumber, optionalString, parseArgs } from '../args.js';
import { CliError, EXIT } from '../errors.js';
import { emit } from '../output.js';
import { downloadTo, extensionFor, hostSession, pollUntil, requireSubcommand, type HostSession } from './local.js';

export const RENDER_JOB_COMMANDS = ['list', 'status', 'wait', 'cancel', 'artifacts'] as const;

const TERMINAL = new Set<ScenarioRenderJobDto['status']>(['succeeded', 'failed', 'cancelled']);

function summary(job: ScenarioRenderJobDto) {
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    revisionId: job.revisionId,
    executionPackageId: job.executionPackageId,
    failureCode: job.failureCode,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

async function listJobs(session: HostSession, scenario?: string) {
  const { items } = await session.host.jobs.listGallery({ documentId: scenario ?? null, limit: 200 });
  return items.map((item) => ({
    id: item.id,
    state: item.jobState,
    progressPercent: item.progressPercent,
    engine: item.rendererEngine,
    revisionId: item.revisionId,
    documentId: item.documentId,
    failureCode: item.failureCode,
    attemptCount: item.attemptCount,
  }));
}

function artifactFileName(item: {
  id: string;
  artifactKind: string;
  identity: { role: string; actorId: string | null; sensorId: string | null; modality: string | null } | null;
  mediaType: string;
}): string {
  const stem = item.identity
    ? [item.identity.role, item.identity.actorId, item.identity.sensorId, item.identity.modality].filter(Boolean).join('-')
    : item.artifactKind;
  return `${stem || item.id}.${extensionFor(item.mediaType)}`;
}

export async function renderJobsCommand(argv: readonly string[]): Promise<number> {
  const sub = requireSubcommand('render', argv[0], RENDER_JOB_COMMANDS);
  const extra = { list: ['scenario'], wait: ['timeout'], artifacts: ['out'] }[sub as string] ?? [];
  const args = parseArgs(argv.slice(1), { booleans: ['pretty'], values: ['data-root', ...extra] });
  const id = args.positionals[0];
  if (sub === 'list') {
    if (args.positionals.length) throw new CliError('bad_value', 'render list takes no positional arguments');
  } else if (!id || args.positionals.length !== 1) {
    throw new CliError('missing_argument', `simforge render ${sub} requires one job id.`);
  }
  const pretty = boolFlag(args, 'pretty');
  const session = await hostSession(optionalString(args, 'data-root'));

  switch (sub) {
    case 'list':
      emit(await listJobs(session, optionalString(args, 'scenario')), { pretty });
      return EXIT.ok;
    case 'status':
      emit(summary(await session.host.jobs.getRenderJob(id!)), { pretty });
      return EXIT.ok;
    case 'cancel': {
      const job = await session.host.jobs.cancelRenderJob(id!);
      emit({ jobId: id, status: job.status, cancelRequestedAt: job.cancelRequestedAt }, { pretty });
      return EXIT.ok;
    }
    case 'wait': {
      const timeout = optionalNumber(args, 'timeout') ?? 3_600;
      const job = await pollUntil(() => session.host.jobs.getRenderJob(id!), (value) => TERMINAL.has(value.status), {
        timeoutSeconds: timeout,
        intervalMs: 5_000,
        onTimeout: (last) => new CliError('render_timeout', `Render ${id} is still ${last.status} after ${timeout}s.`, { detail: summary(last) }),
      });
      emit(summary(job), { pretty });
      if (job.status !== 'succeeded') {
        throw new CliError('render_failed', `Render ${job.id} ${job.status}.`, { detail: { failureCode: job.failureCode, failureDetail: job.failureDetail } });
      }
      return EXIT.ok;
    }
    case 'artifacts': {
      const items = await session.host.jobs.listDownloads(id!);
      const out = optionalString(args, 'out');
      if (!out) {
        emit(items.map((item) => ({
          artifactId: item.id,
          role: item.identity?.role ?? item.artifactKind,
          modality: item.identity?.modality ?? null,
          sensorId: item.identity?.sensorId ?? null,
          actorId: item.identity?.actorId ?? null,
          mediaType: item.mediaType,
          byteLength: item.byteLength,
          sha256: item.sha256,
          state: item.artifactState,
        })), { pretty });
        return EXIT.ok;
      }
      const written = [];
      for (const item of items) {
        if (!item.url) continue;
        const path = await downloadTo(new URL(item.url, session.baseUrl), out, artifactFileName(item), { headers: session.headers });
        written.push({ artifactId: item.id, path, byteLength: item.byteLength });
      }
      emit({ jobId: id, out, artifacts: written }, { pretty });
      return EXIT.ok;
    }
  }
}
