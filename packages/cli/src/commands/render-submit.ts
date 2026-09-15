import { createHash } from 'node:crypto';
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
import { hostSession, type HostSession } from './local.js';
import { freezeScenario } from './scenario.js';
import { boolFlag, optionalNumber, optionalString, parseArgs } from '../args.js';

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
};


/**
 * The same render intent the Studio wizard submits, from the command line:
 * freeze the draft, build the canonical render spec, submit it to the host's
 * render queue. Output is the job id; poll it with `simforge render status <jobId>`.
 */
export async function renderSubmit(options: RenderSubmitOptions): Promise<number> {
  const session = await hostSession(options.dataRoot);
  const document = await session.host.projects.getDocument(options.scenario);
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
  const job = await session.host.jobs.submitRenderIntent({
    schema: 'uniscenario.render-intent-submission/v1',
    engine: options.engine,
    revisionId: frozen.revisionId,
    executionPackageId: frozen.executionPackageId,
    renderSpec,
    idempotencyKey: `render-intent:${frozen.revisionId}:${options.engine}:${createHash('sha256').update(JSON.stringify(renderSpec)).digest('hex').slice(0, 16)}`,
  });
  emit({ jobId: job.id, status: job.status, revisionId: frozen.revisionId, executionPackageId: frozen.executionPackageId, reusedRevision: frozen.reused }, { pretty: options.pretty });
  return EXIT.ok;
}

type TimeOfDay = Environment['timeOfDay'];
const TIME_OF_DAY: readonly TimeOfDay[] = ['morning', 'noon', 'afternoon', 'dusk', 'night', 'dawn', 'night_lit'];

export async function renderSubmitCommand(argv: readonly string[]): Promise<number> {
        const args = parseArgs(argv, {
          booleans: ['pretty'],
          values: ['data-root', 'scenario', 'engine', 'seconds', 'start', 'fps', 'resolution', 'quality', 'sensors', 'environment', 'timeout'],
        });
        const engine = optionalString(args, 'engine') ?? 'native';
        if (!['native', 'browser', 'carla'].includes(engine)) throw new CliError('bad_value', '--engine must be native, browser, or carla', { path: '--engine' });
        const quality = optionalString(args, 'quality') ?? 'standard';
        if (!['preview', 'standard', 'high', 'cinematic'].includes(quality)) throw new CliError('bad_value', '--quality must be preview, standard, high, or cinematic', { path: '--quality' });
        const timeOfDay = optionalString(args, 'environment');
        if (timeOfDay !== undefined && !TIME_OF_DAY.includes(timeOfDay as TimeOfDay)) throw new CliError('bad_value', `--environment must be one of ${TIME_OF_DAY.join(', ')}`, { path: '--environment' });
        const resolution = /^(\d+)x(\d+)$/.exec(optionalString(args, 'resolution') ?? '1280x720');
        if (!resolution) throw new CliError('bad_value', '--resolution must be WxH', { path: '--resolution' });
        const start = optionalNumber(args, 'start') ?? 0;
        const seconds = optionalNumber(args, 'seconds');
        if (seconds === undefined || seconds <= 0) throw new CliError('missing_argument', '--seconds <clip length> is required', { path: '--seconds' });
        const scenario = optionalString(args, 'scenario');
        if (!scenario) throw new CliError('missing_argument', '--scenario <documentId> is required', { path: '--scenario' });
        const fps = optionalNumber(args, 'fps') ?? 20;
        const timeout = optionalNumber(args, 'timeout');
        if (start < 0 || !Number.isFinite(start + seconds)) throw new CliError('bad_value', '--start must be non-negative and the clip end finite');
        if (!Number.isInteger(fps) || fps <= 0 || Number(resolution[1]) <= 0 || Number(resolution[2]) <= 0) throw new CliError('bad_value', 'FPS and resolution dimensions must be positive integers');
        if (timeout !== undefined && timeout <= 0) throw new CliError('bad_value', '--timeout must be positive');
        return renderSubmit({
          dataRoot: optionalString(args, 'data-root'),
          pretty: boolFlag(args, 'pretty'),
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
        });
}

