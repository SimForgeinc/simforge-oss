import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { RenderIntentV1Schema } from '@simforge-oss/scenario';

import { RenderArtifactManifestSchema, type RenderArtifactManifest } from './artifacts.js';
import { ENGINE_CAPABILITIES_V1_SCHEMA, type EngineCapabilityDeclaration } from './capabilities.js';
import { loadRenderEngine, type RenderEngineAdapter, type RenderExecutionContext } from './engine.js';
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
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout = `${stdout}${chunk}`.slice(-16_384); });
    child.stderr.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-16_384); });
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
      // A policy refusal (docs/engineering/no-silent-fallbacks.md): the
      // adapter's last stdout line names the missing thing and its code.
      throw carlaRenderFailure(stdout) ?? new Error(`CARLA renderer refused the render without a failure record: stdout=${stdout} stderr=${stderr}`);
    }
    if (result.code !== 0) {
      throw new Error(`CARLA renderer exited code=${String(result.code)} signal=${String(result.signal)} stdout=${stdout} stderr=${stderr}`);
    }
    return RenderArtifactManifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
  }
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
