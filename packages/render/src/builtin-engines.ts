import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { RenderIntentV1Schema } from '@simforge-oss/scenario';

import { RenderArtifactManifestSchema, type RenderArtifactManifest } from './artifacts.js';
import { ENGINE_CAPABILITIES_V1_SCHEMA, type EngineCapabilityDeclaration } from './capabilities.js';
import { loadRenderEngine, type RenderEngineAdapter, type RenderExecutionContext } from './engine.js';
import { scrubbedLogTail } from './log-scrub.js';
import { parseProgressJsonl } from './progress.js';
import { RENDER_INPUT_ERROR_CODE, RenderInputError, renderInputErrorFromServiceMessage, type RenderInputErrorCode } from './render-input-error.js';

export type BuiltinRenderEngineId = 'browser' | 'carla' | 'native';

/**
 * CARLA ships as a pinned container, so its engine version is the source
 * revision that image was built from (`SOURCE_REVISION`,
 * `services/render-worker/docker/carla.Dockerfile`) — the same 40-hex commit
 * the control plane pins when it approves a CARLA node. The native and browser
 * engines report their package version and are exempt from that check, so the
 * only thing to copy from them is the resolution shape: an explicit
 * `engineVersion` option first, then the environment.
 */
const CARLA_CAPABILITIES: Omit<EngineCapabilityDeclaration, 'engineVersion'> = {
  schema: ENGINE_CAPABILITIES_V1_SCHEMA,
  engineId: 'simforge-carla',
  backend: 'carla',
  protocolVersion: 1,
  capabilities: [
    'openscenario.1_4',
    'timing.fixed_step',
    'environment.authored',
    'sensor.rgb',
    'sensor.depth',
    'sensor.semantic',
    'sensor.instance',
    'sensor.lidar',
    'sensor.radar',
    'artifact.video',
    'artifact.sensor_video',
    'artifact.sensor_archive',
    'artifact.manifest',
    'artifact.trace',
    'artifact.annotations',
    'map.static_semantics',
    'control.native',
    'divergence.classified',
  ],
  modalities: ['rgb', 'depth', 'semantic', 'instance', 'lidar', 'radar'],
  limits: {
    maxSimultaneousSensors: 64,
    maxWidth: 8192,
    maxHeight: 8192,
    maxFramesPerSecond: 240,
  },
  requiresGpu: true,
};

class CarlaProcessEngine implements RenderEngineAdapter {
  readonly capabilities: EngineCapabilityDeclaration;

  constructor(
    private readonly binary: string,
    private readonly host: string,
    private readonly port: number,
    engineVersion: string,
  ) {
    this.capabilities = { ...CARLA_CAPABILITIES, engineVersion };
  }

  async execute(context: RenderExecutionContext): Promise<RenderArtifactManifest> {
    await mkdir(context.workspace, { recursive: true });
    const intentPath = join(context.workspace, 'render-intent.json');
    const packagePath = join(context.workspace, 'input-package.json');
    const progressPath = join(context.workspace, 'carla-progress.jsonl');
    const manifestPath = join(context.workspace, 'render-artifact-manifest.json');
    await writeFile(intentPath, `${JSON.stringify(RenderIntentV1Schema.parse(context.intent))}\n`, { mode: 0o644 });
    await writeFile(packagePath, `${JSON.stringify({
      intentSha256: context.intentSha256,
      executionPackageControlSha256: context.executionPackageControlSha256,
      inputs: [...context.inputs.values()],
    })}\n`, { mode: 0o644 });

    const child = spawn(this.binary, [
      '--host', this.host,
      '--port', String(this.port),
      'run-intent',
      '--intent', intentPath,
      '--package', packagePath,
      '--output', context.workspace,
      '--progress', progressPath,
      '--manifest', manifestPath,
      // The adapter records substitutions only when the lease negotiated it.
      '--control-features', [...(context.controlFeatures ?? [])].sort().join(','),
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let stderrTruncated = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout = `${stdout}${chunk}`.slice(-CARLA_OUTPUT_CAPTURE_CHARS); });
    child.stderr.on('data', (chunk: string) => {
      const joined = `${stderr}${chunk}`;
      if (joined.length > CARLA_OUTPUT_CAPTURE_CHARS) stderrTruncated = true;
      stderr = joined.slice(-CARLA_OUTPUT_CAPTURE_CHARS);
    });
    const terminate = (): void => {
      child.kill('SIGTERM');
      const hardKill = setTimeout(() => child.kill('SIGKILL'), 10_000);
      hardKill.unref();
    };
    context.signal.addEventListener('abort', terminate, { once: true });

    let consumedLines = 0;
    const forwardProgress = async (): Promise<void> => {
      let text: string;
      try {
        text = await readFile(progressPath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      const lines = text.split('\n');
      const completeLineCount = text.endsWith('\n') ? lines.length - 1 : lines.length - 1;
      for (; consumedLines < completeLineCount; consumedLines++) {
        const line = lines[consumedLines];
        if (line && line.trim().length > 0) await context.reportProgress(parseProgressJsonl(line));
      }
    };

    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    let result: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    while (!result) {
      result = await Promise.race([
        exit,
        new Promise<undefined>((resolve) => {
          const timer = setTimeout(() => resolve(undefined), 250);
          timer.unref();
        }),
      ]);
      await forwardProgress();
    }
    context.signal.removeEventListener('abort', terminate);
    await forwardProgress();
    if (result.code === 3) {
      // A deterministic refusal (docs/engineering/no-silent-fallbacks.md): the
      // adapter's last stdout line names the missing thing and its code.
      const refusal = carlaRenderFailure(stdout);
      if (refusal) throw refusal;
    }
    if (result.code !== 0) {
      throw carlaProcessFailure(result, stderr, { truncatedHead: stderrTruncated, aborted: context.signal.aborted });
    }
    return RenderArtifactManifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
  }
}

/** How much of each CARLA process stream the engine keeps (the tail). */
const CARLA_OUTPUT_CAPTURE_CHARS = 16_384;

/**
 * A CARLA process that exited non-zero without a readable failure record.
 * Its message carries the scrubbed tail of stderr, so the job's failure
 * detail says why instead of a bare execution failure. An unexplained crash
 * may be transient (a lost CARLA server, an OOM kill) and stays retryable;
 * exit 3 is the adapter's own deterministic refusal and is not retried even
 * when its record could not be read.
 */
export class CarlaProcessError extends Error {
  readonly code: 'carla_process_failed' | 'carla_process_refused';
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly details: { exitCode: number | null; signal: string | null; stderrTail: string },
  ) {
    super(message);
    this.name = 'CarlaProcessError';
    this.code = retryable ? 'carla_process_failed' : 'carla_process_refused';
  }
}

export function carlaProcessFailure(
  exit: { code: number | null; signal: NodeJS.Signals | null },
  stderr: string,
  options: { truncatedHead?: boolean; aborted?: boolean } = {},
): CarlaProcessError {
  const refused = exit.code === 3;
  const tail = scrubbedLogTail(stderr, { truncatedHead: options.truncatedHead });
  const how = exit.signal ? `was killed by ${exit.signal}` : `exited with code ${String(exit.code)}`;
  const head = refused
    ? `CARLA renderer refused the render (exit 3) without a readable failure record`
    : `CARLA renderer ${how} without a failure record${options.aborted ? ' after the job was aborted' : ''}`;
  return new CarlaProcessError(
    tail ? `${head}; last stderr lines:\n${tail}` : `${head}; stderr was empty`,
    !refused,
    { exitCode: exit.code, signal: exit.signal, stderrTail: tail },
  );
}

/** The adapter's `simforge.carla-render-failure/v1` record, as a non-retryable error. */
export function carlaRenderFailure(stdout: string): RenderInputError | undefined {
  const line = stdout.trim().split('\n').at(-1);
  if (!line) return undefined;
  let record: { schema?: unknown; code?: unknown; message?: unknown };
  try {
    record = JSON.parse(line) as typeof record;
  } catch {
    return undefined;
  }
  if (record.schema !== 'simforge.carla-render-failure/v1' || typeof record.code !== 'string' || typeof record.message !== 'string') {
    return undefined;
  }
  return renderInputErrorFromServiceMessage(record.message)
    ?? (RENDER_INPUT_ERROR_CODE.test(record.code) ? new RenderInputError(record.code as RenderInputErrorCode, record.message) : undefined);
}

export async function loadBuiltinRenderEngine(
  engineId: BuiltinRenderEngineId,
  options: Readonly<Record<string, unknown>> = {},
): Promise<RenderEngineAdapter> {
  if (engineId === 'browser') {
    const moduleSpecifier = typeof options.module === 'string'
      ? options.module
      : process.env.SIMFORGE_BROWSER_ENGINE_MODULE ?? './web/index.js';
    const { module: _module, ...engineOptions } = options;
    return loadRenderEngine(moduleSpecifier, engineOptions);
  }
  if (engineId === 'native') {
    const moduleSpecifier = typeof options.module === 'string'
      ? options.module
      : process.env.SIMFORGE_NATIVE_ENGINE_MODULE ?? '@simforge-oss/render/native';
    const { module: _module, ...engineOptions } = options;
    return loadRenderEngine(moduleSpecifier, engineOptions);
  }
  const binary = typeof options.binary === 'string'
    ? options.binary
    : process.env.SIMFORGE_CARLA_BINARY ?? 'simforge-oss-carla-exec';
  const host = typeof options.host === 'string'
    ? options.host
    : process.env.CARLA_HOST ?? '127.0.0.1';
  const configuredPort = typeof options.port === 'number'
    ? options.port
    : Number(process.env.CARLA_PORT ?? 2000);
  if (!Number.isInteger(configuredPort) || configuredPort < 1 || configuredPort > 65_535) {
    throw new Error(`Invalid CARLA port: ${String(configuredPort)}`);
  }
  const engineVersion = typeof options.engineVersion === 'string'
    ? options.engineVersion
    : process.env.SIMFORGE_CARLA_SOURCE_REVISION ?? process.env.SIMFORGE_SOURCE_REVISION ?? '';
  if (!/^[a-f0-9]{40}$/.test(engineVersion)) {
    throw new Error(
      'CARLA engine version must be the 40-hex source revision the worker image was built from'
      + ' (SIMFORGE_SOURCE_REVISION, or the engineVersion option);'
      + ` received ${engineVersion === '' ? 'nothing' : engineVersion}`,
    );
  }
  return new CarlaProcessEngine(binary, host, configuredPort, engineVersion);
}
