import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { RenderIntentV1Schema } from '@simforge-oss/scenario';

import { RenderArtifactManifestSchema, type RenderArtifactManifest } from './artifacts.js';
import { ENGINE_CAPABILITIES_V1_SCHEMA, type EngineCapabilityDeclaration } from './capabilities.js';
import { CarlaSimulator, type CarlaSimulatorOptions } from './carla-simulator.js';
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
    private readonly simulator?: CarlaSimulator,
  ) {
    this.capabilities = { ...CARLA_CAPABILITIES, engineVersion };
  }

  gpuResidency(): { readonly residentSince: string } | null {
    return this.simulator?.residency() ?? null;
  }

  async releaseGpuResidency(reason: string): Promise<void> {
    await this.simulator?.stop(reason);
  }

  async close(): Promise<void> {
    await this.simulator?.stop('worker stopping');
  }

  async execute(context: RenderExecutionContext): Promise<RenderArtifactManifest> {
    if (!this.simulator) return this.run(context);
    // On demand: the server is started for this job (or reused while warm)
    // and stops after its idle timeout. A server that cannot start fails the
    // job with its carla_simulator_* code; nothing renders without it.
    const start = await this.simulator.ensureRunning(context.signal);
    if (start.cold) {
      await context.reportProgress({
        schema: 'simforge.render-progress/v1',
        event: 'warning',
        code: 'carla_simulator_cold_start',
        message: `CARLA server cold-started on demand for this job in ${(start.coldStartMs / 1000).toFixed(1)} s (coldStartMs=${start.coldStartMs}); it was not running before the lease`,
        jobId: context.jobId,
        attempt: context.attempt,
        sequence: 0,
        timestamp: new Date().toISOString(),
      });
    }
    try {
      return await this.run(context);
    } finally {
      this.simulator.markIdle();
    }
  }

  private async run(context: RenderExecutionContext): Promise<RenderArtifactManifest> {
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
  const simulator = options.simulator === undefined ? undefined : new CarlaSimulator(carlaSimulatorOptions(options.simulator, host, configuredPort));
  return new CarlaProcessEngine(binary, host, configuredPort, engineVersion, simulator);
}

/**
 * `options.simulator`: the worker starts and stops the CARLA server itself
 * (on demand) instead of connecting to an always-on one. Every field is
 * required except the timeouts; a malformed block is a configuration error,
 * never a silent always-on fallback.
 */
export function carlaSimulatorOptions(raw: unknown, host: string, port: number): CarlaSimulatorOptions {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('CARLA simulator options must be an object');
  const value = raw as Record<string, unknown>;
  const known = new Set(['command', 'args', 'cwd', 'readyTimeoutMs', 'idleStopMs', 'handshake', 'stopGraceMs']);
  const unknown = Object.keys(value).filter((key) => !known.has(key));
  if (unknown.length > 0) throw new Error(`Unknown CARLA simulator option(s): ${unknown.join(', ')}`);
  if (typeof value.command !== 'string' || value.command.length === 0) throw new Error('CARLA simulator command is required');
  if (!Array.isArray(value.args) || !value.args.every((arg) => typeof arg === 'string')) throw new Error('CARLA simulator args must be a string array');
  const portArg = value.args.find((arg: string) => arg.startsWith('-carla-rpc-port='));
  if (portArg !== undefined && portArg !== `-carla-rpc-port=${port}`) {
    throw new Error(`CARLA simulator ${portArg} does not match the engine port ${port}`);
  }
  const duration = (key: string, fallback: number, min: number, max: number): number => {
    const configured = value[key] ?? fallback;
    if (typeof configured !== 'number' || !Number.isInteger(configured) || configured < min || configured > max) {
      throw new Error(`CARLA simulator ${key} must be an integer from ${min} to ${max}`);
    }
    return configured;
  };
  const handshake = value.handshake;
  if (handshake !== undefined && handshake !== null && !(Array.isArray(handshake) && handshake.length > 0 && handshake.every((arg) => typeof arg === 'string'))) {
    throw new Error('CARLA simulator handshake must be a non-empty string array or null');
  }
  if (value.cwd !== undefined && typeof value.cwd !== 'string') throw new Error('CARLA simulator cwd must be a string');
  return {
    command: value.command,
    args: value.args as string[],
    ...(typeof value.cwd === 'string' ? { cwd: value.cwd } : {}),
    host,
    port,
    readyTimeoutMs: duration('readyTimeoutMs', 120_000, 1_000, 900_000),
    idleStopMs: duration('idleStopMs', 600_000, 0, 86_400_000),
    stopGraceMs: duration('stopGraceMs', 20_000, 0, 300_000),
    ...(handshake !== undefined ? { handshake: handshake as string[] | null } : {}),
  };
}
