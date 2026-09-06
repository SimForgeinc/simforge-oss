import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { canonicalize, parseRenderIntent, type RenderIntentV1 } from '@simforge-oss/scenario';
import {
  RenderArtifactManifestSchema,
  RenderProgressRecordSchema,
  assertEngineSupportsIntent,
  createFixedSchedules,
  encodeProgressJsonl,
  hashFile,
  hashRenderIntent,
  loadBuiltinRenderEngine,
  type BuiltinRenderEngineId,
  type RenderInputFile,
  type RenderProgressRecord,
} from '@simforge-oss/render';

import { CliError, EXIT } from '../errors.js';
import { emit } from '../output.js';

export interface RenderRunOptions {
  readonly intentPath: string;
  readonly engine: BuiltinRenderEngineId;
  readonly outDir: string;
  readonly inputsPath: string;
  readonly engineOptionsPath?: string;
  readonly pretty: boolean;
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    throw new CliError('read_failed', `could not read JSON ${path}`, {
      detail: { cause: error instanceof Error ? error.message : String(error) },
    });
  }
}

/**
 * `--inputs` maps every intent input id to a local file: a bare path, or
 * `{ path, relativePath }` when the engine binds the id to a closure path
 * (native map members, whose ids derive from `relativePath`).
 */
async function localInputs(
  inputMapPath: string,
  intent: RenderIntentV1,
): Promise<ReadonlyMap<string, RenderInputFile>> {
  const raw = await readJson(inputMapPath);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new CliError('bad_value', '--inputs must name a JSON object');
  const entries = raw as Record<string, unknown>;
  const expected = new Map<string, { sha256: string; sizeBytes: number }>([
    ['scenario.xosc', intent.scenarioRevision.openScenario],
    ...intent.assets.map((asset) => [asset.assetId, asset] as const),
  ]);
  const result = new Map<string, RenderInputFile>();
  for (const [inputId, digest] of expected) {
    const configured = entries[inputId];
    const entry = typeof configured === 'string'
      ? { path: configured }
      : configured && typeof configured === 'object' && !Array.isArray(configured)
        ? configured as { path?: unknown; relativePath?: unknown }
        : undefined;
    if (!entry || typeof entry.path !== 'string' || entry.path.length === 0) {
      throw new CliError('missing_argument', `input map is missing "${inputId}"`);
    }
    if (entry.relativePath !== undefined && (typeof entry.relativePath !== 'string' || entry.relativePath.length === 0)) {
      throw new CliError('bad_value', `input "${inputId}" relativePath must be a non-empty string`);
    }
    const path = isAbsolute(entry.path) ? entry.path : resolve(dirname(inputMapPath), entry.path);
    const actual = await hashFile(path);
    if (actual.sha256 !== digest.sha256 || actual.sizeBytes !== digest.sizeBytes) {
      throw new CliError('input_mismatch', `input ${inputId} does not match render intent`, {
        detail: { expected: digest, actual },
      });
    }
    result.set(inputId, {
      inputId, path, ...actual,
      ...(entry.relativePath === undefined ? {} : { relativePath: entry.relativePath }),
    });
  }
  const extras = Object.keys(entries).filter((inputId) => !expected.has(inputId));
  if (extras.length > 0) throw new CliError('bad_value', 'input map contains entries absent from render intent', { detail: { extras } });
  return result;
}

export async function renderHash(intentPath: string, pretty: boolean): Promise<number> {
  const intent = parseRenderIntent(await readJson(intentPath));
  emit({ schema: intent.schema, intentId: intent.intentId, intentSha256: hashRenderIntent(intent) }, { pretty });
  return EXIT.ok;
}

export async function renderRun(options: RenderRunOptions): Promise<number> {
  const intent = parseRenderIntent(await readJson(options.intentPath));
  const intentSha256 = hashRenderIntent(intent);
  const executionPackageControlSha256 = createHash('sha256').update(JSON.stringify(canonicalize({
    schema: 'simforge.render-control-lineage/v1',
    intentSha256,
    executionPackageId: intent.executionPackage.id,
    sourceInputDigest: intent.executionPackage.sourceInputDigest,
  })), 'utf8').digest('hex');
  const inputs = await localInputs(options.inputsPath, intent);
  const engineOptionsRaw = options.engineOptionsPath ? await readJson(options.engineOptionsPath) : {};
  if (!engineOptionsRaw || typeof engineOptionsRaw !== 'object' || Array.isArray(engineOptionsRaw)) {
    throw new CliError('bad_value', '--engine-options must name a JSON object');
  }
  const engine = await loadBuiltinRenderEngine(options.engine, engineOptionsRaw as Record<string, unknown>);
  assertEngineSupportsIntent(engine.capabilities, intent);
  const workspace = resolve(options.outDir);
  await mkdir(workspace, { recursive: true });
  let sequence = 0;
  const reportProgress = async (candidate: RenderProgressRecord): Promise<void> => {
    const record = RenderProgressRecordSchema.parse({
      ...candidate,
      jobId: intent.intentId,
      attempt: 1,
      sequence,
      timestamp: new Date().toISOString(),
    });
    process.stderr.write(encodeProgressJsonl(record));
    sequence += 1;
  };
  const controller = new AbortController();
  const cancel = (signal: NodeJS.Signals): void => {
    if (controller.signal.aborted) process.exit(128 + (signal === 'SIGINT' ? 2 : 15));
    controller.abort(new Error(`render canceled by ${signal}`));
  };
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);

  try {
    await reportProgress({
      schema: RenderProgressRecordSchema.options[0].shape.schema.value,
      event: 'job.started',
      jobId: intent.intentId,
      attempt: 1,
      sequence: 0,
      timestamp: new Date().toISOString(),
    });
    const manifest = RenderArtifactManifestSchema.parse(await engine.execute({
      jobId: intent.intentId,
      attempt: 1,
      intent,
      intentSha256,
      executionPackageControlSha256,
      schedules: createFixedSchedules(intent),
      inputs,
      workspace,
      signal: controller.signal,
      reportProgress,
    }));
    if (manifest.intentSha256 !== intentSha256) throw new CliError('input_mismatch', 'engine returned a manifest for another intent');
    for (const artifact of manifest.artifacts) {
      const path = resolve(workspace, artifact.relativePath);
      if (path !== workspace && !path.startsWith(`${workspace}/`)) throw new CliError('bad_value', `artifact escapes output directory: ${artifact.relativePath}`);
      const digest = await hashFile(path);
      if (digest.sha256 !== artifact.sha256 || digest.sizeBytes !== artifact.sizeBytes) {
        throw new CliError('input_mismatch', `artifact does not match manifest: ${artifact.relativePath}`);
      }
    }
    if (manifest.artifacts.length === 0) throw new CliError('render_failed', 'engine produced no artifacts');
    const manifestPath = join(workspace, 'render-artifact-manifest.json');
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
    emit({ intentSha256, manifestPath, artifactCount: manifest.artifacts.length }, { pretty: options.pretty });
    return EXIT.ok;
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
    await engine.close?.();
  }
}
