/**
 * `simforge scene` — import, qualify and reconstruct replayable scenes.
 *
 * This is the entrypoint the `reconstruct.nurec` compute worker runs and the desktop shells
 * out to. It follows the repository CLI contract (`AGENTS.md`): stdout is the result as one
 * JSON document, stderr carries structured errors, and the exit code distinguishes "could not
 * run" from "ran and rejected the input".
 *
 *   0  done
 *   1  could not run — bad arguments, or a capability the host does not have
 *   2  ran and refused the input — missing fields, integrity failure, unsupported shape
 *
 * The error document is the worker envelope the compute control plane classifies
 * (`{error: {code, retryable: false, message, fields?}}`), so a refusal never turns into a
 * retry loop that re-bills the same rejection.
 *
 * Subcommands:
 *   `import --package <usdz> --license <id> --out <dir>`      NuRec artifact  -> bundle
 *   `import --scene-dir <dir> --license <id> --out <dir>`     imported scene  -> bundle
 *   `import --alpasim-root <dir> --scene <id> --license <id>` AlpaSim catalogue -> bundle
 *   `import --clip <dir> --geometry <usdz> --out <dir>`       user clip       -> bundle
 *   `qualify --bundle <dir> --scene-dir <dir> --catalog <dir> --hood <dir|none>`
 *   `reconstruct --clip <dir> --out <dir> [--iterations N]`
 *   `reconstruct --preflight-only`                            capability probe, no GPU work
 *   `admit --clip <dir>`                                      what can this clip do, and why not
 */

import path from 'node:path';

import { loadEvalClip, reconstructionRefusal } from './clip.js';
import { importAlpasimScene } from './importers/alpasim.js';
import { importNurecPackage } from './importers/package.js';
import { importNurecScene } from './importers/nurec.js';
import { importUserBundle } from './importers/user-bundle.js';
import { qualifyBundle, loadReplayContext, writeReplayContext } from './qualify.js';
import { preflightReconstruction, reconstructClip } from './reconstruct.js';
import { resolveEncoder } from './video.js';
import { CapabilityError } from './capability.js';
import { RefusalError, workerErrorEnvelope } from './refusal.js';
import { servableFamilies, servableRigPresets } from './cameras.js';
import type { ReplayContext } from './schema.js';

interface Args {
  readonly command: string;
  readonly flags: Readonly<Record<string, string>>;
  readonly booleans: ReadonlySet<string>;
}

function parseArgs(argv: readonly string[]): Args {
  const flags: Record<string, string> = {};
  const booleans = new Set<string>();
  const command = argv[0] ?? '';
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!token.startsWith('--')) continue;
    const name = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      booleans.add(name);
      continue;
    }
    flags[name] = next;
    i += 1;
  }
  return { command, flags, booleans };
}

function required(args: Args, name: string): string {
  const value = args.flags[name];
  if (value === undefined || value === '') throw new CapabilityError(`--${name} is required`);
  return value;
}

/** Everything a caller needs to see about a bundle without reading the whole document. */
function summarise(bundle: ReplayContext, bundleFile?: string): Record<string, unknown> {
  const cameraIds = bundle.cameras.map((camera) => camera.cameraId);
  return {
    schema: bundle.schema,
    sceneId: bundle.sceneId,
    ...(bundleFile === undefined ? {} : { bundleFile }),
    source: { kind: bundle.source.kind, license: bundle.source.license, redistributable: bundle.source.redistributable },
    cameras: cameraIds,
    families: servableFamilies(cameraIds),
    rigPresets: servableRigPresets(cameraIds),
    tracks: bundle.dynamics.tracks.length,
    window: { originUs: bundle.ego.originUs, endUs: bundle.ego.endUs, poses: bundle.ego.recordedPath.length },
    validity: bundle.validity,
  };
}

async function runImport(args: Args): Promise<Record<string, unknown>> {
  const outDir = args.flags['out'];
  let bundle: ReplayContext;

  if (args.flags['alpasim-root'] !== undefined) {
    bundle = await importAlpasimScene({
      alpasimRoot: args.flags['alpasim-root'],
      license: required(args, 'license'),
      ...(args.flags['scene'] === undefined ? {} : { sceneId: args.flags['scene'] }),
      ...(args.flags['uuid'] === undefined ? {} : { uuid: args.flags['uuid'] }),
      ...(args.flags['suite'] === undefined ? {} : { suite: args.flags['suite'] }),
      ...(args.flags['scene-cache'] === undefined ? {} : { sceneCache: args.flags['scene-cache'] }),
    });
  } else if (args.flags['scene-dir'] !== undefined) {
    bundle = await importNurecScene({
      sceneDir: args.flags['scene-dir'],
      license: required(args, 'license'),
      ...(args.flags['package'] === undefined ? {} : { sourcePackage: args.flags['package'] }),
      ...(args.booleans.has('no-verify-package') ? { verifyPackage: false } : {}),
    });
  } else if (args.flags['package'] !== undefined) {
    bundle = await importNurecPackage({
      packagePath: args.flags['package'],
      license: required(args, 'license'),
      ...(args.flags['scene'] === undefined ? {} : { sceneId: args.flags['scene'] }),
      // `--map` binds lane/route context the package cannot carry. Confidence stays `low`
      // unless the caller states the map came from the authoritative registry.
      ...(args.flags['map'] === undefined
        ? {}
        : {
            map: {
              source: args.flags['map-source'] === 'map-registry' ? 'map-registry' as const : 'derived-from-reconstruction' as const,
              path: args.flags['map'],
              confidence: args.flags['map-source'] === 'map-registry' ? 'high' as const : 'low' as const,
              ...(args.flags['map-id'] === undefined ? {} : { mapId: args.flags['map-id'] }),
            },
          }),
    });
  } else if (args.flags['clip'] !== undefined) {
    const admission = await loadEvalClip(args.flags['clip']);
    bundle = await importUserBundle({ admission, geometryPackage: required(args, 'geometry') });
  } else {
    throw new CapabilityError('import needs one of --package, --scene-dir, --alpasim-root or --clip');
  }

  if (outDir === undefined) return summarise(bundle);
  return summarise(bundle, await writeReplayContext(outDir, bundle));
}

async function runQualify(args: Args): Promise<Record<string, unknown>> {
  const bundleDir = required(args, 'bundle');
  const bundle = await loadReplayContext(bundleDir);
  const result = await qualifyBundle({
    bundle,
    bundleDir,
    sceneDir: args.flags['scene-dir'] ?? bundleDir,
    workDir: args.flags['work-dir'] ?? path.join(bundleDir, 'qualification', 'probes'),
    tier: {
      catalog: (args.flags['catalog'] ?? '').split(',').filter((entry) => entry !== ''),
      hoodDir: required(args, 'hood'),
      ...(args.flags['threedgrut-root'] === undefined ? {} : { threedgrutRoot: args.flags['threedgrut-root'] }),
      ...(args.flags['python'] === undefined ? {} : { pythonCommand: args.flags['python'] }),
      ...(args.flags['splat-command'] === undefined ? {} : { splatCommand: args.flags['splat-command'].split(' ') }),
    },
    ...(args.flags['ticks'] === undefined ? {} : { ticks: Number(args.flags['ticks']) }),
  });
  return {
    ...summarise(result.bundle, result.bundleFile),
    reportFile: result.reportFile,
  };
}

async function runReconstruct(args: Args): Promise<Record<string, unknown>> {
  const tier = {
    ...(args.flags['threedgrut-root'] === undefined ? {} : { threedgrutRoot: args.flags['threedgrut-root'] }),
    ...(args.flags['python'] === undefined ? {} : { pythonCommand: args.flags['python'] }),
  };
  if (args.booleans.has('preflight-only')) {
    const report = await preflightReconstruction(tier);
    if (!report.ok) throw new CapabilityError(report.missing.join('; '));
    return { preflight: report };
  }
  const admission = await loadEvalClip(required(args, 'clip'));
  const refusal = reconstructionRefusal(admission);
  if (refusal !== undefined) throw new RefusalError(refusal);
  const encoder = await resolveEncoder({
    ...(args.flags['ffmpeg'] === undefined ? {} : { ffmpeg: args.flags['ffmpeg'] }),
    ...(args.flags['ffprobe'] === undefined ? {} : { ffprobe: args.flags['ffprobe'] }),
    ...(args.flags['desktop-manifest'] === undefined ? {} : { manifestPath: args.flags['desktop-manifest'] }),
  });
  const result = await reconstructClip({
    admission,
    workDir: required(args, 'out'),
    tier,
    ...(encoder === undefined ? {} : { encoder }),
    ...(args.flags['iterations'] === undefined ? {} : { iterations: Number(args.flags['iterations']) }),
  });
  const bundleFile = await writeReplayContext(path.join(required(args, 'out'), 'bundle'), result.bundle);
  return {
    ...summarise(result.bundle, bundleFile),
    reconstruction: {
      usdz: result.usdzPath,
      dataset: result.datasetDir,
      run: result.runDir,
      images: result.dataset.images,
      frameExtraction: result.dataset.extractions,
    },
    note: 'geometry exists but is not qualified; run `scene qualify` before any closed-loop episode',
  };
}

async function runAdmit(args: Args): Promise<Record<string, unknown>> {
  const admission = await loadEvalClip(required(args, 'clip'));
  return {
    clipId: admission.clip.clipId,
    openLoopInference: admission.openLoopInference,
    openLoopScored: admission.openLoopScored,
    reconstructionReady: admission.reconstructionReady,
    closedLoopReady: admission.closedLoopReady,
    families: admission.families,
    rigPresets: admission.rigPresets,
    ...(admission.refusal === undefined ? {} : { refusal: admission.refusal }),
    ...(reconstructionRefusal(admission) === undefined
      ? {}
      : { reconstructionRefusal: reconstructionRefusal(admission) }),
  };
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  try {
    let result: Record<string, unknown>;
    switch (args.command) {
      case 'import':
        result = await runImport(args);
        break;
      case 'qualify':
        result = await runQualify(args);
        break;
      case 'reconstruct':
        result = await runReconstruct(args);
        break;
      case 'admit':
        result = await runAdmit(args);
        break;
      default:
        process.stderr.write(
          `${JSON.stringify({ code: 'unknown_command', reason: `unknown command "${args.command}"`, detail: 'expected import | qualify | reconstruct | admit' })}\n`,
        );
        return 1;
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof RefusalError) {
      process.stderr.write(`${JSON.stringify(workerErrorEnvelope('input_error', error.refusal))}\n`);
      return 2;
    }
    if (error instanceof CapabilityError) {
      process.stderr.write(`${JSON.stringify(workerErrorEnvelope('capability_error', error.message))}\n`);
      return 1;
    }
    process.stderr.write(`${JSON.stringify(workerErrorEnvelope('internal', (error as Error).message))}\n`);
    return 1;
  }
}
