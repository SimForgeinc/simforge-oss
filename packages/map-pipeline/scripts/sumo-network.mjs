/**
 * SUMO road-network derivative: OpenDRIVE -> `derived/sumo/*`.
 *
 * One producer for every surface that needs ambient SUMO traffic (map
 * pipeline, registry backfills, SimCloud reconciliation, CI smoke). The output
 * is a pure function of the OpenDRIVE bytes, the logical map identity, the
 * pinned SUMO toolchain and SUMO_DERIVATIVE_REVISION, so the same inputs
 * always produce byte-identical files and the same `buildKey`.
 *
 * A build is published only when it passes the validation gates below. A
 * failed gate throws `SumoBuildError` carrying the full report, so callers can
 * surface the reason instead of silently shipping a map without traffic.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';

const run = promisify(execFile);

/** Bump when netconvert options, route generation or gates change output. */
export const SUMO_DERIVATIVE_REVISION = 'sumo-derivative-v2';
/** Must equal the browser/CLI WebAssembly runtime (`SumoRuntimeManifest.sumoVersion`). */
export const SUMO_VERSION = '1.27.1';
export const SUMO_NETWORK_SCHEMA = 'uniscenarios.sumo-network.v1';
export const SUMO_BUILD_REPORT_SCHEMA = 'simforge.sumo-build-report.v1';
export const SUMO_DERIVED_DIR = 'derived/sumo';
export const SUMO_MEMBER_FILES = Object.freeze({
  network: 'map.net.xml',
  manifest: 'sumo-network-manifest.json',
  report: 'sumo-build-report.json',
});
const ROUTE_SEED = 2711;
/** Lanes shorter than this (section-split slivers) are neither registered nor scored. */
const MIN_ALIGNED_LANE_M = 1;
const MAX_ROUTE_CANDIDATES = 256;
export const MIN_ROUTE_CANDIDATES = 16;

/**
 * OpenDRIVE import options. Keep this list the single source of truth: it is
 * part of the build key, so changing it rebuilds every map.
 *
 * - internal-shapes: junction lanes follow the authored connecting roads, so
 *   turning vehicles stay on the painted turn paths of the 3D map.
 * - curve-resolution 1 m: curved lanes stay within centimetres of the scene.
 * - signal-groups: signal programs follow the OpenDRIVE controllers, so heads
 *   that belong to one controller switch together.
 * - junctions.join / geometry.remove off: one SUMO junction per OpenDRIVE
 *   junction and untouched geometry, which keeps ids and shapes traceable.
 * - no-turnarounds: SUMO otherwise invents U-turn connections that no lane in
 *   the scene provides.
 * - type-files (SUMO_TYPEMAP_PATH, added at run time): parking lanes are
 *   discarded so traffic never drives through parked-car stalls.
 * - output.original-names: every lane keeps its OpenDRIVE `road_lane` id,
 *   which lane registration (below) and audits rely on.
 */
/** Lane typemap passed with type-files; its bytes are part of the build key. */
export const SUMO_TYPEMAP_PATH = fileURLToPath(new URL('./sumo-opendrive.typ.xml', import.meta.url));
const SUMO_TYPEMAP_SHA256 = createHash('sha256').update(readFileSync(SUMO_TYPEMAP_PATH)).digest('hex');

export const NETCONVERT_OPENDRIVE_OPTIONS = Object.freeze([
  '--opendrive.import-all-lanes', 'false',
  '--opendrive.internal-shapes', 'true',
  '--opendrive.curve-resolution', '1',
  '--opendrive.signal-groups', 'true',
  '--geometry.remove', 'false',
  '--junctions.join', 'false',
  '--no-turnarounds', 'true',
  '--offset.disable-normalization', 'false',
  '--output.street-names', 'false',
  '--output.original-names', 'true',
  '--xml-validation', 'never',
]);

/** Gate thresholds; part of the build key. */
export const SUMO_GATES = Object.freeze({
  /** Normal SUMO lane centerlines vs OpenDRIVE driving-lane centerlines (m). */
  laneOffsetP95M: 0.35,
  laneOffsetMaxM: 1.5,
  /**
   * Junction (internal) lanes vs OpenDRIVE lanes (m): the median proves the
   * junctions connect the registered lanes; a long tail (movements SUMO adds
   * without a connecting road) is reported, not fatal.
   */
  internalOffsetP50M: 0.5,
  internalOffsetP95WarnM: 1.0,
  /** Share of OpenDRIVE driving-lane length that has a SUMO lane nearby. */
  laneCoverageMin: 0.9,
  laneCoverageToleranceM: 0.75,
  /** Simulated vehicle reference points vs OpenDRIVE driving lanes (m). */
  vehicleOffsetP95M: 1.0,
  simulationVehicles: 64,
  simulationSeconds: 120,
  simulationStepSeconds: 0.05,
  /** Share of simulated vehicles that must have travelled at least 20 m. */
  movingVehicleShareMin: 0.5,
  maxTeleports: 2,
});

/** Full netconvert argument vector for one OpenDRIVE input. */
export function netconvertArguments(xodrPath, outputPath) {
  return ['--opendrive-files', xodrPath, '--output-file', outputPath, '--type-files', SUMO_TYPEMAP_PATH, ...NETCONVERT_OPENDRIVE_OPTIONS];
}

/**
 * Everything that determines derivative bytes apart from the map itself.
 * Pipelines fold it into their stage keys so a toolchain or option change
 * rebuilds every map; `resolveSumoToolchain` reports the same value.
 */
export const SUMO_DERIVATIVE_FINGERPRINT = sha256Static({ sumo: SUMO_VERSION, revision: SUMO_DERIVATIVE_REVISION, options: NETCONVERT_OPENDRIVE_OPTIONS, typemap: SUMO_TYPEMAP_SHA256, gates: SUMO_GATES });
function sha256Static(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export class SumoBuildError extends Error {
  constructor(code, message, report) {
    super(message);
    this.name = 'SumoBuildError';
    this.code = code;
    this.report = report;
  }
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function atomicWrite(file, bytes) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  await writeFile(temporary, bytes);
  await rename(temporary, file);
}

// ── Toolchain ────────────────────────────────────────────────────────────────

function toolchainCandidates(env, repository) {
  const dataHome = env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  const roots = [
    env.SIMFORGE_SUMO_BIN ? { bin: env.SIMFORGE_SUMO_BIN, source: 'SIMFORGE_SUMO_BIN' } : null,
    env.SIMFORGE_SUMO_TOOLCHAIN ? { bin: path.join(env.SIMFORGE_SUMO_TOOLCHAIN, 'bin'), source: 'SIMFORGE_SUMO_TOOLCHAIN' } : null,
    repository ? { bin: path.join(repository, '.tools', 'sumo', SUMO_VERSION, 'bin'), source: 'repository .tools' } : null,
    { bin: path.join(dataHome, 'simforge', 'toolchains', `sumo-${SUMO_VERSION}`, 'bin'), source: 'XDG data toolchain' },
  ].filter(Boolean);
  return [...roots.map((root) => ({ command: path.join(root.bin, 'netconvert'), source: root.source })), { command: 'netconvert', source: 'PATH' }];
}

/**
 * Locate the pinned netconvert. Anything but exactly SUMO_VERSION is rejected:
 * a network written by another netconvert is not guaranteed to load in the
 * pinned WebAssembly runtime, and it changes the build key.
 */
export async function resolveSumoToolchain({ env = process.env, repository } = {}) {
  const tried = [];
  for (const candidate of toolchainCandidates(env, repository)) {
    if (candidate.command !== 'netconvert' && !existsSync(candidate.command)) continue;
    let output;
    try {
      const result = await run(candidate.command, ['--version'], { maxBuffer: 4 * 1024 * 1024, env: { ...env, SUMO_HOME: '' } });
      output = `${result.stdout}\n${result.stderr}`;
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      output = `${error?.stdout ?? ''}\n${error?.stderr ?? ''}`;
    }
    const version = /Eclipse SUMO netconvert (?:Version )?v?([0-9][^\s]*)/.exec(output)?.[1] ?? null;
    tried.push({ command: candidate.command, source: candidate.source, version });
    if (version === SUMO_VERSION) {
      return {
        netconvert: candidate.command,
        source: candidate.source,
        version,
        fingerprint: SUMO_DERIVATIVE_FINGERPRINT,
      };
    }
  }
  const found = tried.map((entry) => `${entry.command} (${entry.source}): ${entry.version ?? 'unreadable version'}`).join('; ');
  throw new SumoBuildError(
    'sumo_toolchain_missing',
    `SUMO netconvert ${SUMO_VERSION} is required to build SUMO derivatives${found ? `; found ${found}` : '; none found'}. `
      + 'Install it with `pnpm maps:sumo:toolchain` or point SIMFORGE_SUMO_TOOLCHAIN at an eclipse-sumo==1.27.1 environment.',
    null,
  );
}

/** Identity of one derivative build. Same key <=> byte-identical outputs. */
export function sumoBuildKey({ xodrSha256, mapId, sourceMapId }) {
  return sha256(canonicalJson({
    schema: SUMO_NETWORK_SCHEMA, xodrSha256, mapId, sourceMapId: sourceMapId ?? mapId,
    sumo: SUMO_VERSION, revision: SUMO_DERIVATIVE_REVISION, options: NETCONVERT_OPENDRIVE_OPTIONS,
    typemap: SUMO_TYPEMAP_SHA256, routeSeed: ROUTE_SEED, gates: SUMO_GATES,
  }));
}

// ── Network parsing ─────────────────────────────────────────────────────────

const attr = (source, name) => {
  const match = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(source);
  return match ? decodeXml(match[1]) : undefined;
};

function decodeXml(value) {
  return value.replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}

function parseShape(shape) {
  if (!shape) return [];
  return shape.trim().split(/\s+/).map((pair) => pair.split(',').map(Number)).filter((point) => Number.isFinite(point[0]) && Number.isFinite(point[1]));
}

const PASSENGER_EXCLUDED = /\bpassenger\b/;
function allowsPassenger(laneAttributes) {
  const allow = attr(laneAttributes, 'allow');
  const disallow = attr(laneAttributes, 'disallow');
  if (allow !== undefined) return allow === 'all' || /\bpassenger\b/.test(allow);
  if (disallow !== undefined) return !PASSENGER_EXCLUDED.test(disallow) && disallow !== 'all';
  return true;
}

/** Minimal, dependency-free reader for netconvert output. */
export function parseSumoNetwork(xml) {
  const location = /<location\s+([^>]*)\/>/.exec(xml)?.[1] ?? '';
  const netOffset = (attr(location, 'netOffset') ?? '0,0').split(',').map(Number);
  const edges = new Map();
  for (const match of xml.matchAll(/<edge\s+([^>]*?)(\/>|>([\s\S]*?)<\/edge>)/g)) {
    const attributes = match[1];
    const id = attr(attributes, 'id');
    const edge = { id, function: attr(attributes, 'function') ?? 'normal', from: attr(attributes, 'from'), to: attr(attributes, 'to'), lanes: [] };
    for (const lane of (match[3] ?? '').matchAll(/<lane\s+([^>]*?)\/?>/g)) {
      edge.lanes.push({
        id: attr(lane[1], 'id'), index: Number(attr(lane[1], 'index')), speed: Number(attr(lane[1], 'speed')),
        length: Number(attr(lane[1], 'length')), passenger: allowsPassenger(lane[1]), shape: parseShape(attr(lane[1], 'shape')),
      });
    }
    edges.set(id, edge);
  }
  const connections = [];
  for (const match of xml.matchAll(/<connection\s+([^>]*?)\/?>/g)) {
    connections.push({
      from: attr(match[1], 'from'), to: attr(match[1], 'to'),
      fromLane: Number(attr(match[1], 'fromLane')), toLane: Number(attr(match[1], 'toLane')),
      via: attr(match[1], 'via'), tl: attr(match[1], 'tl'), linkIndex: attr(match[1], 'linkIndex') === undefined ? undefined : Number(attr(match[1], 'linkIndex')),
    });
  }
  const trafficLights = [];
  for (const match of xml.matchAll(/<tlLogic\s+([^>]*)>([\s\S]*?)<\/tlLogic>/g)) {
    const phases = [...match[2].matchAll(/<phase\s+([^>]*?)\/>/g)].map((phase) => ({ duration: Number(attr(phase[1], 'duration')), state: attr(phase[1], 'state') ?? '' }));
    const linkSignals = new Map();
    for (const param of match[2].matchAll(/<param\s+([^>]*?)\/>/g)) {
      const index = /^linkSignalID:(\d+)$/.exec(attr(param[1], 'key') ?? '')?.[1];
      if (index !== undefined) linkSignals.set(Number(index), (attr(param[1], 'value') ?? '').split(/\s+/).filter(Boolean));
    }
    trafficLights.push({ id: attr(match[1], 'id'), type: attr(match[1], 'type'), phases, linkSignals });
  }
  const junctions = [];
  for (const match of xml.matchAll(/<junction\s+([^>]*?)\/?>/g)) {
    junctions.push({ id: attr(match[1], 'id'), type: attr(match[1], 'type') });
  }
  return {
    location: {
      netOffset: attr(location, 'netOffset') ?? '0,0', convBoundary: attr(location, 'convBoundary') ?? '',
      origBoundary: attr(location, 'origBoundary') ?? '', projParameter: attr(location, 'projParameter') ?? '',
    },
    netOffset: [netOffset[0] || 0, netOffset[1] || 0],
    edges, connections, trafficLights, junctions,
  };
}

export function normalizeNetconvertXml(bytes) {
  const xml = Buffer.from(bytes).toString('utf8');
  const net = xml.indexOf('<net ');
  if (net < 0) throw new SumoBuildError('sumo_network_invalid', 'netconvert output has no <net> root', null);
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n\n${xml.slice(net).trim()}\n`);
}

// ── Deterministic demand ────────────────────────────────────────────────────

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Seeded origin/destination routes over passenger-drivable edges, shortest by
 * free-flow travel time. Replaces randomTrips.py/duarouter so builds need no
 * Python at run time and are reproducible from the network alone.
 */
export function generateRouteCandidates(network, { seed = ROUTE_SEED, limit = MAX_ROUTE_CANDIDATES, minDistanceM = 35 } = {}) {
  const drivable = [...network.edges.values()]
    .filter((edge) => edge.function === 'normal' && edge.lanes.some((lane) => lane.passenger))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const byId = new Map(drivable.map((edge) => [edge.id, edge]));
  const successors = new Map(drivable.map((edge) => [edge.id, new Set()]));
  const incoming = new Map(drivable.map((edge) => [edge.id, 0]));
  for (const connection of network.connections) {
    const from = byId.get(connection.from);
    const to = byId.get(connection.to);
    if (!from || !to || connection.from === connection.to) continue;
    if (!from.lanes[connection.fromLane]?.passenger || !to.lanes[connection.toLane]?.passenger) continue;
    if (!successors.get(from.id).has(to.id)) {
      successors.get(from.id).add(to.id);
      incoming.set(to.id, incoming.get(to.id) + 1);
    }
  }
  const cost = (edge) => {
    const lane = edge.lanes.find((candidate) => candidate.passenger) ?? edge.lanes[0];
    return Math.max(0.1, (lane?.length ?? 1) / Math.max(1, lane?.speed ?? 13.9));
  };
  const length = (edge) => (edge.lanes.find((candidate) => candidate.passenger) ?? edge.lanes[0])?.length ?? 0;
  const sources = drivable.filter((edge) => incoming.get(edge.id) === 0 && successors.get(edge.id).size > 0);
  const sinks = drivable.filter((edge) => successors.get(edge.id).size === 0 && incoming.get(edge.id) > 0);
  const trees = new Map();
  const tree = (origin) => {
    if (trees.has(origin)) return trees.get(origin);
    const distance = new Map([[origin, 0]]);
    const previous = new Map();
    const settled = new Set();
    // Graphs are at most a few thousand edges: a linear-scan frontier is fast and order-stable.
    const frontier = new Set([origin]);
    while (frontier.size > 0) {
      let best = null;
      for (const id of frontier) if (best === null || distance.get(id) < distance.get(best) || (distance.get(id) === distance.get(best) && id < best)) best = id;
      frontier.delete(best);
      settled.add(best);
      for (const next of [...successors.get(best)].sort()) {
        if (settled.has(next)) continue;
        const candidate = distance.get(best) + cost(byId.get(next));
        if (!distance.has(next) || candidate < distance.get(next)) {
          distance.set(next, candidate);
          previous.set(next, best);
          frontier.add(next);
        }
      }
    }
    const result = { distance, previous };
    trees.set(origin, result);
    return result;
  };
  const random = mulberry32(seed);
  const pick = (preferred, fallback) => {
    const pool = preferred.length > 0 && random() < 0.8 ? preferred : fallback;
    return pool[Math.floor(random() * pool.length)];
  };
  const routes = [];
  const seen = new Set();
  const attempts = Math.max(400, limit * 12);
  for (let attempt = 0; attempt < attempts && routes.length < limit && drivable.length > 1; attempt += 1) {
    const origin = pick(sources, drivable);
    const destination = pick(sinks, drivable);
    if (!origin || !destination || origin.id === destination.id) continue;
    const { previous, distance } = tree(origin.id);
    if (!distance.has(destination.id)) continue;
    const edges = [destination.id];
    while (edges[0] !== origin.id) edges.unshift(previous.get(edges[0]));
    const meters = edges.reduce((sum, id) => sum + length(byId.get(id)), 0);
    if (edges.length < 2 || meters < minDistanceM) continue;
    const key = edges.join(' ');
    if (seen.has(key)) continue;
    seen.add(key);
    routes.push(edges);
  }
  // Small maps can have fewer distinct fringe-to-fringe routes than the
  // demand floor; count them so the gate asks only for what exists.
  let reachableFringePairs = null;
  if (routes.length < MIN_ROUTE_CANDIDATES) {
    reachableFringePairs = 0;
    for (const source of sources) {
      const { distance } = tree(source.id);
      for (const sink of sinks) if (sink.id !== source.id && distance.has(sink.id)) reachableFringePairs += 1;
    }
  }
  return { routes, drivableEdges: drivable.length, sourceEdges: sources.length, sinkEdges: sinks.length, reachableFringePairs };
}

// ── OpenDRIVE reference (driving lanes and signals) ─────────────────────────

const DRIVING_LANE_TYPES = new Set(['driving', 'entry', 'exit', 'onRamp', 'offRamp', 'connectingRamp', 'bidirectional']);

/**
 * Driving-lane centerlines in OpenDRIVE coordinates, from the topology index
 * the map pipeline already derives (the same lanes the editor draws).
 */
export function drivingLanesFromTopology(topology) {
  const lanes = [];
  for (const [rsl, lane] of Object.entries(topology?.lanes ?? {})) {
    if (!DRIVING_LANE_TYPES.has(lane.laneType)) continue;
    const points = (lane.polyline ?? []).map((point) => [point.x, point.y]).filter((point) => Number.isFinite(point[0]) && Number.isFinite(point[1]));
    if (points.length >= 2) lanes.push({ rsl, junction: Boolean(lane.isJunction), points });
  }
  return lanes;
}

/**
 * A traffic-light head: dynamic, or a German-catalogue light (`1000xxx`) that
 * some exporters (RoadRunner with dynamic="no") leave static. netconvert builds
 * traffic lights from both, so both must be accounted for.
 */
function isSignalHead(signalAttributes) {
  return attr(signalAttributes, 'dynamic') === 'yes' || /^1000\d{3}$/.test(attr(signalAttributes, 'type') ?? '');
}

function validityOf(body) {
  const validity = /<validity\s+([^>]*?)\/>/.exec(body ?? '')?.[1];
  if (!validity) return null;
  const from = Number(attr(validity, 'fromLane'));
  const to = Number(attr(validity, 'toLane'));
  // fromLane=toLane=0 (the centre lane) is how several exporters say "all lanes".
  return Number.isFinite(from) && Number.isFinite(to) && !(from === 0 && to === 0) ? [Math.min(from, to), Math.max(from, to)] : null;
}

/**
 * OpenDRIVE traffic-light heads. `junctionHeads` holds heads that sit on (or
 * are referenced from) a junction's connecting roads, which unambiguously
 * belong to that junction; `roadHeads` maps every road to the heads that
 * govern it, with their lane validity.
 */
export function signalHeadsFromXodr(xodrXml) {
  const junctionHeads = new Map();
  const heads = new Set();
  const roads = [];
  for (const match of xodrXml.matchAll(/<road\s+([^>]*)>([\s\S]*?)<\/road>/g)) {
    const signalBlock = /<signals>([\s\S]*?)<\/signals>/.exec(match[2])?.[1] ?? '';
    const own = [];
    for (const signal of signalBlock.matchAll(/<signal\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/signal>)/g)) {
      if (!isSignalHead(signal[1])) continue;
      const id = attr(signal[1], 'id');
      heads.add(id);
      own.push({ id, validity: validityOf(signal[2]) });
    }
    const references = [...signalBlock.matchAll(/<signalReference\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/signalReference>)/g)]
      .map((reference) => ({ id: attr(reference[1], 'id'), validity: validityOf(reference[2]) }));
    roads.push({ id: attr(match[1], 'id'), junction: attr(match[1], 'junction') ?? '-1', own, references });
  }
  const roadHeads = new Map();
  for (const road of roads) {
    const governing = [...road.own, ...road.references.filter((reference) => heads.has(reference.id))];
    if (governing.length === 0) continue;
    roadHeads.set(road.id, governing);
    if (road.junction === '-1') continue;
    if (!junctionHeads.has(road.junction)) junctionHeads.set(road.junction, new Set());
    for (const head of governing) junctionHeads.get(road.junction).add(head.id);
  }
  return { heads, junctionHeads, roadHeads };
}

/**
 * Complete netconvert's link -> head provenance. For a controlled link whose
 * `linkSignalID` is missing, the heads on (or referenced from) the connecting
 * road its internal lane was built from are the heads that show its state -
 * the same rule netconvert applies to heads it recognises.
 */
export function bindSignalHeads(networkXml, xodrXml) {
  const { roadHeads } = signalHeadsFromXodr(xodrXml);
  // OpenDRIVE junction table: incoming road/lane -> connecting road/lane, and
  // each road's neighbours, for movements whose internal lane has no origId.
  const roadLinks = new Map();
  for (const match of xodrXml.matchAll(/<road\s+([^>]*)>([\s\S]*?)<\/road>/g)) {
    const link = /<link>([\s\S]*?)<\/link>/.exec(match[2])?.[1] ?? '';
    const neighbours = [...link.matchAll(/<(?:predecessor|successor)\s+([^>]*?)\/>/g)]
      .filter((element) => attr(element[1], 'elementType') === 'road').map((element) => attr(element[1], 'elementId'));
    roadLinks.set(attr(match[1], 'id'), new Set(neighbours));
  }
  const junctionConnections = [];
  for (const junction of xodrXml.matchAll(/<junction\s+([^>]*)>([\s\S]*?)<\/junction>/g)) {
    for (const connection of junction[2].matchAll(/<connection\s+([^>]*)>([\s\S]*?)<\/connection>/g)) {
      junctionConnections.push({
        incoming: attr(connection[1], 'incomingRoad'), connecting: attr(connection[1], 'connectingRoad'),
        laneLinks: [...connection[2].matchAll(/<laneLink\s+([^>]*?)\/>/g)].map((laneLink) => ({ from: Number(attr(laneLink[1], 'from')), to: Number(attr(laneLink[1], 'to')) })),
      });
    }
  }
  const laneOrigin = new Map();
  for (const match of networkXml.matchAll(/<lane id="([^"]*)"[^>]*>\s*<param key="origId" value="([^"]*)"\/>/g)) laneOrigin.set(match[1], match[2]);
  const split = (origin) => ({ road: origin.slice(0, origin.lastIndexOf('_')), lane: Number(origin.slice(origin.lastIndexOf('_') + 1)) });
  const roadOf = (edgeId) => edgeId.replace(/^-/, '').replace(/#\d+$/, '');
  const governingHeads = (road, lane) => (roadHeads.get(road) ?? []).filter((head) => !head.validity || (lane >= head.validity[0] && lane <= head.validity[1]));
  const linkHeads = new Map();
  for (const match of networkXml.matchAll(/<connection\s+([^>]*?)\/?>/g)) {
    const tl = attr(match[1], 'tl');
    const linkIndex = attr(match[1], 'linkIndex');
    const via = attr(match[1], 'via');
    if (tl === undefined || linkIndex === undefined) continue;
    let governing = [];
    const origin = via ? laneOrigin.get(via) : undefined;
    if (origin) {
      const { road, lane } = split(origin);
      governing = governingHeads(road, lane);
    }
    if (governing.length === 0) {
      const from = attr(match[1], 'from');
      const to = attr(match[1], 'to');
      const fromOrigin = laneOrigin.get(`${from}_${attr(match[1], 'fromLane')}`);
      if (from && to && fromOrigin) {
        const incoming = split(fromOrigin);
        const outgoing = roadOf(to);
        for (const candidate of junctionConnections) {
          if (candidate.incoming !== incoming.road || !(roadLinks.get(candidate.connecting)?.has(outgoing))) continue;
          for (const laneLink of candidate.laneLinks) {
            if (laneLink.from === incoming.lane) governing = governing.concat(governingHeads(candidate.connecting, laneLink.to));
          }
        }
      }
    }
    if (governing.length === 0) continue;
    const key = `${tl}\u0000${linkIndex}`;
    if (!linkHeads.has(key)) linkHeads.set(key, new Set());
    for (const head of governing) linkHeads.get(key).add(head.id);
  }
  let inferred = 0;
  const xml = networkXml.replace(/(<tlLogic\s+[^>]*\bid="([^"]*)"[^>]*>)([\s\S]*?)(\s*<\/tlLogic>)/g, (whole, open, id, body, close) => {
    const existing = new Set([...body.matchAll(/key="linkSignalID:(\d+)"/g)].map((match) => Number(match[1])));
    const links = (/state="([^"]*)"/.exec(body)?.[1] ?? '').length;
    const additions = [];
    for (let index = 0; index < links; index += 1) {
      if (existing.has(index)) continue;
      const found = linkHeads.get(`${id}\u0000${index}`);
      if (!found || found.size === 0) continue;
      additions.push(`        <param key="linkSignalID:${index}" value="${[...found].sort().join(' ')}"/>`);
      inferred += 1;
    }
    return additions.length === 0 ? whole : `${open}${body}\n${additions.join('\n')}${close}`;
  });
  return { xml, inferredLinks: inferred };
}

// ── Geometry ────────────────────────────────────────────────────────────────

class SegmentIndex {
  constructor(polylines, cell = 8) {
    this.cell = cell;
    this.grid = new Map();
    this.segments = [];
    for (const polyline of polylines) {
      for (let index = 1; index < polyline.length; index += 1) {
        const a = polyline[index - 1];
        const b = polyline[index];
        const id = this.segments.push([a[0], a[1], b[0], b[1]]) - 1;
        const [minX, maxX] = [Math.min(a[0], b[0]), Math.max(a[0], b[0])];
        const [minY, maxY] = [Math.min(a[1], b[1]), Math.max(a[1], b[1])];
        for (let gx = Math.floor(minX / cell); gx <= Math.floor(maxX / cell); gx += 1) {
          for (let gy = Math.floor(minY / cell); gy <= Math.floor(maxY / cell); gy += 1) {
            const key = `${gx},${gy}`;
            if (!this.grid.has(key)) this.grid.set(key, []);
            this.grid.get(key).push(id);
          }
        }
      }
    }
  }

  /** Distance to the nearest segment, searching rings up to `maxDistance`. */
  nearest(x, y, maxDistance = 25) {
    let best = Infinity;
    const gx = Math.floor(x / this.cell);
    const gy = Math.floor(y / this.cell);
    const rings = Math.ceil(maxDistance / this.cell);
    for (let ring = 0; ring <= rings; ring += 1) {
      for (let dx = -ring; dx <= ring; dx += 1) {
        for (let dy = -ring; dy <= ring; dy += 1) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          for (const id of this.grid.get(`${gx + dx},${gy + dy}`) ?? []) {
            const [ax, ay, bx, by] = this.segments[id];
            const vx = bx - ax; const vy = by - ay;
            const lengthSquared = vx * vx + vy * vy;
            const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / lengthSquared));
            best = Math.min(best, Math.hypot(x - (ax + t * vx), y - (ay + t * vy)));
          }
        }
      }
      if (best <= ring * this.cell) break;
    }
    return best;
  }
}

function resample(points, step) {
  const out = [];
  for (let index = 1; index < points.length; index += 1) {
    const [ax, ay] = points[index - 1];
    const [bx, by] = points[index];
    const length = Math.hypot(bx - ax, by - ay);
    const count = Math.max(1, Math.ceil(length / step));
    for (let sample = 0; sample < count; sample += 1) out.push([ax + ((bx - ax) * sample) / count, ay + ((by - ay) * sample) / count, length / count]);
  }
  const last = points.at(-1);
  if (last) out.push([last[0], last[1], 0]);
  return out;
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]);
}

const round = (value, digits = 3) => (value === null || value === undefined || !Number.isFinite(value) ? value : Math.round(value * 10 ** digits) / 10 ** digits);

// ── Lane registration ───────────────────────────────────────────────────────

function polylineLength(points) {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) total += Math.hypot(points[index][0] - points[index - 1][0], points[index][1] - points[index - 1][1]);
  return total;
}

/** Arc-length parameter of the point on `points` nearest to (x, y). */
function project(points, x, y) {
  let best = { distance: Infinity, at: 0 };
  let travelled = 0;
  for (let index = 1; index < points.length; index += 1) {
    const [ax, ay] = points[index - 1];
    const [bx, by] = points[index];
    const vx = bx - ax; const vy = by - ay;
    const lengthSquared = vx * vx + vy * vy;
    const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / lengthSquared));
    const distance = Math.hypot(x - (ax + t * vx), y - (ay + t * vy));
    if (distance < best.distance) best = { distance, at: travelled + t * Math.sqrt(lengthSquared) };
    travelled += Math.sqrt(lengthSquared);
  }
  return best;
}

function slice(points, from, to) {
  const out = [];
  let travelled = 0;
  const at = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1];
    const b = points[index];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const start = travelled;
    const end = travelled + length;
    if (end >= from && start <= to && length > 0) {
      if (out.length === 0) out.push(at(a, b, Math.max(0, (from - start) / length)));
      if (end <= to) out.push(b);
      else { out.push(at(a, b, (to - start) / length)); break; }
    }
    travelled = end;
  }
  return out.filter((point, index) => index === 0 || Math.hypot(point[0] - out[index - 1][0], point[1] - out[index - 1][1]) > 1e-3);
}

/**
 * Snap every normal SUMO lane onto the scene's OpenDRIVE lane centerline.
 *
 * netconvert lays lanes out with the width at the start of each lane section,
 * so variable-width lanes (flares, turn-bay tapers) and lanes next to
 * discarded lane types drift metres away from the lanes the 3D map shows.
 * Each lane's `origId` (`road_lane`) names its OpenDRIVE lane; its shape is
 * replaced by that lane's topology centerline between the projections of the
 * original endpoints. `length` is left alone, so SUMO keeps its kinematics and
 * maps positions onto the registered geometry. Lanes that cannot be matched
 * unambiguously keep netconvert's geometry and are reported.
 */
export function registerLaneShapes(networkXml, topology, netOffset) {
  const [offsetX, offsetY] = netOffset;
  const byRoadLane = new Map();
  for (const [rsl, lane] of Object.entries(topology?.lanes ?? {})) {
    const [road, section, laneId] = rsl.split(':');
    if (!DRIVING_LANE_TYPES.has(lane.laneType)) continue;
    const points = (lane.polyline ?? []).map((point) => [point.x, point.y]).filter((point) => Number.isFinite(point[0]) && Number.isFinite(point[1]));
    if (points.length < 2) continue;
    const key = `${road}_${laneId}`;
    if (!byRoadLane.has(key)) byRoadLane.set(key, []);
    byRoadLane.get(key).push({ section: Number(section), points });
  }
  const stats = { lanes: 0, registered: 0, byIdentity: 0, slivers: 0, unmatched: 0, rejected: 0, maxShiftM: 0, identitySample: [], rejectedSample: [], unmatchedSample: [] };
  const xml = networkXml.replace(/(<lane id="([^":][^"]*)"([^>]*?)\sshape=")([^"]*)("[^>]*>)(\s*<param key="origId" value="([^"]*)"\/>)/g,
    (whole, head, laneIdAttr, laneAttributes, shape, tail, param, origId) => {
      if (!allowsPassenger(laneAttributes)) return whole;
      stats.lanes += 1;
      const old = shape.trim().split(/\s+/).map((pair) => pair.split(',').map(Number));
      if (polylineLength(old) < MIN_ALIGNED_LANE_M) {
        stats.slivers += 1;
        return whole;
      }
      const sections = byRoadLane.get(origId);
      const laneId = Number(origId.slice(origId.lastIndexOf('_') + 1));
      if (!sections || !Number.isFinite(laneId) || old.length < 2) {
        stats.unmatched += 1;
        if (stats.unmatchedSample.length < 12) stats.unmatchedSample.push(`${laneIdAttr}(${origId})`);
        return whole;
      }
      const ordered = [...sections].sort((a, b) => a.section - b.section);
      const travel = (points) => (laneId > 0 ? [...points].reverse() : points);
      const reference = travel(ordered.flatMap((entry, index) => (index === 0 ? entry.points : entry.points.slice(1))));
      const local = old.map(([x, y]) => [x - offsetX, y - offsetY]);
      const oldLength = polylineLength(local);
      const sameStretch = (candidate) => candidate.length >= 2 && Math.abs(polylineLength(candidate) - oldLength) <= Math.max(3, oldLength * 0.25);
      const maxShift = (candidate) => Math.max(...resample(local, 2).map(([x, y]) => project(candidate, x, y).distance));
      // 1. Project netconvert's endpoints onto the OpenDRIVE lane: exact where
      //    netconvert's lane is roughly right (it trims lanes back from
      //    junctions, which the projection preserves).
      const start = project(reference, local[0][0], local[0][1]);
      const end = project(reference, local.at(-1)[0], local.at(-1)[1]);
      let registered = end.at - start.at > 0.5 ? slice(reference, start.at, end.at) : [];
      let byIdentity = false;
      if (!sameStretch(registered) || maxShift(registered) > 6) {
        // 2. Otherwise netconvert's geometry is wrong (cubic laneOffset,
        //    discarded inner lanes): the lane id is exact, so take the whole
        //    OpenDRIVE lane of an unsplit edge, or lane section k of `road#k`.
        // `#k` usually is OpenDRIVE lane section k, but netconvert renumbers
        // when it merges sections: accept section k when its extent is
        // plausible, otherwise the section whose extent matches best.
        const split = /#(\d+)$/.exec(laneIdAttr.slice(0, laneIdAttr.lastIndexOf('_')));
        if (split) {
          const scored = ordered.map((entry) => {
            const points = travel(entry.points);
            return { section: entry.section, points, score: Math.abs(polylineLength(points) - oldLength) / Math.max(1, oldLength) };
          });
          const indexed = scored.find((entry) => entry.section === Number(split[1]) && entry.score <= 1);
          const best = [...scored].sort((a, b) => a.score - b.score)[0];
          registered = indexed ? indexed.points : best && best.score <= 0.5 ? best.points : [];
        } else {
          registered = reference;
        }
        byIdentity = true;
      }
      const shift = registered.length >= 2 ? maxShift(registered) : Infinity;
      const newLength = polylineLength(registered);
      if (registered.length < 2) {
        stats.rejected += 1;
        if (stats.rejectedSample.length < 12) stats.rejectedSample.push(`${laneIdAttr}(${origId}) len=${round(oldLength, 1)}`);
        return whole;
      }
      if (byIdentity) {
        stats.byIdentity += 1;
        if (stats.identitySample.length < 12) stats.identitySample.push(`${laneIdAttr}(${origId}) shift=${round(shift, 1)} len=${round(oldLength, 1)}->${round(newLength, 1)}`);
      }
      stats.registered += 1;
      stats.maxShiftM = Math.max(stats.maxShiftM, shift);
      const oldStations = [0];
      for (let index = 1; index < local.length; index += 1) oldStations.push(oldStations[index - 1] + Math.hypot(local[index][0] - local[index - 1][0], local[index][1] - local[index - 1][1]));
      const zAt = (fraction) => {
        if (old[0].length < 3) return undefined;
        const target = fraction * oldStations.at(-1);
        let index = 1;
        while (index < oldStations.length - 1 && oldStations[index] < target) index += 1;
        const span = oldStations[index] - oldStations[index - 1];
        const t = span > 0 ? (target - oldStations[index - 1]) / span : 0;
        return old[index - 1][2] + (old[index][2] - old[index - 1][2]) * t;
      };
      let travelled = 0;
      const formatted = registered.map((point, index) => {
        if (index > 0) travelled += Math.hypot(point[0] - registered[index - 1][0], point[1] - registered[index - 1][1]);
        const z = zAt(newLength > 0 ? travelled / newLength : 0);
        const x = (point[0] + offsetX).toFixed(2);
        const y = (point[1] + offsetY).toFixed(2);
        return z === undefined ? `${x},${y}` : `${x},${y},${z.toFixed(2)}`;
      }).join(' ');
      // Identity matches replace grossly wrong geometry: SUMO's length must
      // follow, or vehicles would appear to crawl or race along the lane.
      const laneHead = byIdentity ? head.replace(/\blength="[^"]*"/, `length="${newLength.toFixed(2)}"`) : head;
      return `${laneHead}${formatted}${tail}${param}`;
    });
  stats.maxShiftM = round(stats.maxShiftM);
  return { xml, stats };
}

/** Traffic lights none of whose links carry an OpenDRIVE head: invisible in the scene. */
export function phantomTrafficLights(network) {
  return network.trafficLights.filter((tls) => ![...tls.linkSignals.values()].some((heads) => heads.length > 0)).map((tls) => tls.id).sort();
}

// ── Validation ──────────────────────────────────────────────────────────────

function summarizeWarnings(log) {
  const categories = new Map();
  const errors = [];
  for (const line of log.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('Error:')) errors.push(trimmed);
    if (!trimmed.startsWith('Warning:') || /total messages of type/.test(trimmed)) continue;
    const category = trimmed.replace(/'[^']*'/g, "'…'").replace(/-?\d+(\.\d+)?/g, 'N');
    categories.set(category, (categories.get(category) ?? 0) + 1);
  }
  const totals = [...log.matchAll(/Warning: (\d+) total messages of type: (.*)/g)];
  for (const [, count, message] of totals) {
    const category = `Warning: ${message.replace(/'%'/g, "'…'").replace(/%/g, 'N').replace(/-?\d+(\.\d+)?/g, 'N')}`;
    categories.set(category, Math.max(categories.get(category) ?? 0, Number(count)));
  }
  return {
    errors,
    warningCount: [...categories.values()].reduce((sum, value) => sum + value, 0),
    categories: Object.fromEntries([...categories.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))),
  };
}

/**
 * Structural gates: SUMO lanes coincide with the scene's OpenDRIVE driving
 * lanes, every signalized OpenDRIVE junction is a SUMO traffic light whose
 * links bind to physical heads, and there is enough demand to populate it.
 */
export function validateSumoNetwork({ network, routes, xodrXml, topology, registration }) {
  const failures = [];
  const warnings = [];
  const [offsetX, offsetY] = network.netOffset;
  const toXodr = ([x, y]) => [x - offsetX, y - offsetY];
  const normalLanes = [];
  const internalLanes = [];
  for (const edge of network.edges.values()) {
    for (const lane of edge.lanes) {
      if (!lane.passenger || lane.shape.length < 2 || polylineLength(lane.shape) < MIN_ALIGNED_LANE_M) continue;
      (edge.function === 'internal' ? internalLanes : normalLanes).push(lane.shape.map(toXodr));
    }
  }
  const structure = {
    normalEdges: [...network.edges.values()].filter((edge) => edge.function === 'normal').length,
    internalEdges: [...network.edges.values()].filter((edge) => edge.function === 'internal').length,
    drivableLanes: normalLanes.length,
    junctions: network.junctions.filter((junction) => junction.type !== 'internal').length,
    trafficLights: network.trafficLights.length,
  };
  if (normalLanes.length === 0) failures.push({ gate: 'structure', reason: 'network has no passenger-drivable lanes' });

  const alignment = { reference: 'topology-index driving lanes', normal: null, internal: null, coverage: null };
  const lanes = drivingLanesFromTopology(topology);
  if (lanes.length === 0) {
    failures.push({ gate: 'alignment', reason: 'topology index has no driving lanes to align against' });
  } else {
    const allIndex = new SegmentIndex(lanes.map((lane) => lane.points));
    const normalIndex = new SegmentIndex(lanes.filter((lane) => !lane.junction).map((lane) => lane.points));
    const measure = (polylines, index) => {
      const distances = [];
      for (const polyline of polylines) for (const [x, y] of resample(polyline, 2)) distances.push(index.nearest(x, y));
      return { samples: distances.length, p50M: percentile(distances, 0.5), p95M: percentile(distances, 0.95), maxM: round(Math.max(...distances)) };
    };
    alignment.normal = measure(normalLanes, normalIndex);
    alignment.internal = internalLanes.length > 0 ? measure(internalLanes, allIndex) : null;
    // SUMO trims lanes back from junctions and covers the gap with internal
    // lanes, so coverage counts both.
    const sumoIndex = new SegmentIndex([...normalLanes, ...internalLanes]);
    let covered = 0;
    let total = 0;
    const uncovered = [];
    for (const lane of lanes.filter((candidate) => !candidate.junction)) {
      let laneCovered = 0;
      let laneTotal = 0;
      for (const [x, y, weight] of resample(lane.points, 2)) {
        laneTotal += weight;
        if (sumoIndex.nearest(x, y, 5) <= SUMO_GATES.laneCoverageToleranceM) laneCovered += weight;
      }
      covered += laneCovered;
      total += laneTotal;
      if (laneTotal > 5 && laneCovered / laneTotal < 0.5) uncovered.push(lane.rsl);
    }
    alignment.coverage = { share: round(total > 0 ? covered / total : 0), drivingLaneLengthM: round(total, 1), uncoveredLanes: uncovered.length, uncoveredSample: uncovered.slice(0, 12) };
    if (!(alignment.normal.p95M <= SUMO_GATES.laneOffsetP95M)) failures.push({ gate: 'alignment', reason: `SUMO lane p95 offset ${alignment.normal.p95M} m exceeds ${SUMO_GATES.laneOffsetP95M} m` });
    if (!(alignment.normal.maxM <= SUMO_GATES.laneOffsetMaxM)) failures.push({ gate: 'alignment', reason: `SUMO lane max offset ${alignment.normal.maxM} m exceeds ${SUMO_GATES.laneOffsetMaxM} m` });
    if (alignment.internal && !(alignment.internal.p50M <= SUMO_GATES.internalOffsetP50M)) failures.push({ gate: 'alignment', reason: `SUMO junction lanes are disconnected from the scene: median offset ${alignment.internal.p50M} m exceeds ${SUMO_GATES.internalOffsetP50M} m` });
    else if (alignment.internal && alignment.internal.p95M > SUMO_GATES.internalOffsetP95WarnM) warnings.push({ gate: 'alignment', reason: `SUMO junction lane p95 offset ${alignment.internal.p95M} m (movements without an OpenDRIVE connecting road)` });
    if (!(alignment.coverage.share >= SUMO_GATES.laneCoverageMin)) failures.push({ gate: 'alignment', reason: `SUMO covers ${alignment.coverage.share} of driving-lane length (< ${SUMO_GATES.laneCoverageMin})` });
  }

  const { heads, junctionHeads } = signalHeadsFromXodr(xodrXml);
  const tlsIds = new Set(network.trafficLights.map((tls) => tls.id));
  const boundHeads = new Set(network.trafficLights.flatMap((tls) => [...tls.linkSignals.values()].flat()));
  const missing = [...junctionHeads.entries()]
    .filter(([junction, junctionHeadIds]) => !tlsIds.has(junction) && ![...junctionHeadIds].some((head) => boundHeads.has(head)))
    .map(([junction]) => junction).sort();
  const phantom = phantomTrafficLights(network);
  const controlled = new Map();
  for (const connection of network.connections) {
    if (connection.tl === undefined || connection.linkIndex === undefined) continue;
    if (!controlled.has(connection.tl)) controlled.set(connection.tl, new Set());
    controlled.get(connection.tl).add(connection.linkIndex);
  }
  let unboundLinks = 0;
  const unboundSample = [];
  for (const tls of network.trafficLights) {
    for (const index of [...(controlled.get(tls.id) ?? [])].sort((a, b) => a - b)) {
      if ((tls.linkSignals.get(index) ?? []).length > 0) continue;
      unboundLinks += 1;
      if (unboundSample.length < 12) unboundSample.push(`${tls.id}:${index}`);
    }
  }
  const unboundHeads = [...heads].filter((head) => !boundHeads.has(head)).sort();
  const signals = {
    openDriveHeads: heads.size,
    openDriveSignalizedJunctions: junctionHeads.size,
    sumoTrafficLights: network.trafficLights.length,
    boundHeads: heads.size - unboundHeads.length,
    unboundHeads: unboundHeads.length,
    unboundHeadSample: unboundHeads.slice(0, 12),
    missingJunctions: missing,
    phantomTrafficLights: phantom,
    controlledLinks: [...controlled.values()].reduce((sum, set) => sum + set.size, 0),
    unboundLinks,
    unboundLinkSample: unboundSample,
  };
  if (missing.length > 0) failures.push({ gate: 'signals', reason: `${missing.length} signalized OpenDRIVE junction(s) have no SUMO traffic light: ${missing.slice(0, 8).join(', ')}` });
  if (phantom.length > 0) failures.push({ gate: 'signals', reason: `${phantom.length} SUMO traffic light(s) have no OpenDRIVE head (invisible signals): ${phantom.slice(0, 8).join(', ')}` });
  // Presentation limits, not simulation faults: SUMO still controls these
  // movements, the scene just has no head to show their state on.
  if (unboundLinks > 0) warnings.push({ gate: 'signals', reason: `${unboundLinks} controlled movement(s) have no OpenDRIVE head to display their state: ${unboundSample.join(', ')}` });
  if (unboundHeads.length > 0) warnings.push({ gate: 'signals', reason: `${unboundHeads.length} OpenDRIVE head(s) are not driven by any SUMO traffic light: ${unboundHeads.slice(0, 12).join(', ')}` });

  const demand = { routeCandidates: routes.routes.length, drivableEdges: routes.drivableEdges, sourceEdges: routes.sourceEdges, sinkEdges: routes.sinkEdges, reachableFringePairs: routes.reachableFringePairs ?? null };
  const demandFloor = Math.max(1, Math.min(MIN_ROUTE_CANDIDATES, routes.reachableFringePairs ?? MIN_ROUTE_CANDIDATES));
  if (routes.routes.length < demandFloor) failures.push({ gate: 'demand', reason: `only ${routes.routes.length} valid routes (< ${demandFloor}); the network is too disconnected to populate` });
  if (registration && registration.rejected + registration.unmatched > 0) {
    warnings.push({ gate: 'alignment', reason: `${registration.rejected + registration.unmatched} lane(s) kept netconvert geometry (unmatched ${registration.unmatched}, rejected ${registration.rejected})` });
  }
  return { structure, alignment, signals, demand, failures, warnings };
}

// ── Headless run on the pinned WebAssembly runtime ─────────────────────────

function fnv1a(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function routeDocument(routes, vehicles, seconds) {
  const xml = (value) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const count = Math.min(vehicles, routes.length);
  const body = routes.slice(0, count).map((edges, index) => {
    const depart = count <= 1 ? 0 : (index / (count - 1)) * Math.min(30, seconds / 4);
    return `  <vehicle id="gate-${index}" type="ambient" depart="${depart.toFixed(2)}" departLane="best" departPos="random_free" departSpeed="max"><route edges="${edges.map(xml).join(' ')}"/></vehicle>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<routes>\n  <vType id="ambient" carFollowModel="EIDM" laneChangeModel="SL2015" accel="2.6" decel="4.5" emergencyDecel="9" sigma="0.3" tau="1.1" speedFactor="1" speedDev="0.1"/>\n${body}\n</routes>\n`;
}

/**
 * Drive the exact runtime the editor ships (sumo.mjs/sumo.wasm) for a short
 * deterministic run and check that traffic departs, moves, stays on the
 * scene's lanes and that every traffic light cycles.
 */
export async function simulateSumoNetwork({ runtimeDir, networkBytes, network, routes, topology }) {
  const moduleFile = path.join(runtimeDir, 'sumo.mjs');
  const wasmFile = path.join(runtimeDir, 'sumo.wasm');
  const manifestFile = path.join(runtimeDir, 'runtime-manifest.json');
  for (const file of [moduleFile, wasmFile, manifestFile]) {
    if (!existsSync(file)) throw new SumoBuildError('sumo_runtime_missing', `SUMO WebAssembly runtime file is missing: ${file}`, null);
  }
  const runtime = JSON.parse(await readFile(manifestFile, 'utf8'));
  if (runtime.sumoVersion !== SUMO_VERSION) throw new SumoBuildError('sumo_runtime_mismatch', `runtime is SUMO ${runtime.sumoVersion}, derivatives target ${SUMO_VERSION}`, null);
  const { default: factory } = await import(pathToFileURL(moduleFile).href);
  const warnings = [];
  const sumo = await factory({ noInitialRun: true, locateFile: (file) => (file.endsWith('.wasm') ? wasmFile : path.join(runtimeDir, file)), printErr: (message) => { const text = String(message).trim(); if (text) warnings.push(text); } });
  const copy = (bytes) => { const pointer = sumo._malloc(bytes.byteLength); sumo.HEAPU8.set(bytes, pointer); return pointer; };
  const routesBytes = new TextEncoder().encode(routeDocument(routes, SUMO_GATES.simulationVehicles, SUMO_GATES.simulationSeconds));
  const netPointer = copy(networkBytes);
  const routesPointer = copy(routesBytes);
  const ok = (code) => { if (code !== 0) throw new SumoBuildError('sumo_runtime_failed', sumo.UTF8ToString(sumo._us_sumo_last_error()) || `SUMO failed (${code})`, null); };
  const [offsetX, offsetY] = network.netOffset;
  const index = new SegmentIndex(drivingLanesFromTopology(topology).map((lane) => lane.points));
  const tlsByHash = new Map(network.trafficLights.map((tls) => [fnv1a(tls.id), tls.id]));
  const seenStates = new Map(network.trafficLights.map((tls) => [tls.id, new Set()]));
  const firstSeen = new Map();
  const lastSeen = new Map();
  const offsets = [];
  let peak = 0;
  try {
    ok(sumo._us_sumo_start(netPointer, networkBytes.byteLength, routesPointer, routesBytes.byteLength, SUMO_GATES.simulationStepSeconds, 2711));
  } finally {
    sumo._free(netPointer);
    sumo._free(routesPointer);
  }
  const steps = Math.round(SUMO_GATES.simulationSeconds / SUMO_GATES.simulationStepSeconds);
  const sampleEvery = Math.round(1 / SUMO_GATES.simulationStepSeconds);
  try {
    for (let step = 1; step <= steps; step += 1) {
      ok(sumo._us_sumo_step(SUMO_GATES.simulationStepSeconds));
      if (step % sampleEvery !== 0) continue;
      const count = sumo._us_sumo_state_count();
      peak = Math.max(peak, count);
      const view = new DataView(sumo.HEAPU8.buffer, sumo._us_sumo_state_pointer(), count * 32);
      for (let offset = 0; offset < view.byteLength; offset += 32) {
        const id = view.getUint32(offset, true);
        const x = view.getFloat32(offset + 4, true) - offsetX;
        const y = view.getFloat32(offset + 8, true) - offsetY;
        if (!firstSeen.has(id)) firstSeen.set(id, [x, y]);
        lastSeen.set(id, [x, y]);
        offsets.push(index.nearest(x, y));
      }
      const links = sumo._us_sumo_signal_state_count();
      const signalView = new DataView(sumo.HEAPU8.buffer, sumo._us_sumo_signal_state_pointer(), links * 8);
      for (let offset = 0; offset < signalView.byteLength; offset += 8) {
        const tls = tlsByHash.get(signalView.getUint32(offset, true));
        if (tls) seenStates.get(tls).add(String.fromCharCode(signalView.getUint8(offset + 6)).toLowerCase());
      }
    }
  } finally {
    sumo._us_sumo_close();
  }
  const travelled = [...firstSeen.entries()].map(([id, start]) => Math.hypot(lastSeen.get(id)[0] - start[0], lastSeen.get(id)[1] - start[1]));
  const teleports = warnings.filter((line) => /teleport/i.test(line) && !/ending teleport/i.test(line)).length;
  const collisions = warnings.filter((line) => /collision/i.test(line)).length;
  const stuckSignals = [...seenStates.entries()].filter(([, states]) => !(states.has('g') && (states.has('r') || states.has('y')))).map(([id]) => id).sort();
  const simulation = {
    runtime: { sumoVersion: runtime.sumoVersion, sumoCommit: runtime.sumoCommit, wasmBytes: runtime.wasmBytes },
    vehicles: Math.min(SUMO_GATES.simulationVehicles, routes.length), seconds: SUMO_GATES.simulationSeconds, stepSeconds: SUMO_GATES.simulationStepSeconds,
    departed: firstSeen.size, peakActive: peak,
    movingShare: round(travelled.length > 0 ? travelled.filter((meters) => meters >= 20).length / travelled.length : 0),
    vehicleOffset: { samples: offsets.length, p50M: percentile(offsets, 0.5), p95M: percentile(offsets, 0.95), maxM: offsets.length ? round(Math.max(...offsets)) : null },
    teleports, collisions, cyclingTrafficLights: network.trafficLights.length - stuckSignals.length, stuckTrafficLights: stuckSignals,
    warnings: [...new Set(warnings.map((line) => line.replace(/-?\d+(\.\d+)?/g, 'N').replace(/'[^']*'/g, "'…'")))].sort().slice(0, 20),
  };
  const failures = [];
  const expected = Math.min(SUMO_GATES.simulationVehicles, routes.length);
  if (simulation.departed < Math.ceil(expected * 0.9)) failures.push({ gate: 'simulation', reason: `only ${simulation.departed}/${expected} vehicles departed` });
  if (!(simulation.movingShare >= SUMO_GATES.movingVehicleShareMin)) failures.push({ gate: 'simulation', reason: `only ${simulation.movingShare} of vehicles travelled 20 m (gridlock or invalid routes)` });
  if (!(simulation.vehicleOffset.p95M <= SUMO_GATES.vehicleOffsetP95M)) failures.push({ gate: 'simulation', reason: `vehicle p95 lane offset ${simulation.vehicleOffset.p95M} m exceeds ${SUMO_GATES.vehicleOffsetP95M} m` });
  if (teleports > SUMO_GATES.maxTeleports) failures.push({ gate: 'simulation', reason: `${teleports} teleports (jammed or disconnected lanes)` });
  if (stuckSignals.length > 0) failures.push({ gate: 'simulation', reason: `traffic light(s) never cycled: ${stuckSignals.slice(0, 8).join(', ')}` });
  return { simulation, failures };
}

// ── Build ───────────────────────────────────────────────────────────────────

function readTopology(file) {
  const bytes = readFileSync(file);
  return JSON.parse((file.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString('utf8'));
}

async function runNetconvert(toolchain, xodrPath, outputPath, extra, cwd) {
  try {
    const result = await run(toolchain.netconvert, [...netconvertArguments(xodrPath, outputPath), ...extra], {
      maxBuffer: 256 * 1024 * 1024, cwd,
      // netconvert otherwise reads its OpenDRIVE typemap from $SUMO_HOME,
      // which silently ties the output to whichever SUMO install is on PATH.
      env: { ...process.env, SUMO_HOME: '' },
    });
    return { ok: true, log: `${result.stdout}\n${result.stderr}` };
  } catch (error) {
    return { ok: false, log: `${error?.stdout ?? ''}\n${error?.stderr ?? ''}`, message: error?.message };
  }
}

/**
 * Build, validate and (only when every gate passes) write `derived/sumo/*`.
 *
 * Steps: netconvert with the pinned options; a second pass that un-signals
 * traffic lights the scene has no heads for; lane registration onto the
 * OpenDRIVE centerlines; deterministic demand; structural gates; a headless
 * run on the pinned WebAssembly runtime.
 *
 * @returns the manifest, the report and output file digests.
 * @throws SumoBuildError with `report` when a gate fails; nothing is written
 *   to `outputDir` then, except `failed-sumo-build-report.json` when
 *   `writeFailedReport` is set.
 */
export async function buildSumoDerivative({
  xodrPath, topologyPath, mapId, sourceMapId = mapId, outputDir, toolchain, runtimeDir,
  simulate = true, writeFailedReport = false,
}) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(mapId)) throw new SumoBuildError('sumo_invalid_map', `invalid map id: ${mapId}`, null);
  const resolvedToolchain = toolchain ?? await resolveSumoToolchain();
  const xodrBytes = await readFile(xodrPath);
  const xodrXml = xodrBytes.toString('utf8');
  const xodrSha256 = sha256(xodrBytes);
  const buildKey = sumoBuildKey({ xodrSha256, mapId, sourceMapId });
  const topology = readTopology(topologyPath);
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'simforge-sumo-'));
  const report = {
    schema: SUMO_BUILD_REPORT_SCHEMA, mapId, sourceMapId, buildKey, xodrSha256,
    toolchain: { sumo: SUMO_VERSION, revision: SUMO_DERIVATIVE_REVISION, netconvertOptions: NETCONVERT_OPENDRIVE_OPTIONS, typemapSha256: SUMO_TYPEMAP_SHA256, gates: SUMO_GATES },
    status: 'failed', failures: [], warnings: [],
  };
  const fail = (code, reason) => {
    report.failures.push({ gate: code.replace(/^sumo_/, ''), reason });
    return new SumoBuildError(code, reason, report);
  };
  try {
    const rawPath = path.join(scratch, 'map.net.xml');
    const xodrAbsolute = path.resolve(xodrPath);
    let pass = await runNetconvert(resolvedToolchain, xodrAbsolute, rawPath, [], scratch);
    report.netconvert = summarizeWarnings(pass.log);
    if (!pass.ok || report.netconvert.errors.length > 0) throw fail('sumo_netconvert_failed', `netconvert failed: ${report.netconvert.errors[0] ?? pass.message ?? 'unknown error'}`);
    let bound = bindSignalHeads(normalizeNetconvertXml(await readFile(rawPath)).toString('utf8'), xodrXml);
    // A traffic light none of whose movements has a head in the scene would
    // stop traffic at an invisible signal: rebuild with those junctions
    // uncontrolled (priority rules), as the scene shows them.
    const phantom = phantomTrafficLights(parseSumoNetwork(bound.xml));
    report.netconvert.unsetTrafficLights = phantom;
    if (phantom.length > 0) {
      pass = await runNetconvert(resolvedToolchain, xodrAbsolute, rawPath, ['--tls.unset', phantom.join(',')], scratch);
      report.netconvert = { ...summarizeWarnings(pass.log), unsetTrafficLights: phantom };
      if (!pass.ok || report.netconvert.errors.length > 0) throw fail('sumo_netconvert_failed', `netconvert failed: ${report.netconvert.errors[0] ?? pass.message ?? 'unknown error'}`);
      bound = bindSignalHeads(normalizeNetconvertXml(await readFile(rawPath)).toString('utf8'), xodrXml);
    }
    report.netconvert.inferredSignalLinks = bound.inferredLinks;
    const converted = bound.xml;
    const { xml: networkXml, stats: registration } = registerLaneShapes(converted, topology, parseSumoNetwork(converted).netOffset);
    report.registration = registration;
    const networkBytes = Buffer.from(networkXml);
    const network = parseSumoNetwork(networkXml);
    const routes = generateRouteCandidates(network);
    const validation = validateSumoNetwork({ network, routes, xodrXml, topology, registration });
    Object.assign(report, { structure: validation.structure, alignment: validation.alignment, signals: validation.signals, demand: validation.demand });
    report.failures.push(...validation.failures);
    report.warnings.push(...validation.warnings);
    if (simulate && report.failures.length === 0) {
      if (!runtimeDir) throw fail('sumo_runtime_missing', 'runtimeDir is required to run the headless SUMO gate');
      const simulation = await simulateSumoNetwork({ runtimeDir, networkBytes, network, routes: routes.routes, topology });
      report.simulation = simulation.simulation;
      report.failures.push(...simulation.failures);
    } else if (!simulate) {
      report.simulation = { skipped: true };
    }
    const networkSha256 = sha256(networkBytes);
    report.networkSha256 = networkSha256;
    if (report.failures.length > 0) {
      throw new SumoBuildError('sumo_validation_failed', report.failures.map((failure) => `${failure.gate}: ${failure.reason}`).join('; '), report);
    }
    report.status = 'passed';
    const manifest = {
      schema: SUMO_NETWORK_SCHEMA, mapId, sourceMapId,
      sourceOpenDrive: 'map.xodr', sourceOpenDriveSha256: xodrSha256,
      networkFile: SUMO_MEMBER_FILES.network, networkBytes: networkBytes.byteLength, sha256: networkSha256,
      buildKey,
      generator: {
        name: 'simforge-sumo-derivative', revision: SUMO_DERIVATIVE_REVISION, sumoVersion: SUMO_VERSION, routeSeed: ROUTE_SEED,
        netconvertOptions: NETCONVERT_OPENDRIVE_OPTIONS, typemapSha256: SUMO_TYPEMAP_SHA256, unsetTrafficLights: phantom,
      },
      sumoLocation: network.location,
      worldFromNetwork: { translationX: -network.netOffset[0], translationY: network.netOffset[1], rotationDegrees: 0, scale: 1, invertY: true },
      trafficLights: network.trafficLights.length,
      report: SUMO_MEMBER_FILES.report,
      routeCandidates: routes.routes,
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    const reportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
    await atomicWrite(path.join(outputDir, SUMO_MEMBER_FILES.network), networkBytes);
    await atomicWrite(path.join(outputDir, SUMO_MEMBER_FILES.report), reportBytes);
    // The manifest is written last: its presence marks a complete derivative.
    await atomicWrite(path.join(outputDir, SUMO_MEMBER_FILES.manifest), manifestBytes);
    await rm(path.join(outputDir, `failed-${SUMO_MEMBER_FILES.report}`), { force: true });
    return {
      buildKey, manifest, report,
      files: {
        [SUMO_MEMBER_FILES.network]: { sha256: networkSha256, bytes: networkBytes.byteLength },
        [SUMO_MEMBER_FILES.manifest]: { sha256: sha256(manifestBytes), bytes: manifestBytes.byteLength },
        [SUMO_MEMBER_FILES.report]: { sha256: sha256(reportBytes), bytes: reportBytes.byteLength },
      },
    };
  } catch (error) {
    if (writeFailedReport && error instanceof SumoBuildError && error.report) {
      await atomicWrite(path.join(outputDir, `failed-${SUMO_MEMBER_FILES.report}`), Buffer.from(`${JSON.stringify(error.report, null, 2)}\n`));
    }
    throw error;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Read an existing derivative and say whether it is current for this
 * OpenDRIVE and toolchain. Used for idempotent rebuilds and audits.
 */
export async function inspectSumoDerivative({ outputDir, xodrPath, mapId, sourceMapId = mapId }) {
  const manifestPath = path.join(outputDir, SUMO_MEMBER_FILES.manifest);
  const expectedKey = sumoBuildKey({ xodrSha256: sha256(await readFile(xodrPath)), mapId, sourceMapId });
  if (!existsSync(manifestPath)) return { state: 'missing', expectedKey };
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const networkPath = path.join(outputDir, manifest.networkFile ?? SUMO_MEMBER_FILES.network);
  if (!existsSync(networkPath) || sha256(await readFile(networkPath)) !== manifest.sha256) return { state: 'corrupt', expectedKey, manifest };
  return { state: manifest.buildKey === expectedKey ? 'current' : 'stale', expectedKey, manifest };
}
