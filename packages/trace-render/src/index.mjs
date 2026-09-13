#!/usr/bin/env node
/**
 * Deterministic top-down trace renderer.
 *
 * This is intentionally data-driven: the camera, actor poses, frame times and
 * labels come from a concrete instance + trace pair, never from a template or
 * parameter draw. It produces SVG + PNG stills, a short mp4, and a manifest that
 * verifies instance/trace hashes and exact actor id equality before rendering.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { gunzipSync } from 'node:zlib';
import { incidentWindow } from '../../../scripts/export-render-lib.mjs';

import { actorGlyph, deterministicFlashPhase, propSvgLayer, stateValueAt, underlayFromTopology, underlaySvgLayers } from './underlay.mjs';

const require = createRequire(import.meta.url);
let sharp;
try {
  sharp = require('sharp');
} catch (error) {
  throw new Error(`@simforge-oss/trace-render requires sharp: ${error instanceof Error ? error.message : String(error)}`);
}

function parseArgs(argv) {
  const out = { times: null, width: 960, height: 600, scale: 8, fps: 2, devAssets: null, redact: false, camera: 'pair' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} requires a value`);
      return v;
    };
    if (a === '--instance') out.instance = next();
    else if (a === '--trace') out.trace = next();
    else if (a === '--out') out.out = next();
    else if (a === '--times') out.times = next().split(',').map((v) => Number(v.trim()));
    else if (a === '--size') {
      const [w, h] = next().split('x').map(Number);
      out.width = w;
      out.height = h;
    } else if (a === '--scale') out.scale = Number(next());
    else if (a === '--fps') out.fps = Number(next());
    else if (a === '--dev-assets') out.devAssets = next();
    else if (a === '--full-clip') out.fullClip = true;
    else if (a === '--format') {
      out.format = next();
      if (out.format !== 'both' && out.format !== 'stills') throw new Error('--format must be both or stills');
    }
    else if (a === '--redact') out.redact = true;
    else if (a === '--camera') {
      out.camera = next();
      if (out.camera !== 'pair' && out.camera !== 'follow-ego') throw new Error('--camera must be pair or follow-ego');
    }
    else if (a === '--help') usage(0);
    else throw new Error(`unknown argument ${a}`);
  }
  if (!out.instance || !out.trace || !out.out) usage(1);
  if (!Number.isFinite(out.width) || !Number.isFinite(out.height) || out.width <= 0 || out.height <= 0) {
    throw new Error('--size must be WIDTHxHEIGHT');
  }
  return out;
}

function usage(code) {
  process.stderr.write(
    'usage: simforge-trace-render --instance <instance.json> --trace <trace.json.gz> --out <dir> [--times t0,t1,t2,t3 | --full-clip] [--size 960x600] [--scale pxPerM] [--fps 2] [--format both|stills] [--dev-assets <root>] [--redact] [--camera pair|follow-ego]\n',
  );
  process.exit(code);
}

function canonicalJson(value) {
  return writeCanonical(value);
}

function writeCanonical(value) {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'number') {
    if (!Number.isFinite(value)) throw new Error(`canonicalJson: non-finite number ${String(value)}`);
    return JSON.stringify(value + 0);
  }
  if (t === 'string' || t === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => writeCanonical(v === undefined ? null : v)).join(',')}]`;
  if (t === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${writeCanonical(value[k])}`).join(',')}}`;
  }
  return 'null';
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sha256Text(text) {
  return createHash('sha256').update(text).digest('hex');
}

function readTrace(path) {
  const bytes = readFileSync(path);
  const plain = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
  return { trace: JSON.parse(plain.toString('utf8')), canonicalBytes: plain };
}

function sortedActorIdsFromTrace(trace) {
  const fromHeader = Array.isArray(trace.header?.actorIds) ? trace.header.actorIds : [];
  const fromTicks = Object.keys(trace.ticks?.actors ?? {});
  return [...new Set([...fromHeader, ...fromTicks])].sort();
}

function assertEvidence(instanceDoc, trace, traceCanonicalBytes) {
  const input = instanceDoc.input;
  const inputHash = sha256Text(canonicalJson(input));
  const manifestInputHash = instanceDoc.manifest?.inputHash ?? null;
  const traceInputHash = trace.header?.inputHash ?? null;
  const inputActorIds = (input.actors ?? []).map((a) => a.id).sort();
  const traceActorIds = sortedActorIdsFromTrace(trace);
  const issues = [];
  if (manifestInputHash !== inputHash) issues.push(`manifest.inputHash ${manifestInputHash} != recomputed ${inputHash}`);
  if (traceInputHash !== inputHash) issues.push(`trace.header.inputHash ${traceInputHash} != recomputed ${inputHash}`);
  if (JSON.stringify(inputActorIds) !== JSON.stringify(traceActorIds)) {
    issues.push(`actor ids differ: input=${inputActorIds.join(',')} trace=${traceActorIds.join(',')}`);
  }
  if (traceActorIds.length === 0) issues.push('trace carries zero actor ids');
  if (issues.length > 0) throw new Error(`evidence integrity failed: ${issues.join('; ')}`);
  return {
    inputHash,
    manifestInputHash,
    traceInputHash,
    traceDigest: sha256Bytes(traceCanonicalBytes),
    inputActorIds,
    traceActorIds,
  };
}

function nearestIndex(times, t) {
  let best = 0;
  let d = Infinity;
  for (let i = 0; i < times.length; i += 1) {
    const cur = Math.abs(times[i] - t);
    if (cur < d) {
      best = i;
      d = cur;
    }
  }
  return best;
}

function defaultFrameTimes(trace) {
  const t = trace.ticks.t;
  const conflict = trace.metrics?.revealToConflict?.conflictT ?? trace.metrics?.minTTC?.t ?? t[Math.floor(t.length / 2)] ?? 0;
  const candidates = [conflict - 1.0, conflict - 0.5, conflict, conflict + 0.5];
  return candidates.map((v) => t[nearestIndex(t, Math.max(t[0], Math.min(t[t.length - 1], v)))]);
}
export function fullClipFrameTimes(trace, fps) {
  const times = trace.ticks.t;
  const start = times[0] ?? 0;
  const end = times[times.length - 1] ?? start;
  const frameCount = Math.max(1, Math.round((end - start) * fps));
  return Array.from({ length: frameCount }, (_, index) => start + index / fps);
}

function poseAt(trace, actorId, index) {
  const ch = trace.ticks.actors[actorId];

  return {
    id: actorId,
    x: ch.x[index],
    y: ch.y[index],
    headingRad: ch.headingRad[index],
    present: ch.present[index] !== 0,
    speedMps: ch.speedMps[index],
  };
}

function cameraFor(trace, index, mode = 'pair') {
  if (mode === 'follow-ego') {
    // Judge-facing framing: the scene is wherever the ego is. The minTTC-pair
    // midpoint drifts off EVERY actor when the pair separates (verified on
    // frozen-ego cells: mid-clip frames were empty road), and is undefined when
    // minTTC is absent.
    const ego = trace.ticks.actors.ego;
    if (ego && ego.present[index] !== 0) {
      return { x: ego.x[index], y: ego.y[index], basis: 'follow-ego', pair: ['ego'] };
    }
    // ego absent this tick: fall through to the pair heuristic
  }
  const pair = trace.metrics?.minTTC?.pair ?? Object.keys(trace.ticks.actors).slice(0, 2);
  const poses = pair.map((id) => poseAt(trace, id, index));
  if (poses.length >= 2) return { x: (poses[0].x + poses[1].x) / 2, y: (poses[0].y + poses[1].y) / 2, basis: 'minTTC-pair-midpoint', pair };
  if (poses.length === 1) return { x: poses[0].x, y: poses[0].y, basis: 'single-actor', pair };
  return { x: 0, y: 0, basis: 'origin', pair: [] };
}

const VIEW_SCALE_LADDER = [8, 6, 4, 3, 2];
const VIEW_EDGE_MARGIN_PX = 8;

function requiredViewActorIds(trace) {
  const pair = trace.metrics?.minTTC?.pair
    ?? trace.metrics?.minPathTTC?.pair
    ?? trace.metrics?.minPET?.pair
    ?? [];
  return [...new Set(['ego', ...pair])].filter((id) => trace.ticks.actors[id]);
}

function viewScaleLadder(requestedScale) {
  if (!Number.isFinite(requestedScale) || requestedScale <= 0) {
    throw new Error(`render scale must be a positive finite number, got ${String(requestedScale)}`);
  }
  return [...new Set([requestedScale, ...VIEW_SCALE_LADDER.filter((scale) => scale < requestedScale)])];
}

function actorFitsView(trace, actorId, index, camera, scale, width, height, dims) {
  const pose = poseAt(trace, actorId, index);
  if (!pose.present) return true;
  const actorDimsAtFrame = dims.get(actorId) ?? { l: 1, w: 1 };
  return obbCorners(pose, pose.headingRad, actorDimsAtFrame.l, actorDimsAtFrame.w)
    .map((point) => pointToScreen(point, camera, scale, width, height))
    .every((point) => (
      point.x >= VIEW_EDGE_MARGIN_PX
      && point.x <= width - VIEW_EDGE_MARGIN_PX
      && point.y >= VIEW_EDGE_MARGIN_PX
      && point.y <= height - VIEW_EDGE_MARGIN_PX
    ));
}

/**
 * Frames that must actually contain the required actors. Composition only has to
 * be informative where the mechanism is judged: over a full 20 s clip two actors
 * routinely start hundreds of metres apart and converge, so demanding containment
 * in every frame refused evidence whose incident framed perfectly. Outside the
 * incident, losing the partner off-frame costs nothing.
 */
function compositionFrameIndices(trace, frameIndices) {
  const window = incidentWindow(trace);
  const onset = window?.losOpenT ?? window?.onsetT;
  const conflict = window?.conflictT;
  if (!Number.isFinite(onset) || !Number.isFinite(conflict)) return frameIndices;
  const lo = Math.min(onset, conflict);
  const hi = Math.max(onset, conflict);
  const inWindow = frameIndices.filter((index) => {
    const t = trace.ticks.t[index];
    return Number.isFinite(t) && t >= lo && t <= hi;
  });
  return inWindow.length > 0 ? inWindow : frameIndices;
}

function chooseViewScale(trace, instanceDoc, frameIndices, cameraMode, requestedScale, width, height) {
  const requiredActorIds = requiredViewActorIds(trace);
  const ladder = viewScaleLadder(requestedScale);
  const dims = actorDims(instanceDoc);
  const mustContain = compositionFrameIndices(trace, frameIndices);
  for (const scale of ladder) {
    const containsRequiredActors = mustContain.every((index) => {
      const camera = cameraFor(trace, index, cameraMode);
      return requiredActorIds.every(
        (actorId) => actorFitsView(trace, actorId, index, camera, scale, width, height, dims),
      );
    });
    if (containsRequiredActors) return { scale, ladder, requiredActorIds, compositionFrames: mustContain.length };
  }
  throw new Error(
    `2D composition cannot contain required actors ${requiredActorIds.join(', ')} `
    + `within ${width}x${height} at minimum scale ${ladder[ladder.length - 1]} px/m `
    + `across ${mustContain.length} incident frame(s)`,
  );
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

function pointToScreen(p, camera, scale, width, height) {
  return { x: width / 2 + (p.x - camera.x) * scale, y: height / 2 - (p.y - camera.y) * scale };
}

function polygon(points) {
  return points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
}

function obbCorners(center, headingRad, lengthM, widthM) {
  const f = { x: Math.cos(headingRad), y: Math.sin(headingRad) };
  const r = { x: -Math.sin(headingRad), y: Math.cos(headingRad) };
  const out = [];
  for (const [sf, sr] of [[1, 1], [1, -1], [-1, -1], [-1, 1]]) {
    out.push({
      x: center.x + f.x * (lengthM / 2) * sf + r.x * (widthM / 2) * sr,
      y: center.y + f.y * (lengthM / 2) * sf + r.y * (widthM / 2) * sr,
    });
  }
  return out;
}

function actorDims(instanceDoc) {
  const out = new Map();
  for (const a of instanceDoc.input.actors ?? []) out.set(a.id, a.dims);
  return out;
}

function actorStatic(instanceDoc) {
  const out = new Set();
  for (const a of instanceDoc.input.actors ?? []) if (a.static) out.add(a.id);
  return out;
}

// Actor kind from the trace header (authoritative); legacy id 'ped' kept as fallback
// so pre-metadata traces render unchanged. Pedestrians/cyclists must be visually
// distinct classes for a vision judge — glyphs keyed off literal ids miss every
// real cell that names its VRU something else (e.g. 'vru').
function actorKinds(trace) {
  const out = new Map();
  for (const [id, m] of Object.entries(trace.header?.actorMetadata ?? {})) {
    if (m && typeof m.kind === 'string') out.set(id, m.kind);
  }
  return out;
}

// Shape + fill per actor class lives in the lib (`actorGlyph`) so the legend is
// testable and single-sourced; trail color follows the body color for classes,
// with the legacy amber for anonymous vehicles.
function actorStateSvgLayer({ events, actorId, frameTime, pose, dims, shape, camera, scale, width, height }) {
  const layers = [];
  const tags = [];
  const center = pointToScreen(pose, camera, scale, width, height);
  const forward = { x: Math.cos(pose.headingRad), y: -Math.sin(pose.headingRad) };
  const left = { x: -Math.sin(pose.headingRad), y: -Math.cos(pose.headingRad) };
  const add = (a, b, scaleB = 1) => ({ x: a.x + b.x * scaleB, y: a.y + b.y * scaleB });
  const point = (p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
  const radius = shape === 'disc'
    ? Math.max(5, dims.w * scale / 2)
    : Math.max(dims.l, dims.w) * scale / 2;

  const gesture = stateValueAt(events, actorId, 'pose.gesture', frameTime);
  const gestureCenter = add(center, left, radius + 7);
  if (gesture === 'halt') {
    layers.push(`<line x1="${add(gestureCenter, left, -6).x.toFixed(1)}" y1="${add(gestureCenter, left, -6).y.toFixed(1)}" x2="${add(gestureCenter, left, 6).x.toFixed(1)}" y2="${add(gestureCenter, left, 6).y.toFixed(1)}" stroke="#ffffff" stroke-width="3"/>`);
    tags.push('HALT');
  } else if (gesture === 'wave_through') {
    const tip = add(gestureCenter, forward, 6);
    const rear = add(gestureCenter, forward, -5);
    layers.push(`<polyline points="${point(add(rear, left, 4))} ${point(tip)} ${point(add(rear, left, -4))}" fill="none" stroke="#ffffff" stroke-width="2"/>`);
    tags.push('WAVE');
  } else if (gesture === 'point') {
    const tip = add(gestureCenter, forward, 7);
    const neck = add(gestureCenter, forward, 2);
    layers.push(`<line x1="${add(gestureCenter, forward, -6).x.toFixed(1)}" y1="${add(gestureCenter, forward, -6).y.toFixed(1)}" x2="${neck.x.toFixed(1)}" y2="${neck.y.toFixed(1)}" stroke="#ffffff" stroke-width="2"/>`);
    layers.push(`<polygon points="${point(tip)} ${point(add(add(neck, left, 3), forward, -1))} ${point(add(add(neck, left, -3), forward, -1))}" fill="#ffffff"/>`);
    tags.push('POINT');
  } else if (gesture === 'phone') {
    tags.push('PHONE');
  }

  const paddle = stateValueAt(events, actorId, 'pose.paddle', frameTime);
  if (paddle === 'stop' || paddle === 'slow') {
    const paddleCenter = add(center, left, -(radius + 9));
    const stemStart = add(center, left, -(radius + 1));
    const color = paddle === 'stop' ? '#c62828' : '#f5a524';
    layers.push(`<line x1="${stemStart.x.toFixed(1)}" y1="${stemStart.y.toFixed(1)}" x2="${paddleCenter.x.toFixed(1)}" y2="${paddleCenter.y.toFixed(1)}" stroke="#ffffff" stroke-width="1.5"/>`);
    layers.push(`<rect x="${(paddleCenter.x - 3).toFixed(1)}" y="${(paddleCenter.y - 4).toFixed(1)}" width="6" height="8" rx="1" fill="${color}" stroke="#ffffff" stroke-width="1"/>`);
    tags.push(paddle === 'stop' ? 'STOP' : 'SLOW');
  }

  const stopArm = stateValueAt(events, actorId, 'pose.stopArm', frameTime);
  if (stopArm === 'extended' || stopArm === 'extending') {
    const bodySide = add(center, left, dims.w * scale / 2);
    const armEnd = add(bodySide, left, 12);
    layers.push(`<line x1="${bodySide.x.toFixed(1)}" y1="${bodySide.y.toFixed(1)}" x2="${armEnd.x.toFixed(1)}" y2="${armEnd.y.toFixed(1)}" stroke="#f5a524" stroke-width="4" stroke-linecap="square"/>`);
    tags.push('STOP ARM');
  }

  const indicator = stateValueAt(events, actorId, 'lights.indicator', frameTime);
  if ((indicator === 'left' || indicator === 'right' || indicator === 'hazard')
      && deterministicFlashPhase(frameTime, 1.5) === 0) {
    const corners = obbCorners(pose, pose.headingRad, dims.l, dims.w)
      .map((p) => pointToScreen(p, camera, scale, width, height));
    const sides = indicator === 'hazard' ? [0, 1] : indicator === 'left' ? [0] : [1];
    for (const side of sides) {
      const corner = corners[side];
      const outward = side === 0 ? left : { x: -left.x, y: -left.y };
      layers.push(`<polygon points="${point(add(corner, forward, 5))} ${point(add(corner, outward, 4))} ${point(add(corner, forward, -3))}" fill="#f5a524"/>`);
    }
  }
  if (indicator === 'left') tags.push('LEFT');
  else if (indicator === 'right') tags.push('RIGHT');
  else if (indicator === 'hazard') tags.push('HAZARD');

  if (stateValueAt(events, actorId, 'lights.brake', frameTime) === true) {
    const corners = obbCorners(pose, pose.headingRad, dims.l, dims.w)
      .map((p) => pointToScreen(p, camera, scale, width, height));
    layers.push(`<line x1="${corners[2].x.toFixed(1)}" y1="${corners[2].y.toFixed(1)}" x2="${corners[3].x.toFixed(1)}" y2="${corners[3].y.toFixed(1)}" stroke="#e5484d" stroke-width="4"/>`);
    tags.push('BRAKE');
  }

  const tagX = center.x + radius + 8;
  const tagY = center.y - ((tags.length - 1) * 11) / 2;
  for (let i = 0; i < tags.length; i += 1) {
    layers.push(`<text x="${tagX.toFixed(1)}" y="${(tagY + i * 11).toFixed(1)}" fill="#ffffff" font-family="monospace" font-size="9">${tags[i]}</text>`);
  }
  return layers;
}
function renderedEnvironment(instanceDoc) {
  const operational = instanceDoc.input.operationalConditions ?? {};
  const authored = instanceDoc.environment
    ?? instanceDoc.authoredEnvironment
    ?? instanceDoc.manifest?.environment
    ?? null;
  return {
    weather: authored?.weather ?? operational.weather ?? null,
    timeOfDay: authored?.timeOfDay ?? operational.timeOfDay ?? null,
    frictionScale: typeof authored?.frictionScale === 'number'
      ? authored.frictionScale
      : operational.effects?.frictionScale ?? null,
  };
}

function weatherBadgeText(environment) {
  const fields = [];
  if (environment.weather && environment.weather !== 'clear') {
    fields.push(`WEATHER: ${environment.weather}`);
  }
  if (environment.timeOfDay && environment.timeOfDay !== 'day' && environment.timeOfDay !== 'noon') {
    fields.push(`TIME: ${environment.timeOfDay}`);
  }
  if (typeof environment.frictionScale === 'number' && environment.frictionScale !== 1) {
    fields.push(`GRIP: x${environment.frictionScale}`);
  }
  return fields.join(' | ');
}


function renderSvg({ instanceDoc, trace, index, frameNo, frameTime, camera, width, height, scale, underlay, redact }) {
  const dims = actorDims(instanceDoc);
  const staticIds = actorStatic(instanceDoc);
  const kinds = actorKinds(trace);
  const actorIds = sortedActorIdsFromTrace(trace);
  const environment = renderedEnvironment(instanceDoc);
  const layers = [];
  layers.push(`<rect width="100%" height="100%" fill="#101820"/>`);
  layers.push(`<g stroke="#314459" stroke-width="1" opacity="0.55">`);
  const gridM = 5;
  for (let dx = -Math.ceil(width / scale / 2 / gridM) * gridM; dx <= Math.ceil(width / scale / 2 / gridM) * gridM; dx += gridM) {
    const x = width / 2 + dx * scale;
    layers.push(`<line x1="${x.toFixed(1)}" y1="0" x2="${x.toFixed(1)}" y2="${height}"/>`);
  }
  for (let dy = -Math.ceil(height / scale / 2 / gridM) * gridM; dy <= Math.ceil(height / scale / 2 / gridM) * gridM; dy += gridM) {
    const y = height / 2 + dy * scale;
    layers.push(`<line x1="0" y1="${y.toFixed(1)}" x2="${width}" y2="${y.toFixed(1)}"/>`);
  }
  layers.push(`</g>`);

  // Lane/junction underlay so a vision judge sees roads, not boxes on a grid.
  if (underlay) {
    const project = (p) => pointToScreen(p, camera, scale, width, height);
    layers.push(...underlaySvgLayers(
      underlay,
      { camera, scale, width, height },
      project,
      instanceDoc.input.surfacePatches,
      environment.weather,
      {
        programs: instanceDoc.input.signalPrograms,
        ticks: trace.ticks.signals,
        tickIndex: index,
        frameTime,
      },
      instanceDoc.input.markingTreatments,
    ));
  }

  // Recent trace paths around the incident, by actor id.
  const start = Math.max(0, index - 75);
  for (const id of actorIds) {
    const ch = trace.ticks.actors[id];
    const pts = [];
    for (let i = start; i <= index; i += 3) {
      if (ch.present[i] === 0) continue;
      pts.push(pointToScreen({ x: ch.x[i], y: ch.y[i] }, camera, scale, width, height));
    }
    if (pts.length > 1) {
      const g = actorGlyph(id, kinds.get(id) ?? null, staticIds.has(id));
      const trail = g.color === '#84d65a' && id !== 'ego' ? '#e8b65a' : g.color;
      layers.push(`<polyline points="${polygon(pts)}" fill="none" stroke="${trail}" stroke-width="2" opacity="0.65"/>`);
    }
  }

  // Static OBB occluders authored as props, if any.
  for (const occ of instanceDoc.input.occluders ?? []) {
    const c = { x: occ.obb.center.x, y: -occ.obb.center.z };
    const pts = obbCorners(c, occ.obb.headingRad, occ.obb.lengthM, occ.obb.widthM).map((p) => pointToScreen(p, camera, scale, width, height));
    layers.push(`<polygon points="${polygon(pts)}" fill="#9b6b2f" fill-opacity="0.28" stroke="#ffc166" stroke-width="2" stroke-dasharray="5 3"/>`);
    if (!redact) {
      const label = pointToScreen(c, camera, scale, width, height);
      layers.push(`<text x="${label.x.toFixed(1)}" y="${label.y.toFixed(1)}" fill="#ffc166" font-family="monospace" font-size="13" text-anchor="middle">${esc(occ.id)}</text>`);
    }
  }

  // Fixed catalog props: solid slate OBBs, distinct from dashed occluders.
  layers.push(...propSvgLayer(
    instanceDoc.input.props,
    { camera, scale, width, height },
    (p) => pointToScreen(p, camera, scale, width, height),
  ));

  for (const id of actorIds) {
    const p = poseAt(trace, id, index);
    if (!p.present) continue;
    const d = dims.get(id) ?? { l: 1, w: 1, h: 1 };
    const g = actorGlyph(id, kinds.get(id) ?? null, staticIds.has(id));
    const color = g.color;
    if (g.shape === 'disc') {
      const c = pointToScreen(p, camera, scale, width, height);
      layers.push(`<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="${Math.max(5, d.w * scale / 2).toFixed(1)}" fill="${color}" stroke="#ffffff" stroke-width="1.5"/>`);
      layers.push(`<line x1="${c.x.toFixed(1)}" y1="${c.y.toFixed(1)}" x2="${(c.x + Math.cos(p.headingRad) * 10).toFixed(1)}" y2="${(c.y - Math.sin(p.headingRad) * 10).toFixed(1)}" stroke="#fff"/>`);
      if (!redact) layers.push(`<text x="${c.x.toFixed(1)}" y="${(c.y - 10).toFixed(1)}" fill="#fff" font-family="monospace" font-size="13" text-anchor="middle">${esc(id)}</text>`);
    } else {
      const pts = obbCorners(p, p.headingRad, d.l, d.w).map((q) => pointToScreen(q, camera, scale, width, height));
      layers.push(`<polygon points="${polygon(pts)}" fill="${color}" fill-opacity="0.9" stroke="#ffffff" stroke-width="1.5"/>`);
      // Emergency light bar, from the shared recorded-state decoder.
      // Flash phase derives from frame time only — deterministic re-renders.
      const emergency = stateValueAt(trace.events, id, 'lights.emergency', frameTime) ?? 'off';
      if (emergency === 'flashing' || emergency === 'flashing_siren') {
        const phase = deterministicFlashPhase(frameTime, 4);
        const f = { x: Math.cos(p.headingRad), y: Math.sin(p.headingRad) };
        const r = { x: -Math.sin(p.headingRad), y: Math.cos(p.headingRad) };
        const lampR = Math.max(2.5, 0.28 * scale);
        for (const [side, colorPair] of [[1, ['#ff2d2d', '#2d6bff']], [-1, ['#2d6bff', '#ff2d2d']]]) {
          const lamp = pointToScreen(
            { x: p.x + r.x * (d.w * 0.22) * side + f.x * d.l * 0.05, y: p.y + r.y * (d.w * 0.22) * side + f.y * d.l * 0.05 },
            camera, scale, width, height,
          );
          layers.push(`<circle cx="${lamp.x.toFixed(1)}" cy="${lamp.y.toFixed(1)}" r="${lampR.toFixed(1)}" fill="${colorPair[phase]}" stroke="#ffffff" stroke-width="0.8"/>`);
        }
        const haloC = pointToScreen(p, camera, scale, width, height);
        const haloR = Math.max(d.l, d.w) * scale * (emergency === 'flashing_siren' ? 1.05 : 0.8);
        layers.push(`<circle cx="${haloC.x.toFixed(1)}" cy="${haloC.y.toFixed(1)}" r="${haloR.toFixed(1)}" fill="none" stroke="${phase === 0 ? '#ff2d2d' : '#2d6bff'}" stroke-width="${emergency === 'flashing_siren' ? 3 : 2}" opacity="0.55"/>`);
      }
      const c = pointToScreen(p, camera, scale, width, height);
      if (!redact) layers.push(`<text x="${c.x.toFixed(1)}" y="${(c.y - 10).toFixed(1)}" fill="#fff" font-family="monospace" font-size="13" text-anchor="middle">${esc(id)}${staticIds.has(id) ? ' (static)' : ''}</text>`);
    }
    layers.push(...actorStateSvgLayer({
      events: trace.events,
      actorId: id,
      frameTime,
      pose: p,
      dims: d,
      shape: g.shape,
      camera,
      scale,
      width,
      height,
    }));
  }

  layers.push(`<g font-family="monospace" font-size="14" fill="#e7edf5">`);
  if (redact) {
    // The vision judge must not see gate metrics, ids, or camera provenance.
    layers.push(`<text x="18" y="26">t=${frameTime.toFixed(3)}s</text>`);
  } else {
    const r = trace.metrics?.revealToConflict;
    const minTtc = trace.metrics?.minTTC;
    layers.push(`<text x="18" y="26">${esc(trace.header.mapId)} frame ${frameNo} t=${frameTime.toFixed(3)}s camera=${camera.basis}</text>`);
    layers.push(`<text x="18" y="46">actors=${actorIds.join(', ')} minTTC=${minTtc ? `${minTtc.value.toFixed(3)}s @ ${minTtc.t.toFixed(3)}s ${minTtc.pair.join('/')}` : '—'}</text>`);
    layers.push(`<text x="18" y="66">reveal=${r ? `${r.value.toFixed(3)}s open=${r.losOpenT.toFixed(3)} conflict=${r.conflictT.toFixed(3)} occ=${r.occluderId ?? 'any'}` : '—'}</text>`);
  }
  const weatherBadge = weatherBadgeText(environment);
  if (weatherBadge) {
    layers.push(`<text x="18" y="${redact ? 46 : 86}">${esc(weatherBadge)}</text>`);
  }
  layers.push(`</g>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${layers.join('\n')}</svg>`;
}

/**
 * Load the map underlay for `mapId` from a dev-assets root. The topology index
 * is required once the flag is given — a missing map is a hard error, because a
 * judge-facing render silently missing its roads would poison verdicts. The
 * derived locations file (crosswalk anchors) is optional.
 */
function loadUnderlayAssets(devAssetsRoot, mapId) {
  const mapDir = resolve(devAssetsRoot, mapId);
  const topologyPath = join(mapDir, 'topology-index.json.gz');
  if (!existsSync(topologyPath)) {
    throw new Error(`--dev-assets: ${topologyPath} does not exist for map "${mapId}"`);
  }
  const topologyBytes = readFileSync(topologyPath);
  const topology = JSON.parse(gunzipSync(topologyBytes).toString('utf8'));
  const locationsPath = join(mapDir, 'derived', 'locations.json.gz');
  let locationsDoc = null;
  let locationsSha256 = null;
  if (existsSync(locationsPath)) {
    const locationsBytes = readFileSync(locationsPath);
    locationsDoc = JSON.parse(gunzipSync(locationsBytes).toString('utf8'));
    locationsSha256 = sha256Bytes(locationsBytes);
  }
  const signalsPath = join(mapDir, 'derived', 'signals.json.gz');
  let signalsDoc = null;
  let signalsSha256 = null;
  if (existsSync(signalsPath)) {
    const signalsBytes = readFileSync(signalsPath);
    signalsDoc = JSON.parse(gunzipSync(signalsBytes).toString('utf8'));
    signalsSha256 = sha256Bytes(signalsBytes);
  }
  const underlay = underlayFromTopology(topology, locationsDoc, signalsDoc);
  return {
    underlay,
    provenance: {
      mapDir,
      topologyFile: topologyPath,
      topologySha256: sha256Bytes(topologyBytes),
      topologyMapName: underlay.mapName,
      locationsFile: locationsDoc ? locationsPath : null,
      locationsSha256,
      signalsFile: signalsDoc ? signalsPath : null,
      signalsSha256,
      laneCount: underlay.lanes.length,
      crosswalkCount: underlay.crosswalks.length,
      signalFeatureCount: underlay.furniture.length,
      signalHeadCount: underlay.furniture.filter((feature) => feature.kind === 'signal_head').length,
      staticSignCount: underlay.furniture.filter((feature) => feature.kind === 'sign').length,
      // Crosswalk bands are anchor+heading approximations from derived
      // locations, not surveyed outlines. Recorded so nobody mistakes them.
      crosswalksApproximate: underlay.crosswalks.length > 0,
    },
  };
}

export async function renderTrace(options) {
  const args = {
    times: null,
    width: 960,
    height: 600,
    scale: 8,
    fps: 2,
    devAssets: null,
    redact: false,
    fullClip: false,
    camera: 'pair',
    format: 'both',
    ...options,
  };
  const outDir = resolve(args.out);
  mkdirSync(outDir, { recursive: true });
  const instanceDoc = JSON.parse(readFileSync(args.instance, 'utf8'));
  const { trace, canonicalBytes } = readTrace(args.trace);
  const underlayAssets = args.devAssets ? loadUnderlayAssets(args.devAssets, trace.header.mapId) : null;
  const evidence = assertEvidence(instanceDoc, trace, canonicalBytes);
  const selectedTimes = (
    args.times ?? (args.fullClip ? fullClipFrameTimes(trace, args.fps) : defaultFrameTimes(trace))
  ).map((t) => trace.ticks.t[nearestIndex(trace.ticks.t, t)]);
  const selectedIndices = selectedTimes.map((frameTime) => nearestIndex(trace.ticks.t, frameTime));
  const view = chooseViewScale(
    trace,
    instanceDoc,
    selectedIndices,
    args.camera,
    args.scale,
    args.width,
    args.height,
  );
  const framesDir = join(outDir, 'frames');
  mkdirSync(framesDir, { recursive: true });

  const frameRecords = [];
  for (let i = 0; i < selectedTimes.length; i += 1) {
    const frameTime = selectedTimes[i];
    const index = selectedIndices[i];
    const camera = cameraFor(trace, index, args.camera);
    const svg = renderSvg({ instanceDoc, trace, index, frameNo: i, frameTime, camera, width: args.width, height: args.height, scale: view.scale, underlay: underlayAssets?.underlay ?? null, redact: args.redact });
    const svgPath = join(framesDir, `frame-${String(i).padStart(3, '0')}.svg`);
    const pngPath = join(framesDir, `frame-${String(i).padStart(3, '0')}.png`);
    writeFileSync(svgPath, svg);
    await sharp(Buffer.from(svg)).png({ compressionLevel: 9, adaptiveFiltering: false }).toFile(pngPath);
    frameRecords.push({
      index,
      t: frameTime,
      svg: svgPath,
      png: pngPath,
      svgSha256: sha256Bytes(readFileSync(svgPath)),
      pngSha256: sha256Bytes(readFileSync(pngPath)),
      camera,
      scale: view.scale,
    });
  }

  const videoPath = join(outDir, 'trace-render.mp4');
  if (args.format !== 'stills') {
    const ffmpeg = spawnSync(
      '/usr/bin/ffmpeg',
      ['-y', '-hide_banner', '-loglevel', 'error', '-framerate', String(args.fps), '-i', join(framesDir, 'frame-%03d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', videoPath],
      { stdio: 'pipe' },
    );
    if (ffmpeg.status !== 0) {
      throw new Error(`ffmpeg failed: ${ffmpeg.stderr.toString('utf8')}`);
    }
  }

  const manifest = {
    kind: 'trace-render-manifest',
    manifestVersion: 1,
    generatedAt: null,
    deterministic: true,
    renderer: 'scripts/render-trace.mjs@2',
    redact: args.redact,
    incidentWindow: incidentWindow(trace),
    viewport: {
      width: args.width,
      height: args.height,
      requestedScale: args.scale,
      chosenScale: view.scale,
      scaleLadder: view.ladder,
      requiredActorIds: view.requiredActorIds,
      edgeMarginPx: VIEW_EDGE_MARGIN_PX,
      // How many frames the containment requirement was evaluated over: the
      // incident window when one exists, else the whole clip.
      compositionFrames: view.compositionFrames,
    },
    underlay: underlayAssets ? underlayAssets.provenance : null,
    scenarioId: instanceDoc.manifest?.replayKey?.templateId ?? null,
    instanceId: instanceDoc.manifest?.instanceId ?? null,
    mapId: trace.header.mapId,
    inputHash: evidence.inputHash,
    traceDigest: evidence.traceDigest,
    inputActorIds: evidence.inputActorIds,
    traceActorIds: evidence.traceActorIds,
    actorCount: evidence.traceActorIds.length,
    integrity: {
      manifestInputHashMatches: true,
      traceInputHashMatches: true,
      actorIdsExactMatch: true,
    },
    metrics: trace.metrics,
    frameTimes: frameRecords.map((f) => f.t),
    frames: frameRecords.map((f) => ({
      index: f.index,
      t: f.t,
      camera: f.camera,
      scale: f.scale,
      svg: basename(f.svg),
      png: basename(f.png),
      svgSha256: f.svgSha256,
      pngSha256: f.pngSha256,
    })),
    video: args.format === 'stills' ? null : {
      file: basename(videoPath),
      fps: args.fps,
      width: args.width,
      height: args.height,
      sha256: sha256Bytes(readFileSync(videoPath)),
    },
    inputs: {
      instanceFile: resolve(args.instance),
      traceFile: resolve(args.trace),
      traceFileSha256: sha256Bytes(readFileSync(args.trace)),
    },
  };
  const manifestPath = join(outDir, 'manifest.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, manifestPath, outDir };
}

export async function runTraceRenderCli(argv = process.argv.slice(2)) {
  const result = await renderTrace(parseArgs(argv));
  process.stdout.write(`${result.manifestPath}\n`);
  return result;
}
