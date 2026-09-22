/**
 * Headless SUMO for the CLI and local workers: the exact worker traffic step
 * (`@simforge-oss/engine` `runSumoTraffic`) against installed map assets.
 *
 * Nothing here owns traffic semantics. It locates the pinned runtime and the
 * map's SUMO derivative, simulates the authored actors with ambient traffic
 * off, runs the one-way SUMO step and merges its output into the trace — the
 * same pipeline the authoritative simulate job runs.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  auditSumoSignalCompliance,
  mergeSumoTrafficIntoTrace,
  type SumoSignalAudit,
  runSumoTraffic,
  traceToSceneFrame,
  validateSumoNetworkManifest,
  type ResolvedAmbientTrafficProfile,
  type SimScenarioInput,
  type SimTrace,
  type SumoNetworkManifest,
  type SumoRuntime,
  type SumoTrafficNetwork,
  type SumoTrafficResult,
} from '@simforge-oss/engine';
import { engine, loadSumoRuntime } from '@simforge-oss/engine/node';

import { CliError } from './errors.js';
import { DEV_ASSETS, type MapBundle } from '@simforge-oss/compiler/node';

export interface HeadlessSumoSample {
  readonly t: number;
  readonly x: number;
  readonly z: number;
  readonly headingRad: number;
  readonly speedMps: number;
  readonly accelerationMps2: number;
  readonly signals: number;
}

export interface WorkerSumoRun {
  readonly authoredTrace: SimTrace;
  readonly authoredTraceSha256: string;
  readonly traffic: SumoTrafficResult;
  readonly trace: SimTrace;
  readonly traceSha256: string;
  /** Red-light audit of the merged SUMO actors against the rendered heads. */
  readonly signalAudit: SumoSignalAudit;
}

/** `$SIMFORGE_SUMO_RUNTIME_DIR`, else `<dev-assets>/sumo-runtime`. */
export function sumoRuntimeDirectory(): string {
  return path.resolve(process.env['SIMFORGE_SUMO_RUNTIME_DIR'] ?? path.join(DEV_ASSETS, 'sumo-runtime'));
}

export async function loadInstalledSumoRuntime(): Promise<SumoRuntime> {
  const directory = sumoRuntimeDirectory();
  for (const file of ['sumo.mjs', 'sumo.wasm', 'runtime-manifest.json']) {
    if (!existsSync(path.join(directory, file))) {
      throw new CliError('sumo_unavailable', `SUMO runtime file ${file} is not available`, {
        path: path.join(directory, file),
        detail: { hint: 'install dev-assets/sumo-runtime or set SIMFORGE_SUMO_RUNTIME_DIR, or run with --provider native' },
      });
    }
  }
  try {
    return await loadSumoRuntime(directory);
  } catch (error) {
    throw new CliError('sumo_unavailable', error instanceof Error ? error.message : String(error), { path: directory });
  }
}

export async function loadInstalledSumoNetwork(mapId: string): Promise<SumoTrafficNetwork> {
  const manifestFile = path.join(DEV_ASSETS, mapId, 'derived', 'sumo', 'sumo-network-manifest.json');
  if (!existsSync(manifestFile)) {
    throw new CliError('sumo_unavailable', 'map SUMO sidecar is not available', {
      path: manifestFile,
      detail: { hint: `build it with "pnpm maps:sumo -- --map ${mapId}" (toolchain: "pnpm maps:sumo:toolchain"), or run with --provider native` },
    });
  }
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as SumoNetworkManifest;
  try {
    validateSumoNetworkManifest(manifest, mapId);
  } catch (error) {
    throw new CliError('sumo_unavailable', error instanceof Error ? error.message : String(error), { path: manifestFile });
  }
  const networkFile = path.resolve(path.dirname(manifestFile), manifest.networkFile);
  if (!existsSync(networkFile)) {
    throw new CliError('sumo_unavailable', 'SUMO network declared by the map sidecar is missing', { path: networkFile });
  }
  return { bytes: new Uint8Array(await readFile(networkFile)), manifest };
}

/**
 * Simulate the authored actors (ambient off), run the worker SUMO step and
 * merge it: the authoritative SUMO pipeline on one host.
 */
export async function runWorkerSumo(options: {
  readonly input: SimScenarioInput;
  readonly bundle: MapBundle;
  readonly profile: ResolvedAmbientTrafficProfile;
  /** Defaults to the authored trace's input hash. */
  readonly sourceInputDigest?: string;
  readonly map: { readonly assetId: string; readonly versionId: string };
  readonly runtime?: SumoRuntime;
  readonly network?: SumoTrafficNetwork;
  readonly signalAuthority?: 'simforge' | 'netconvert';
}): Promise<WorkerSumoRun> {
  const runtime = options.runtime ?? await loadInstalledSumoRuntime();
  const network = options.network ?? await loadInstalledSumoNetwork(options.input.mapId);
  const authoredTrace = engine().runSimulation(options.input, { graph: options.bundle.graph }).trace;
  const authoredTraceSha256 = engine().traceDigest(authoredTrace);
  const traffic = await runSumoTraffic(runtime, {
    authoredTrace,
    authoredTraceSha256,
    sourceInputDigest: options.sourceInputDigest ?? authoredTrace.header.inputHash,
    signalPrograms: options.input.signalPrograms,
    roadControls: options.input.roadControls,
    profile: options.profile,
    network,
    map: options.map,
    ...(options.signalAuthority ? { signalAuthority: options.signalAuthority } : {}),
  });
  const trace = mergeSumoTrafficIntoTrace(authoredTrace, traffic.artifact);
  const signalAudit = auditSumoSignalCompliance({
    trace,
    networkXml: new TextDecoder().decode(network.bytes),
    transform: network.manifest.worldFromNetwork,
    signalPrograms: options.input.signalPrograms,
    roadControls: options.input.roadControls,
  });
  return { authoredTrace, authoredTraceSha256, traffic, trace, traceSha256: engine().traceDigest(trace), signalAudit };
}

/** Sampled SUMO paths (scene frame) for the `debug --provider sumo` report. */
export function sumoPaths(run: WorkerSumoRun, sampleSeconds: number): Record<string, readonly HeadlessSumoSample[]> {
  const scene = traceToSceneFrame(run.trace);
  const stride = Math.max(1, Math.round(sampleSeconds / run.trace.header.dt));
  const byId = new Map(run.traffic.artifact.artifact.actors.map((actor) => [actor.id, actor]));
  const paths: Record<string, HeadlessSumoSample[]> = {};
  for (const [id, actor] of byId) {
    const track = scene.ticks.actors[id]!;
    const samples: HeadlessSumoSample[] = [];
    for (let index = 0; index < track.x.length; index += stride) {
      if (track.present[index] !== 1) continue;
      samples.push({
        t: actor.states[index]!.t,
        x: track.x[index]!,
        z: track.z[index]!,
        headingRad: track.headingRad[index]!,
        speedMps: track.speedMps[index]!,
        accelerationMps2: actor.states[index]!.accelerationMps2,
        signals: actor.states[index]!.signals,
      });
    }
    if (samples.length > 0) paths[id] = samples;
  }
  return paths;
}
