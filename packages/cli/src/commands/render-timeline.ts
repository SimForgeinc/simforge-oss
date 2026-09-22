/**
 * `simforge render timeline|sample|parity` — the render timeline from the
 * command line (contract: `docs/engineering/render-timeline.md`).
 *
 * - `timeline` is the CPU timeline step: authoritative trace + map height
 *   source → canonical timeline bytes, keyed by
 *   `H(traceSha256, heightFieldDigest, catalogDigest, samplerVersion)`.
 * - `sample` prints `pose(timeline, actorId, t)` for one instant.
 * - `parity` grades a renderer's observed transforms (Bevy
 *   `observed-frames.jsonl`, CARLA observed transforms) against the shared
 *   sampler; a failing report exits 2.
 *
 * Every verb runs the same Rust functions as the editor, Bevy and CARLA.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import { ARTIFACTS, mapDir } from '@simforge-oss/compiler/node';
import {
  buildRenderTimeline, compareObserved, decodePose, openRenderTimeline, type ParityProfile,
} from '@simforge-oss/render/timeline';

import { boolFlag, optionalNumber, optionalString, parseArgs } from '../args.js';
import { CliError, EXIT } from '../errors.js';
import { emit } from '../output.js';

export const RENDER_TIMELINE_COMMANDS = ['timeline', 'sample', 'scene-state', 'parity'] as const;

export const RENDER_TIMELINE_HELP = [
  {
    name: 'timeline',
    summary: 'build the render timeline (the render contract) from an authoritative trace',
    usage: [
      'simforge render timeline <trace.json[.gz]> (--map <mapId> | --xodr <map.xodr> --topology <topology-index.json.gz>) [--catalog-digest <sha>] [--out <timeline.json[.gz]>]',
    ],
    notes: [
      'the xodr must be the one the trace was simulated on (sha256 = header.engineGraphDigest)',
      'the written bytes are canonicalJson(timeline): sha256(file) == timelineSha256 (before any .gz)',
    ],
  },
  {
    name: 'sample',
    summary: 'print pose(timeline, actorId, t) through the shared sampler',
    usage: ['simforge render sample <timeline.json[.gz]> --t <seconds> [--actor <id>]'],
  },
  {
    name: 'scene-state',
    summary: 'sample the timeline into a scene-state.v1 document at a fixed frame rate (scen-play, goldens)',
    usage: ['simforge render scene-state <timeline.json[.gz]> --fps <n> [--start <s>] [--end <s>] [--yaw-only] --out <scene-state.json>'],
    notes: ['frame k is sampled at start + k/fps; heights are the baked timeline z (play with scen-play --authored-height)'],
  },
  {
    name: 'parity',
    summary: 'grade observed per-frame transforms against the sampler (exit 2 on failure)',
    usage: [
      'simforge render parity <timeline.json[.gz]> <observed-frames.jsonl> [--profile bevy|carla] [--profile-json <file>] [--out <report.json>]',
    ],
    notes: ['bevy: <= 1e-3 m / 0.05 deg, scene-yup; carla: <= 1 cm / 0.1 deg, xodr-local'],
  },
] as const;

function readBytes(file: string): Uint8Array {
  try {
    return readFileSync(file);
  } catch (error) {
    throw new CliError('missing_file', `cannot read ${file}`, { path: file, detail: { error: String(error) } });
  }
}

async function timelineCommand(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, {
    booleans: ['pretty'],
    values: ['map', 'xodr', 'topology', 'catalog-digest', 'out'],
  });
  const tracePath = args.positionals[0];
  if (!tracePath || args.positionals.length !== 1) {
    throw new CliError('missing_argument', 'simforge render timeline requires one trace file');
  }
  const map = optionalString(args, 'map');
  let xodrPath = optionalString(args, 'xodr');
  let topologyPath = optionalString(args, 'topology');
  if (map) {
    if (xodrPath || topologyPath) throw new CliError('bad_value', 'pass --map or --xodr/--topology, not both');
    const dir = mapDir(map);
    xodrPath = path.join(dir, 'map.xodr');
    topologyPath = path.join(dir, ARTIFACTS.topology);
  }
  if (!xodrPath || !topologyPath) {
    throw new CliError('missing_argument', 'the height source needs --map <mapId> or both --xodr and --topology');
  }
  let result;
  try {
    result = await buildRenderTimeline({
      trace: readBytes(tracePath),
      xodr: readBytes(xodrPath),
      topology: readBytes(topologyPath),
      catalogDigest: optionalString(args, 'catalog-digest') ?? null,
    });
  } catch (error) {
    throw new CliError('timeline_rejected', error instanceof Error ? error.message : String(error), {
      path: tracePath, exitCode: EXIT.validationFindings,
    });
  }
  const out = optionalString(args, 'out');
  if (out) writeFileSync(out, out.endsWith('.gz') ? gzipSync(result.bytes) : result.bytes);
  const { bytes, ...identity } = result;
  emit({ ...identity, byteLength: bytes.byteLength, ...(out ? { out } : {}) }, { pretty: boolFlag(args, 'pretty') });
  return EXIT.ok;
}

async function sampleCommand(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, { booleans: ['pretty'], values: ['t', 'actor'] });
  const file = args.positionals[0];
  const t = optionalNumber(args, 't');
  if (!file || args.positionals.length !== 1 || t === undefined) {
    throw new CliError('missing_argument', 'simforge render sample requires one timeline file and --t <seconds>');
  }
  const timeline = await openRenderTimeline(readBytes(file));
  try {
    const actor = optionalString(args, 'actor');
    const ids = actor ? [actor] : timeline.actorIds;
    const poses = Object.fromEntries(ids.map((id) => [id, decodePose(timeline.poseArray(id, t))]));
    emit({
      timelineKey: timeline.key, timelineSha256: timeline.sha256, t,
      signals: JSON.parse(timeline.signalsAtJson(t)) as unknown, poses,
    }, { pretty: boolFlag(args, 'pretty') });
  } catch (error) {
    throw new CliError('sample_rejected', error instanceof Error ? error.message : String(error), { exitCode: EXIT.validationFindings });
  } finally {
    timeline.free();
  }
  return EXIT.ok;
}

async function sceneStateCommand(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, { booleans: ['pretty', 'yaw-only'], values: ['fps', 'start', 'end', 'out'] });
  const file = args.positionals[0];
  const fps = optionalNumber(args, 'fps');
  const out = optionalString(args, 'out');
  if (!file || args.positionals.length !== 1 || fps === undefined || !out) {
    throw new CliError('missing_argument', 'simforge render scene-state requires one timeline file, --fps and --out');
  }
  if (!(fps > 0)) throw new CliError('bad_value', '--fps must be positive', { path: '--fps' });
  const timeline = await openRenderTimeline(readBytes(file));
  try {
    const start = optionalNumber(args, 'start') ?? 0;
    const end = optionalNumber(args, 'end') ?? timeline.clipEndS;
    const micros: number[] = [];
    for (let k = 0; ; k += 1) {
      const us = Math.round(start * 1_000_000) + Math.round((k * 1_000_000) / fps);
      if (us > Math.round(end * 1_000_000)) break;
      micros.push(us);
    }
    const times = Float64Array.from(micros, (us) => us / 1_000_000);
    writeFileSync(out, timeline.sceneStateJson(times, boolFlag(args, 'yaw-only')));
    emit({ timelineSha256: timeline.sha256, frames: times.length, fps, start, end, out }, { pretty: boolFlag(args, 'pretty') });
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError('scene_state_rejected', error instanceof Error ? error.message : String(error), { exitCode: EXIT.validationFindings });
  } finally {
    timeline.free();
  }
  return EXIT.ok;
}

async function parityCommand(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, { booleans: ['pretty'], values: ['profile', 'profile-json', 'out'] });
  const [timelineFile, observedFile] = args.positionals;
  if (!timelineFile || !observedFile || args.positionals.length !== 2) {
    throw new CliError('missing_argument', 'simforge render parity requires a timeline file and an observed-frames JSONL file');
  }
  const profileJson = optionalString(args, 'profile-json');
  const named = optionalString(args, 'profile') ?? 'bevy';
  if (!profileJson && named !== 'bevy' && named !== 'carla') {
    throw new CliError('bad_value', '--profile must be bevy or carla', { path: '--profile' });
  }
  const profile: 'bevy' | 'carla' | ParityProfile = profileJson
    ? JSON.parse(readFileSync(profileJson, 'utf8')) as ParityProfile
    : named as 'bevy' | 'carla';
  const timeline = await openRenderTimeline(readBytes(timelineFile));
  let report;
  try {
    report = compareObserved(timeline, readFileSync(observedFile, 'utf8'), profile);
  } catch (error) {
    throw new CliError('parity_rejected', error instanceof Error ? error.message : String(error), { exitCode: EXIT.validationFindings });
  } finally {
    timeline.free();
  }
  const out = optionalString(args, 'out');
  if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  emit(report, { pretty: boolFlag(args, 'pretty') });
  return report.pass ? EXIT.ok : EXIT.validationFindings;
}

export function renderTimelineCommand(argv: readonly string[]): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case 'timeline': return timelineCommand(rest);
    case 'sample': return sampleCommand(rest);
    case 'scene-state': return sceneStateCommand(rest);
    case 'parity': return parityCommand(rest);
    default: throw new CliError('unknown_command', `unknown render timeline verb ${String(sub)}`);
  }
}
