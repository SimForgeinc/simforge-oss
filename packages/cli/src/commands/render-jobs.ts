/**
 * The `simforge render` job group: submit, follow, and fetch a render, against
 * whichever host `SIMFORGE_API_BASE_URL` names.
 *
 * Every verb here is a thin composition over the typed jobs contract
 * (`packages/studio-host/src/protocol/jobs.ts`) — `submitRenderIntent`,
 * `getRenderJob`, `renderJobDetail`, `renderJobDownloads`, `gallery`. Nothing
 * in this file renders, compiles, or mints a URL; `[jobId]/downloads` is the
 * only route that mints artifact URLs and this is only its caller.
 *
 * The same invocation drives the dev host on this machine and a remote
 * SimCloud host: only `SIMFORGE_API_BASE_URL` differs (see
 * `configuredHostTarget` in `local.ts`).
 */

import { SCENARIO_RENDER_JOB_MODES, type ScenarioRenderJobDetailDto, type ScenarioRenderJobDto, type ScenarioRenderJobMode } from '@simforge-oss/studio-host';
import { boolFlag, optionalInt, optionalNumber, optionalString, parseArgs } from '../args.js';
import { CliError, EXIT } from '../errors.js';
import { emit, emitLines, pad } from '../output.js';
import { downloadTo, extensionFor, hostCall, hostSession, pollUntil, requireSubcommand, type HostSession } from './local.js';

import { RENDER_TIMELINE_COMMANDS, RENDER_TIMELINE_HELP, renderTimelineCommand } from './render-timeline.js';

/**
 * Verbs `main.ts` routes to {@link renderJobsCommand}. The render-timeline
 * verbs (`timeline`, `sample`, `parity`) ride this list so they dispatch
 * without touching `main.ts`; `renderJobsCommand` hands them straight on.
 */
const JOB_VERBS = ['list', 'status', 'wait', 'cancel', 'download'] as const;
export const RENDER_JOB_COMMANDS = [...JOB_VERBS, ...RENDER_TIMELINE_COMMANDS] as const;

const TERMINAL: Record<ScenarioRenderJobDto['status'], true | undefined> = { succeeded: true, failed: true, cancelled: true, queued: undefined, leased: undefined, running: undefined };

/**
 * `simforge render --help`.
 *
 * JSON by default like every other result in this CLI (`output.ts`), and a
 * human rendering of the same object under `--pretty`. The environment block
 * is part of the contract, not decoration: it is the only difference between a
 * local dev render and a cloud render.
 */
export const RENDER_GROUP_HELP = {
  group: 'simforge render',
  summary: 'submit render intents and follow render jobs on any Studio host',
  environment: {
    SIMFORGE_API_BASE_URL:
      'base URL of the host that serves /api/simforge/*. Unset, the running local daemon from `simforge daemon` answers. Set, the identical invocation runs against that host, e.g. SIMFORGE_API_BASE_URL=https://dev.simforge.ai for the dev environment. Nothing else about the command changes.',
    SIMFORGE_REMOTE_HOST_TOKEN: 'bearer token for that host (its control token); omitted for a host that needs none.',
    SIMFORGE_REMOTE_HOST_ALLOW_PLAINTEXT:
      '1 acknowledges plain HTTP to a non-loopback address, where the token crosses the network in the clear. https://dev.simforge.ai needs no acknowledgement.',
  },
  examples: [
    'simforge render submit --scenario uscn_e6e24608e08c48faa846f525 --engine carla --seconds 20',
    'SIMFORGE_API_BASE_URL=https://dev.simforge.ai SIMFORGE_REMOTE_HOST_TOKEN=$DEV_TOKEN \\',
    '  simforge render submit --scenario uscn_e6e24608e08c48faa846f525 --engine carla --seconds 20',
    'simforge render wait <jobId> && simforge render download <jobId> --out ./out',
  ],
  commands: [
    {
      name: 'submit',
      summary: 'POST a render intent (jobsProtocol.submitRenderIntent) and print the job id',
      usage: [
        'simforge render submit --scenario <documentId> --engine native|browser|carla --seconds <n>',
        '  [--start 0] [--fps 20] [--resolution 1280x720] [--quality preview|standard|high|cinematic]',
        '  [--sensors actorId:sensorId,...] [--environment noon|dusk|night|dawn|...] [--priority <-100..100>]',
        'simforge render submit --revision <revisionId> --execution-package <id> --engine carla',
        '  --render-spec <render-spec.json> [--idempotency-key <key>] [--priority <-100..100>]',
      ],
      notes: [
        '--scenario freezes the draft the way the Studio wizard does, then submits.',
        '--revision/--execution-package submit an already frozen revision with an authored rig: no freeze, no compile.',
      ],
    },
    { name: 'status', summary: 'state, attempts and progress for one job (getRenderJob + renderJobDetail)', usage: ['simforge render status <jobId>'] },
    { name: 'wait', summary: 'block until a job reaches a terminal state; non-zero exit when it did not succeed', usage: ['simforge render wait <jobId> [--timeout 3600]'] },
    { name: 'cancel', summary: 'request cancellation of a queued or running job', usage: ['simforge render cancel <jobId>'] },
    {
      name: 'download',
      summary: 'the minted artifact URLs for one job (renderJobDownloads), or the bytes with --out',
      usage: ['simforge render download <jobId> [--out <dir>]'],
    },
    {
      name: 'list',
      summary: 'the render gallery, newest first',
      usage: ['simforge render list [--scenario <documentId>] [--revision <revisionId>] [--job-mode <mode>] [--limit 50]'],
      notes: [`--job-mode is one of ${SCENARIO_RENDER_JOB_MODES.join(', ')}.`, 'The gallery pages by --limit; it exposes no cursor.'],
    },
    {
      name: 'run',
      summary: 'execute one immutable render intent locally with the browser, CARLA, or native engine',
      usage: ['simforge render run <render-intent.json> --engine <id> --out <dir> --inputs <inputs.json> [--engine-options <file.json>]'],
      notes: [
        '--engine carla needs the 40-hex source revision its binary was built from: SIMFORGE_SOURCE_REVISION in the environment, or engineVersion in --engine-options. It is not defaulted, because the recorded engine version has to name the binary that actually ran.',
      ],
    },
    { name: 'hash', summary: 'canonical SHA-256 identity of a render intent', usage: ['simforge render hash <render-intent.json>'] },
    ...RENDER_TIMELINE_HELP,
  ],
  output: {
    default: 'JSON on stdout (--json states it explicitly)',
    pretty: '--pretty renders the same object for humans',
  },
} as const;

export function renderGroupUsage(pretty: boolean): number {
  if (!pretty) {
    emit(RENDER_GROUP_HELP, { pretty: false });
    return EXIT.ok;
  }
  emitLines([
    `${RENDER_GROUP_HELP.group} — ${RENDER_GROUP_HELP.summary}`,
    '',
    ...RENDER_GROUP_HELP.commands.flatMap((command) => [
      `  ${pad(command.name, 10)}${command.summary}`,
      ...command.usage.map((line) => `      ${line}`),
      ...('notes' in command ? command.notes.map((note) => `      · ${note}`) : []),
    ]),
    '',
    '  environment',
    ...Object.entries(RENDER_GROUP_HELP.environment).map(([name, description]) => `      ${name}\n        ${description}`),
    '',
    '  examples',
    ...RENDER_GROUP_HELP.examples.map((line) => `      ${line}`),
    '',
    `  output    ${RENDER_GROUP_HELP.output.default}; ${RENDER_GROUP_HELP.output.pretty}`,
    '',
  ]);
  return EXIT.ok;
}

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

/** The worker's last progress record as one line; null when it has published none. */
function stageLine(detail: ScenarioRenderJobDetailDto['progressDetail']): string | null {
  if (!detail) return null;
  switch (detail.event) {
    case 'stage.progress':
      return `${detail.stage} ${detail.completed}/${detail.total} ${detail.unit}`;
    case 'stage.started':
      return `${detail.stage} started`;
    case 'artifact.ready':
      return `artifact ready: ${detail.identity.role} (${detail.sizeBytes} bytes)`;
    case 'warning':
      return `warning ${detail.code}: ${detail.message}`;
    case 'job.canceled':
      return `canceled: ${detail.reason}`;
    case 'job.started':
      return 'started';
  }
}

/** One render attempt as `status` reports it. */
export type RenderAttemptReport = {
  attemptNumber: number;
  state: string;
  status: string;
  workerNodeId: string;
  workerClass: string;
  engine: string | null;
  leasedAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

/** What `simforge render status` prints: the job row joined to its detail row. */
export type RenderJobStatusReport = {
  jobId: string;
  state: ScenarioRenderJobDetailDto['jobState'];
  status: ScenarioRenderJobDto['status'];
  progress: number;
  progressPercent: number | null;
  stage: string | null;
  engine: string | null;
  jobMode: ScenarioRenderJobDetailDto['jobMode'];
  revisionId: string;
  executionPackageId: string;
  intentSha256: string | null;
  attemptCount: number;
  maxAttempts: number;
  attempts: RenderAttemptReport[];
  artifactCount: number;
  failureCode: string | null;
  failureDetail: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  host: { baseUrl: string; source: HostSession['source'] };
};

/**
 * `status`: the job row *and* its detail row, because they answer different
 * halves of the question — `getRenderJob` carries the submitted intent's
 * progress, `renderJobDetail` carries the attempt history and the worker's
 * last published stage.
 */
async function jobStatus(session: HostSession, jobId: string): Promise<RenderJobStatusReport> {
  const [job, detail] = await Promise.all([
    hostCall('getRenderJob', () => session.host.jobs.getRenderJob(jobId)),
    hostCall('renderJobDetail', () => session.host.jobs.getRenderJobDetail(jobId)),
  ]);
  return {
    jobId: job.id,
    state: detail.jobState,
    status: job.status,
    progress: job.progress,
    progressPercent: detail.progressPercent,
    stage: stageLine(detail.progressDetail),
    engine: detail.rendererEngine,
    jobMode: detail.jobMode,
    revisionId: job.revisionId,
    executionPackageId: job.executionPackageId,
    intentSha256: detail.intentSha256,
    attemptCount: detail.attemptCount,
    maxAttempts: detail.maxAttempts,
    attempts: detail.attempts.map((attempt) => ({
      attemptNumber: attempt.attemptNumber,
      state: attempt.attemptState,
      status: attempt.status,
      workerNodeId: attempt.workerNodeId,
      workerClass: attempt.workerClass,
      engine: attempt.rendererEngine,
      leasedAt: attempt.leasedAt,
      startedAt: attempt.startedAt,
      completedAt: attempt.completedAt,
    })),
    artifactCount: detail.artifacts.length,
    failureCode: detail.failureCode,
    failureDetail: detail.failureDetail,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: detail.completedAt,
    host: { baseUrl: session.baseUrl, source: session.source },
  };
}

function statusLines(status: RenderJobStatusReport): string[] {
  return [
    `Render job ${status.jobId}`,
    `  ${pad('state', 12)}${status.state}${status.progressPercent === null ? '' : `  (${status.progressPercent}%)`}`,
    `  ${pad('attempts', 12)}${status.attemptCount} of ${status.maxAttempts}`,
    `  ${pad('engine', 12)}${status.engine ?? '—'}  (${status.jobMode})`,
    `  ${pad('revision', 12)}${status.revisionId}`,
    `  ${pad('package', 12)}${status.executionPackageId}`,
    `  ${pad('stage', 12)}${status.stage ?? '—'}`,
    `  ${pad('artifacts', 12)}${status.artifactCount}`,
    ...(status.failureCode ? [`  ${pad('failure', 12)}${status.failureCode}`] : []),
    ...status.attempts.map(
      (attempt) => `  attempt ${attempt.attemptNumber}: ${attempt.state} on ${attempt.workerNodeId} (${attempt.workerClass}) leased ${attempt.leasedAt}`,
    ),
    `  ${pad('host', 12)}${status.host.baseUrl} (${status.host.source})`,
  ];
}

async function listJobs(session: HostSession, query: { documentId?: string; revisionId?: string; jobMode?: ScenarioRenderJobMode; limit?: number }) {
  const page = await hostCall('gallery', () =>
    session.host.jobs.listGallery({
      documentId: query.documentId ?? null,
      revisionId: query.revisionId ?? null,
      jobMode: query.jobMode ?? null,
      limit: query.limit ?? 50,
    }),
  );
  return {
    hiddenCount: page.hiddenCount,
    items: page.items.map((item) => ({
      id: item.id,
      state: item.jobState,
      progressPercent: item.progressPercent,
      engine: item.rendererEngine,
      jobMode: item.jobMode,
      revisionId: item.revisionId,
      documentId: item.documentId,
      failureCode: item.failureCode,
      attemptCount: item.attemptCount,
      artifactCount: item.artifactCount,
      createdAt: item.createdAt,
      completedAt: item.completedAt,
    })),
  };
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

function jobModeFlag(value: string | undefined): ScenarioRenderJobMode | undefined {
  if (value === undefined) return undefined;
  const mode = SCENARIO_RENDER_JOB_MODES.find((candidate) => candidate === value);
  if (!mode) {
    throw new CliError('bad_value', `--job-mode must be one of ${SCENARIO_RENDER_JOB_MODES.join(', ')}`, { path: '--job-mode' });
  }
  return mode;
}

export async function renderJobsCommand(argv: readonly string[]): Promise<number> {
  if ((RENDER_TIMELINE_COMMANDS as readonly string[]).includes(argv[0] ?? '')) return renderTimelineCommand(argv);
  const sub = requireSubcommand('render', argv[0], JOB_VERBS);
  const extra = { list: ['scenario', 'revision', 'job-mode', 'limit'], wait: ['timeout'], download: ['out'] }[sub as string] ?? [];
  const args = parseArgs(argv.slice(1), { booleans: ['pretty', 'json'], values: ['data-root', ...extra] });
  const id = args.positionals[0];
  if (sub === 'list') {
    if (args.positionals.length) throw new CliError('bad_value', 'render list takes no positional arguments');
  } else if (!id || args.positionals.length !== 1) {
    throw new CliError('missing_argument', `simforge render ${sub} requires one job id.`);
  }
  const pretty = boolFlag(args, 'pretty') && !boolFlag(args, 'json');
  const session = await hostSession(optionalString(args, 'data-root'));

  switch (sub) {
    case 'list': {
      const limit = optionalInt(args, 'limit');
      if (limit !== undefined && limit <= 0) throw new CliError('bad_value', '--limit must be a positive integer', { path: '--limit' });
      const page = await listJobs(session, {
        documentId: optionalString(args, 'scenario'),
        revisionId: optionalString(args, 'revision'),
        jobMode: jobModeFlag(optionalString(args, 'job-mode')),
        limit,
      });
      if (pretty) {
        emitLines([
          ...page.items.map(
            (item) =>
              `${pad(item.id, 30)}${pad(item.state, 11)}${pad(item.engine ?? '—', 9)}${pad(item.progressPercent === null ? '—' : `${item.progressPercent}%`, 6)}${pad(String(item.artifactCount), 4)}${item.documentId ?? item.revisionId}`,
          ),
          `${page.items.length} job(s), ${page.hiddenCount} hidden — ${session.baseUrl}`,
        ]);
      } else {
        emit(page, { pretty });
      }
      return EXIT.ok;
    }
    case 'status': {
      const status = await jobStatus(session, id!);
      if (pretty) emitLines(statusLines(status));
      else emit(status, { pretty });
      return EXIT.ok;
    }
    case 'cancel': {
      const job = await hostCall('cancelRenderJob', () => session.host.jobs.cancelRenderJob(id!));
      emit({ jobId: id, status: job.status, cancelRequestedAt: job.cancelRequestedAt }, { pretty });
      return EXIT.ok;
    }
    case 'wait': {
      const timeout = optionalNumber(args, 'timeout') ?? 3_600;
      const job = await pollUntil(() => hostCall('getRenderJob', () => session.host.jobs.getRenderJob(id!)), (value) => TERMINAL[value.status] === true, {
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
    case 'download': {
      const items = await hostCall('renderJobDownloads', () => session.host.jobs.listDownloads(id!));
      const out = optionalString(args, 'out');
      const artifacts = items.map((item) => ({
        artifactId: item.id,
        role: item.identity?.role ?? item.artifactKind,
        modality: item.identity?.modality ?? null,
        sensorId: item.identity?.sensorId ?? null,
        actorId: item.identity?.actorId ?? null,
        artifactKind: item.artifactKind,
        mediaType: item.mediaType,
        byteLength: item.byteLength,
        sha256: item.sha256,
        state: item.artifactState,
        url: item.url,
        expiresInSeconds: item.url === null ? null : item.expiresInSeconds,
      }));
      if (!out) {
        if (pretty) {
          emitLines([
            ...artifacts.map((artifact) => `${pad(artifact.role, 24)}${pad(String(artifact.byteLength), 12)}${artifact.url ?? '(no url — ' + artifact.state + ')'}`),
            `${artifacts.length} artifact(s) for ${id} — ${session.baseUrl}`,
          ]);
        } else {
          emit({ jobId: id, artifacts }, { pretty });
        }
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
