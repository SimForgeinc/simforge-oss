import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { EnvironmentSchema, type Environment } from '@simforge-oss/scenario';
import {
  authoredRenderSensors,
  backendModalities,
  buildCanonicalRenderSpec,
  defaultModalities,
  type SensorModalitySelection,
} from '@simforge-oss/scenario';
import { CliError, EXIT } from '../errors.js';
import { emit } from '../output.js';
import { hostCall, hostSession, type HostSession } from './local.js';
import { freezeScenario } from './scenario.js';
import { boolFlag, optionalInt, optionalNumber, optionalString, parseArgs } from '../args.js';

export type RenderEngine = 'native' | 'browser' | 'carla';
export type RenderQuality = 'preview' | 'standard' | 'high' | 'cinematic';

export type RenderSubmitOptions = {
  dataRoot?: string;
  pretty: boolean;
  scenario: string;
  engine: RenderEngine;
  startSeconds: number;
  endSeconds: number;
  fps: number;
  width: number;
  height: number;
  quality: RenderQuality;
  /** `actorId:sensorId` keys; every enabled authored sensor when empty. */
  sensors: readonly string[];
  timeOfDay?: Environment['timeOfDay'];
  timeout?: number;
  /** Ledger priority, -100..100; the host's default when omitted. */
  priority?: number;
};


/**
 * The same render intent the Studio wizard submits, from the command line:
 * freeze the draft, build the canonical render spec, submit it to the host's
 * render queue. Output is the job id; poll it with `simforge render status <jobId>`.
 */
export async function renderSubmit(options: RenderSubmitOptions): Promise<number> {
  const session = await hostSession(options.dataRoot);
  const document = await hostCall('getDocument', () => session.host.projects.getDocument(options.scenario));
  const content = document.content;

  const authored = authoredRenderSensors(content);
  const wanted = new Set(options.sensors);
  const selections: SensorModalitySelection[] = authored
    .filter((option) => wanted.size === 0 || wanted.has(`${option.actorId}:${option.sensor.id}`))
    .map((option) => ({
      actorId: option.actorId,
      sensorId: option.sensor.id,
      modalities: defaultModalities(option.sensor).filter((modality) => backendModalities(options.engine, option.sensor).includes(modality)),
    }))
    .filter((selection) => selection.modalities.length > 0);
  if (selections.length === 0) {
    throw new CliError('no_sensors', 'No enabled authored sensor renders on this engine.', {
      detail: { engine: options.engine, authored: authored.map((option) => `${option.actorId}:${option.sensor.id}`) },
    });
  }
  const missing = [...wanted].filter((key) => !authored.some((option) => `${option.actorId}:${option.sensor.id}` === key));
  if (missing.length > 0) throw new CliError('bad_value', `Unknown sensors: ${missing.join(', ')}`, { path: '--sensors' });

  const browser = options.engine === 'browser';
  const authoredEnvironment = content.environment ?? EnvironmentSchema.parse({});
  const renderSpec = buildCanonicalRenderSpec({
    content,
    selections,
    clip: { startSeconds: options.startSeconds, endSeconds: options.endSeconds },
    video: {
          width: options.width,
          height: options.height,
          fps: options.fps,
          container: browser ? 'webm' : 'mp4',
          codec: browser ? 'vp9' : 'h264',
          quality: options.quality === 'preview' ? 'draft' : options.quality === 'cinematic' ? 'high' : options.quality,
        },
    artifacts: ['video', 'trace', 'manifest'],
    staticSemantics: false,
    // CARLA renders are review-grade evidence; the other engines produce dataset-grade output.
    fidelity: options.engine === 'carla' ? 'review' : 'dataset',
    environment: options.timeOfDay ? { ...authoredEnvironment, timeOfDay: options.timeOfDay } : authoredEnvironment,
  });

  const frozen = await freezeScenario(session, document, options.timeout);
  const job = await hostCall('submitRenderIntent', () =>
    session.host.jobs.submitRenderIntent({
      schema: 'uniscenario.render-intent-submission/v1',
      engine: options.engine,
      revisionId: frozen.revisionId,
      executionPackageId: frozen.executionPackageId,
      renderSpec,
      idempotencyKey: `render-intent:${frozen.revisionId}:${options.engine}:${createHash('sha256').update(JSON.stringify(renderSpec)).digest('hex').slice(0, 16)}`,
      ...(options.priority === undefined ? {} : { priority: options.priority }),
    }),
  );
  emit({ jobId: job.id, status: job.status, revisionId: frozen.revisionId, executionPackageId: frozen.executionPackageId, reusedRevision: frozen.reused, host: { baseUrl: session.baseUrl, source: session.source } }, { pretty: options.pretty });
  return EXIT.ok;
}

export type RenderSubmitFrozenOptions = {
  dataRoot?: string;
  pretty: boolean;
  engine: RenderEngine;
  revisionId: string;
  executionPackageId: string;
  /** A `render-spec/v3` document: the sensor rig, clip and video settings. */
  renderSpecPath: string;
  idempotencyKey?: string;
  priority?: number;
};

/**
 * Submit an already frozen revision, with an authored rig, exactly as the wire
 * contract spells it: `POST /api/simforge/render-jobs` with a
 * `ScenarioRenderIntentSubmission`. No freeze, no compile, no scenario read —
 * the identity is the revision and its execution package, which is what the
 * host queues on.
 *
 * The render spec is passed through byte-for-byte; this command owns no
 * rendering logic and does not second-guess the host's render-wire schema, so
 * a rig the host refuses comes back as the host's own error.
 */
export async function renderSubmitFrozen(options: RenderSubmitFrozenOptions): Promise<number> {
  const session = await hostSession(options.dataRoot);
  const raw = await readFile(options.renderSpecPath, 'utf8').catch((error: unknown) => {
    throw new CliError('bad_value', `--render-spec could not be read: ${error instanceof Error ? error.message : String(error)}`, { path: '--render-spec' });
  });
  let renderSpec: unknown;
  try {
    renderSpec = JSON.parse(raw);
  } catch (error) {
    throw new CliError('bad_value', `--render-spec is not JSON: ${error instanceof Error ? error.message : String(error)}`, { path: '--render-spec' });
  }
  const job = await hostCall('submitRenderIntent', () =>
    session.host.jobs.submitRenderIntent({
      schema: 'uniscenario.render-intent-submission/v1',
      engine: options.engine,
      revisionId: options.revisionId,
      executionPackageId: options.executionPackageId,
      renderSpec,
      idempotencyKey:
        options.idempotencyKey
        ?? `render-intent:${options.revisionId}:${options.engine}:${createHash('sha256').update(JSON.stringify(renderSpec)).digest('hex').slice(0, 16)}`,
      ...(options.priority === undefined ? {} : { priority: options.priority }),
    }),
  );
  emit(
    {
      jobId: job.id,
      status: job.status,
      revisionId: job.revisionId,
      executionPackageId: job.executionPackageId,
      host: { baseUrl: session.baseUrl, source: session.source },
    },
    { pretty: options.pretty },
  );
  return EXIT.ok;
}

type TimeOfDay = Environment['timeOfDay'];
const TIME_OF_DAY: readonly TimeOfDay[] = ['morning', 'noon', 'afternoon', 'dusk', 'night', 'dawn', 'night_lit'];

export async function renderSubmitCommand(argv: readonly string[]): Promise<number> {
        const args = parseArgs(argv, {
          booleans: ['pretty', 'json'],
          values: [
            'data-root', 'scenario', 'engine', 'seconds', 'start', 'fps', 'resolution', 'quality', 'sensors', 'environment', 'timeout',
            'revision', 'execution-package', 'render-spec', 'idempotency-key', 'priority',
          ],
        });
        const engine = optionalString(args, 'engine') ?? 'native';
        if (!['native', 'browser', 'carla'].includes(engine)) throw new CliError('bad_value', '--engine must be native, browser, or carla', { path: '--engine' });
        const pretty = boolFlag(args, 'pretty') && !boolFlag(args, 'json');
        const priority = optionalInt(args, 'priority');
        if (priority !== undefined && (priority < -100 || priority > 100)) throw new CliError('bad_value', '--priority must be between -100 and 100', { path: '--priority' });
        const revision = optionalString(args, 'revision');
        const scenario = optionalString(args, 'scenario');
        if (revision !== undefined) {
          // The submission's own identity: a frozen revision and its execution
          // package. Nothing about a document is needed, or read.
          if (scenario !== undefined) throw new CliError('bad_value', '--revision and --scenario are two ways of naming the same submission; pass one', { path: '--revision' });
          const executionPackageId = optionalString(args, 'execution-package');
          if (!executionPackageId) throw new CliError('missing_argument', '--execution-package <id> is required with --revision', { path: '--execution-package' });
          const renderSpecPath = optionalString(args, 'render-spec');
          if (!renderSpecPath) {
            throw new CliError('missing_argument', '--render-spec <render-spec.json> is required with --revision: the host\'s render-wire schema requires the rig on every submission', { path: '--render-spec' });
          }
          return renderSubmitFrozen({
            dataRoot: optionalString(args, 'data-root'),
            pretty,
            engine: engine as RenderEngine,
            revisionId: revision,
            executionPackageId,
            renderSpecPath,
            idempotencyKey: optionalString(args, 'idempotency-key'),
            priority,
          });
        }
        const quality = optionalString(args, 'quality') ?? 'standard';
        if (!['preview', 'standard', 'high', 'cinematic'].includes(quality)) throw new CliError('bad_value', '--quality must be preview, standard, high, or cinematic', { path: '--quality' });
        const timeOfDay = optionalString(args, 'environment');
        if (timeOfDay !== undefined && !TIME_OF_DAY.includes(timeOfDay as TimeOfDay)) throw new CliError('bad_value', `--environment must be one of ${TIME_OF_DAY.join(', ')}`, { path: '--environment' });
        const resolution = /^(\d+)x(\d+)$/.exec(optionalString(args, 'resolution') ?? '1280x720');
        if (!resolution) throw new CliError('bad_value', '--resolution must be WxH', { path: '--resolution' });
        const start = optionalNumber(args, 'start') ?? 0;
        const seconds = optionalNumber(args, 'seconds');
        if (seconds === undefined || seconds <= 0) throw new CliError('missing_argument', '--seconds <clip length> is required', { path: '--seconds' });
        if (!scenario) throw new CliError('missing_argument', '--scenario <documentId> (or --revision <revisionId>) is required', { path: '--scenario' });
        const fps = optionalNumber(args, 'fps') ?? 20;
        const timeout = optionalNumber(args, 'timeout');
        if (start < 0 || !Number.isFinite(start + seconds)) throw new CliError('bad_value', '--start must be non-negative and the clip end finite');
        if (!Number.isInteger(fps) || fps <= 0 || Number(resolution[1]) <= 0 || Number(resolution[2]) <= 0) throw new CliError('bad_value', 'FPS and resolution dimensions must be positive integers');
        if (timeout !== undefined && timeout <= 0) throw new CliError('bad_value', '--timeout must be positive');
        return renderSubmit({
          dataRoot: optionalString(args, 'data-root'),
          pretty,
          scenario,
          engine: engine as RenderEngine,
          startSeconds: start,
          endSeconds: start + seconds,
          fps,
          width: Number(resolution[1]),
          height: Number(resolution[2]),
          quality: quality as RenderQuality,
          sensors: (optionalString(args, 'sensors') ?? '').split(',').map((value) => value.trim()).filter(Boolean),
          ...(timeOfDay === undefined ? {} : { timeOfDay: timeOfDay as TimeOfDay }),
          timeout,
          priority,
        });
}

