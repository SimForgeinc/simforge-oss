/**
 * `simforge traffic sumo <scenario.json>` — the worker SUMO traffic job on one host.
 *
 * Resolves the scenario like the authoritative simulate job does, simulates
 * the authored actors with ambient traffic off, runs the one-way SUMO step on
 * the pinned WebAssembly runtime and merges its output into the trace.
 * `--repeat N` re-runs the whole step N times in fresh SUMO modules and fails
 * unless every run produced byte-identical traffic.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  ambientTrafficProfileFromExtensions,
  resolveAmbientTrafficProfile,
  type AmbientTrafficProfile,
  type ResolvedAmbientTrafficProfile,
  type SimScenarioInput,
} from '@simforge-oss/engine';
import {
  detectKind,
  executionSourceInputDigest,
  loadMap,
  readInstance,
  resolveExecutionInput,
  type MapBundle,
} from '@simforge-oss/compiler/node';
import { readFile } from 'node:fs/promises';

import { CliError, EXIT } from '../errors.js';
import { emit } from '../output.js';
import {
  loadInstalledSumoNetwork,
  loadInstalledSumoRuntime,
  runWorkerSumo,
  type WorkerSumoRun,
} from '../sumo-headless.js';

export interface TrafficSumoOptions {
  readonly file: string;
  readonly preset?: string;
  readonly seed?: string;
  readonly maxActors?: number;
  readonly durationSeconds?: number;
  readonly out?: string;
  readonly repeat: number;
  readonly signalAuthority?: 'simforge' | 'netconvert';
  readonly pretty: boolean;
}

export async function trafficSumo(options: TrafficSumoOptions): Promise<number> {
  const scenario = await resolveScenario(options);
  const runtime = await loadInstalledSumoRuntime();
  const network = await loadInstalledSumoNetwork(scenario.input.mapId);
  const runs: WorkerSumoRun[] = [];
  const started = performance.now();
  for (let index = 0; index < Math.max(1, options.repeat); index += 1) {
    runs.push(await runWorkerSumo({
      input: scenario.input,
      bundle: scenario.bundle,
      profile: scenario.profile,
      sourceInputDigest: scenario.sourceInputDigest,
      map: { assetId: scenario.input.mapId, versionId: `installed:${network.manifest.sha256.slice(0, 16)}` },
      runtime,
      network,
      ...(options.signalAuthority ? { signalAuthority: options.signalAuthority } : {}),
    }));
  }
  const milliseconds = performance.now() - started;
  const first = runs[0]!;
  const identical = runs.every((run) => run.traffic.artifact.sha256 === first.traffic.artifact.sha256
    && run.traffic.key === first.traffic.key && run.traceSha256 === first.traceSha256);
  const diagnostics = first.traffic.diagnostics;
  if (options.out) {
    const out = path.resolve(options.out);
    await mkdir(out, { recursive: true });
    await writeFile(path.join(out, 'materialized-traffic.json'), first.traffic.artifact.bytes);
    await writeFile(path.join(out, 'trace.json'), JSON.stringify(first.trace));
    await writeFile(path.join(out, 'authored-trace.json'), JSON.stringify(first.authoredTrace));
    await writeFile(path.join(out, 'sumo-diagnostics.json'), `${JSON.stringify({ ...diagnostics, signalAudit: first.signalAudit }, null, 2)}\n`);
  }
  emit({
    schema: 'simforge.sumo-traffic-run/v1',
    mapId: scenario.input.mapId,
    source: scenario.kind,
    key: first.traffic.key,
    materializedTrafficSha256: first.traffic.artifact.sha256,
    materializedTrafficBytes: first.traffic.artifact.sizeBytes,
    authoredTraceSha256: first.authoredTraceSha256,
    traceSha256: first.traceSha256,
    sumoActors: first.traffic.artifact.artifact.actors.length,
    repeat: runs.length,
    identical,
    runSha256s: runs.map((run) => run.traffic.artifact.sha256),
    milliseconds: Math.round(milliseconds),
    diagnostics: {
      runtime: diagnostics.runtime,
      stepSeconds: diagnostics.stepSeconds,
      preRollSeconds: diagnostics.preRollSeconds,
      peakActors: diagnostics.peakActors,
      uniqueActors: diagnostics.uniqueActors,
      float32UlpM: diagnostics.float32UlpM,
      signals: diagnostics.signals,
      signalAgreement: diagnostics.signalAgreement,
      signalOverrideTicks: diagnostics.signalOverrideTicks,
      authoredCorridorRejects: diagnostics.authoredCorridorRejects,
      teleports: diagnostics.teleports,
      laneSeamJumps: diagnostics.laneSeamJumps,
      maxLaneSeamJumpM: diagnostics.maxLaneSeamJumpM,
      unplacedProxies: diagnostics.unplacedProxies,
      proxyRouteEdge: diagnostics.proxyRouteEdge,
      warnings: diagnostics.warnings.length,
    },
    signalAudit: {
      crossings: first.signalAudit.crossings,
      unresolved: first.signalAudit.unresolved,
      crossingsByBinding: first.signalAudit.crossingsByBinding,
      redViolations: first.signalAudit.redViolations,
      unsignalledOnRedHead: first.signalAudit.unsignalledOnRedHead.length,
    },
    ...(options.out ? { out: path.resolve(options.out) } : {}),
  }, { pretty: options.pretty });
  return identical ? EXIT.ok : EXIT.validationFindings;
}

interface ResolvedScenario {
  readonly kind: 'template' | 'instance';
  readonly input: SimScenarioInput;
  readonly bundle: MapBundle;
  readonly profile: ResolvedAmbientTrafficProfile;
  readonly sourceInputDigest: string;
}

async function resolveScenario(options: TrafficSumoOptions): Promise<ResolvedScenario> {
  const kind = await detectKind(options.file);
  if (kind === 'instance') {
    const instance = await readInstance(options.file);
    const bundle = await loadMap(instance.input.mapId);
    const controls = bundle.controlPlan();
    const signalIds = new Set(instance.input.signalPrograms.map((program) => program.id));
    const controlIds = new Set(instance.input.roadControls.map((control) => control.id));
    const input: SimScenarioInput = withClip({
      ...instance.input,
      // The native ambient population is replaced by SUMO, never mixed with it.
      actors: instance.input.actors.filter((actor) => !actor.tags.includes('ambient')),
      signalPrograms: [...instance.input.signalPrograms, ...controls.signalPrograms.filter((program) => !signalIds.has(program.id))],
      roadControls: [...instance.input.roadControls, ...controls.roadControls.filter((control) => !controlIds.has(control.id))],
    }, options.durationSeconds);
    return { kind, input, bundle, profile: profileFrom(undefined, options), sourceInputDigest: executionSourceInputDigest(input) };
  }
  const content = JSON.parse(await readFile(options.file, 'utf8')) as {
    anchor?: { pin?: { mapId?: string } };
    extensions?: Record<string, unknown>;
  };
  const mapId = content.anchor?.pin?.mapId;
  if (!mapId) throw new CliError('missing_option', 'traffic sumo needs a map-bound template or an instance', { path: options.file });
  const bundle = await loadMap(mapId);
  const resolved = resolveExecutionInput(content, bundle, 'sumo');
  const input = withClip(resolved.resolvedInput, options.durationSeconds);
  return {
    kind,
    input,
    bundle,
    profile: profileFrom(content.extensions, options),
    sourceInputDigest: executionSourceInputDigest(input),
  };
}

function withClip(input: SimScenarioInput, durationSeconds: number | undefined): SimScenarioInput {
  if (input.dt !== 0.02) {
    throw new CliError('bad_value', `SUMO traffic runs on the 0.02 s grid; this input uses dt=${input.dt}`, { path: 'dt' });
  }
  return durationSeconds === undefined ? input : { ...input, clipSeconds: durationSeconds };
}

function profileFrom(extensions: Record<string, unknown> | undefined, options: TrafficSumoOptions): ResolvedAmbientTrafficProfile {
  const authored = extensions ? ambientTrafficProfileFromExtensions(extensions) : null;
  const flags: Partial<AmbientTrafficProfile> = {
    ...(options.preset ? { preset: options.preset as AmbientTrafficProfile['preset'] } : {}),
    ...(options.seed ? { seed: options.seed } : {}),
    ...(options.maxActors !== undefined ? { maxActors: options.maxActors } : {}),
  };
  const base: AmbientTrafficProfile = authored && authored.preset !== 'off'
    ? authored
    : { version: 1, preset: 'city', seed: 'ambient-1' };
  return resolveAmbientTrafficProfile({ ...base, ...flags });
}
