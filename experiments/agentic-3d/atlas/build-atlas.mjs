#!/usr/bin/env node
// Semantic site atlas — experiment E1.
//
// Enumerate spawn poses along every driving lane of a map, render the TRUE
// world model (corpus tiles + vegetation layer) at each pose from two views
// (ego-height compass views + top-down), as ONE `simforge-render job` whose
// scene-state stream carries one site per tick (single scene load, hundreds
// of shots).
//
// Ground elevation comes from the rendered road mesh itself (road.glb vertex
// grid), NOT from the lane topology — its polylines are planar (2D), which is
// itself an audit finding recorded per site as `meshY`.
//
// Output: experiments/agentic-3d/atlas/<map>/{sites.json,render-job.json,render-scene-state.json,renders/}
// Usage: node build-atlas.mjs [--map yale-street] [--stride 40] [--dedupe 25]

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { loadMap, DEV_ASSETS } from '@simforge-oss/compiler/node';
import { buildXodrElevationResolver } from '@simforge-oss/compiler';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const argOf = (f, d) => { const i = process.argv.indexOf(`--${f}`); return i >= 0 ? process.argv[i + 1] : d; };
const MAP = argOf('map', 'yale-street');
const STRIDE_M = Number(argOf('stride', 40));
const DEDUPE_M = Number(argOf('dedupe', 25));
const EGO_EYE_M = 1.6;
const TOP_EYE_M = 55;
const CELL_M = 4;

// ---- 0. ground-height grid from the road mesh (median vertex Y per cell) ----
async function buildGroundGrid(roadGlbPath) {
  const doc = await new NodeIO().read(roadGlbPath);
  const cells = new Map(); // "cx,cz" -> ys[]
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const m = node.getWorldMatrix();
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      if (!pos) continue;
      const a = pos.getArray();
      for (let i = 0; i < a.length; i += 9) { // subsample every 3rd vertex
        const x = a[i], y = a[i + 1], z = a[i + 2];
        const wx = m[0] * x + m[4] * y + m[8] * z + m[12];
        const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
        const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
        const key = `${Math.round(wx / CELL_M)},${Math.round(wz / CELL_M)}`;
        let ys = cells.get(key);
        if (!ys) cells.set(key, (ys = []));
        ys.push(wy);
      }
    }
  }
  const grid = new Map();
  for (const [k, ys] of cells) { ys.sort((p, q) => p - q); grid.set(k, ys[Math.floor(ys.length * 0.1)]); }
  return (x, z) => {
    for (let r = 0; r <= 3; r++) { // expanding ring search; ring radius is REPORTED, not hidden
      for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const v = grid.get(`${Math.round(x / CELL_M) + dx},${Math.round(z / CELL_M) + dz}`);
        if (v !== undefined) return { y: v, ringR: r };
      }
    }
    return null;
  };
}

const tilesDir = path.join(ROOT, '.corpus', MAP, 'tiles');
console.log('[atlas] building ground grid from road.glb...');
const groundAt = await buildGroundGrid(path.join(tilesDir, 'road.glb'));


// ---- 1. enumerate poses along driving-lane centerlines ----
// The published topology DTO is the site source; execution geometry stays inside the native runtime.
const bundle = await loadMap(MAP);
const driving = Object.values(bundle.topology.lanes).filter((l) => l.laneType === 'driving' && !l.isJunction);
/** Cumulative arc length and per-segment heading of one lane polyline (xodr-local metres). */
function laneGeometry(lane) {
  const points = lane.polyline;
  if (!Array.isArray(points) || points.length < 2) return null;
  const cum = [0], headings = [];
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x, dy = points[i].y - points[i - 1].y;
    cum.push(cum[i - 1] + Math.hypot(dx, dy));
    headings.push(Math.atan2(dy, dx));
  }
  return { points, cum, headings, lengthM: cum[cum.length - 1] };
}

// xodr elevation resolver: the SOURCE data carries elevation profiles even
// though topology polylines are 2D. Compare against the mesh per pose.
let xodrElev = null;
try {
  const xodr = fs.readFileSync(path.join(DEV_ASSETS, MAP, 'map.xodr'), 'utf8');
  xodrElev = buildXodrElevationResolver(xodr, bundle.topology);
} catch (e) { console.error('[atlas] xodr elevation resolver unavailable:', String(e).slice(0, 160)); }

const sites = [];
const taken = [];
const headingBucket = (h) => Math.round((((h % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) / (Math.PI / 2)) % 4;
let noGround = 0;
for (const lane of driving) {
  const geo = laneGeometry(lane);
  if (!geo || geo.lengthM < 15) continue;
  for (let s = 8; s < geo.lengthM - 5; s += STRIDE_M) {
    let i = 0;
    while (i < geo.cum.length - 1 && geo.cum[i + 1] < s) i++;
    const p = geo.points[i];
    const heading = geo.headings[Math.min(i, geo.headings.length - 1)];
    const x = p.x, z = -p.y; // toSceneXZ
    const hb = headingBucket(heading);
    if (taken.some((t) => t.hb === hb && (t.x - x) ** 2 + (t.z - z) ** 2 < DEDUPE_M ** 2)) continue;
    const ground = groundAt(x, z);
    if (ground === null) { noGround++; continue; }
    taken.push({ x, z, hb });
    let xodrY = null;
    try { xodrY = xodrElev ? Math.round(xodrElev({ x: p.x, y: p.y }) * 100) / 100 : null; } catch { /* fail-closed spots stay null */ }
    sites.push({
      siteId: `s${String(sites.length).padStart(3, '0')}`,
      rsl: lane.rsl, s: Math.round(s * 10) / 10,
      speedLimitKph: lane.speedLimitKph,
      meshY: Math.round(ground.y * 100) / 100,
      meshRingR: ground.ringR, // 0 = road mesh directly beneath; >0 = nearest cell fallback (divergence signal)
      xodrY,
      pose: { x: Math.round(x * 100) / 100, z: Math.round(z * 100) / 100, headingRad: Math.round(heading * 1000) / 1000 },
    });
  }
}
const ys = sites.map((s) => s.meshY).sort((a, b) => a - b);
const offCell = sites.filter((s) => s.meshRingR > 0).length;
const deltas = sites.filter((s) => s.xodrY !== null).map((s) => Math.abs(s.meshY - s.xodrY)).sort((a, b) => a - b);
console.log(`[atlas] ${MAP}: ${driving.length} driving lanes -> ${sites.length} poses (stride ${STRIDE_M}m); ` +
  `${noGround} no-mesh-within-12m; ${offCell} needed fallback cells (>4m); ` +
  `mesh elevation ${ys[0]}..${ys[ys.length - 1]} m; ` +
  (deltas.length ? `|mesh - xodr| p50=${deltas[deltas.length >> 1].toFixed(2)}m max=${deltas[deltas.length - 1].toFixed(2)}m over ${deltas.length} poses` : 'no xodr elevation'));

// ---- 2. one render job: 2 cameras per site ----
const glbs = fs.readdirSync(tilesDir).filter((n) => n === 'road.glb' || (n.startsWith('tile_') && n.endsWith('.lod2.glb'))).map((n) => path.join(tilesDir, n));
const vegGlbs = fs.readdirSync(tilesDir).filter((n) => n.startsWith('veg_') && n.endsWith('.lod2.glb') && fs.existsSync(path.join(tilesDir, n.replace('.lod2.glb', '.instances.json')))).map((n) => path.join(tilesDir, n));

const outDir = path.join(ROOT, 'experiments/agentic-3d/atlas', MAP);
const rendersDir = path.join(outDir, 'renders');
fs.mkdirSync(rendersDir, { recursive: true });

// One `simforge-render job` (simforge.render-job/v2): a job's rig is fixed,
// so each site is one tick of a scene-state stream that moves an anchor
// actor (`atlas-site`) to the site pose, and every camera rides it as a
// rigid attach. v2: FOUR ego-height compass views per site (fwd/left/back/
// right) + top-down — site retrieval reviews the actual imagery instead of
// trusting text cards. The anchor is a 5 cm primitive; an attached camera
// never draws its host, so no view shows it. Renders land as
// renders/<sensorId>/<siteIndex:08>.rgb.png.
const ANCHOR = 'atlas-site';
const eyeHeight = EGO_EYE_M;
// Old eye/target geometry as mount angles: compass views aim 12 m out at
// 0.9 x eye height; the top view looks from TOP_EYE_M at a point 2 m ahead.
const compassPitchDeg = -Math.atan2(EGO_EYE_M * 0.1, 12) * 180 / Math.PI;
const topPitchDeg = -Math.atan2(TOP_EYE_M, 2) * 180 / Math.PI;
const compass = (sensorId, yawDeg) => ({
  sensorId, width: 736, height: 416, fovDeg: 58, eye: [0, 0, 0], target: [0, 0, 1],
  attach: { actorId: ANCHOR, offsetM: [0, 0, eyeHeight], yawDeg, pitchDeg: compassPitchDeg },
});
const cameras = [
  compass('atlas_fwd', 0),
  compass('atlas_left', -90), // positive mount yaw turns toward the right
  compass('atlas_back', 180),
  compass('atlas_right', 90),
  { sensorId: 'atlas_top', width: 512, height: 512, fovDeg: 55, eye: [0, 0, 0], target: [0, 0, 1],
    attach: { actorId: ANCHOR, offsetM: [0, 0, TOP_EYE_M], pitchDeg: topPitchDeg } },
];
const TICK_HZ = 1;
const stream = sites.map((site, i) => {
  const { x, z, headingRad } = site.pose;
  const gy = site.xodrY ?? site.meshY; // xodr wins: p50 agreement 2 cm; mesh-grid outliers catch elevated decks
  return {
    version: 'simforge.scene-state.v1', mapId: MAP, tick: i, tickHz: TICK_HZ,
    groundY: 0, // the anchor's height is the site's; never resampled
    actors: [{
      id: ANCHOR, kind: i === 0 ? 'spawn' : 'update', actorClass: 'prop',
      dims: { l: 0.05, w: 0.05, h: 0.05 },
      transform: { position: [x, gy, z], rotation: [0, Math.sin(headingRad / 2), 0, Math.cos(headingRad / 2)] },
      velocity: [0, 0, 0],
    }],
  };
});
const sceneStatePath = path.join(outDir, 'render-scene-state.json');
fs.writeFileSync(sceneStatePath, JSON.stringify(stream));

const job = {
  schema: 'simforge.render-job/v2',
  scene: {
    glbs, vegGlbs,
    lighting: { sun_elev_deg: 38, sun_azim_deg: 145, sun_lux: 28000, ambient: 0.6 },
    render: { preset: 'training' },
    warmupFrames: 20,
    allowPrimitiveActors: true, // the anchor has no catalog model by design
  },
  sceneState: sceneStatePath,
  rig: { cameras },
  ticks: { start: 0, count: stream.length },
  passes: ['rgb'],
  outDir: rendersDir,
};
const jobPath = path.join(outDir, 'render-job.json');
fs.writeFileSync(jobPath, JSON.stringify(job));
fs.writeFileSync(path.join(outDir, 'sites.json'), JSON.stringify({
  mapId: MAP, strideM: STRIDE_M, dedupeM: DEDUPE_M, frameOffset: 0,
  renderLayout: 'renders/<sensorId>/<siteIndex:08>.rgb.png', posesOffMesh: noGround, sites,
}, null, 1));

console.log(`[atlas] rendering ${stream.length} sites x ${cameras.length} cameras (${glbs.length} tiles, ${vegGlbs.length} veg layers)...`);
const t0 = Date.now();
const renderBin = process.env.SIMFORGE_RENDER_BIN ?? path.join(ROOT, 'renderer/target/release/simforge-render');
const r = spawnSync(renderBin, ['job', '--job', jobPath], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const wall = ((Date.now() - t0) / 1000).toFixed(1);
if (r.status !== 0) {
  console.error(`[atlas] render job FAILED (${wall}s):`, (r.stderr ?? '').split('\n').filter((l) => !/TEXCOORD|Unknown vertex/.test(l)).slice(-8).join('\n'));
  process.exit(1);
}
const produced = cameras.reduce((n, c) => n + fs.readdirSync(path.join(rendersDir, c.sensorId)).filter((f) => f.endsWith('.rgb.png')).length, 0);
console.log(`[atlas] done in ${wall}s — ${produced} renders in ${path.relative(ROOT, rendersDir)}`);
// frameOffset retained for schema stability (site index == render tick).
