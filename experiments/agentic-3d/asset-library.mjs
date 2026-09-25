#!/usr/bin/env node
// Shared, quality-gated 3D asset library for the scenario factory.
//
// One library, three sources, one contract for the renderer:
//   - CARLA vehicles   (catalog/vehicles-carla)            — engine actor ids
//   - gallery props    (packages/asset-catalog gallery)    — generator exports, raw
//   - generated assets (generated-assets.json + assets/<id>/) — generator exports, raw
// Generator exports are ~1.9-unit center-origin cubes whatever the object is. Every
// gallery/generated GLB the renderer sees is a NORMALIZED derivative: y-up,
// +X-forward, ground-origin, TRUE SCALE from the declared dims (normalize-glb.mjs).
// the renderer (simforge-render) draws them with scaleToDims:false, so what the catalog says is what
// is drawn — no runtime length lookup that silently degrades to scale 1.0.
//
// Every generated asset is QA'd BEFORE authors may rely on it: a deterministic
// `simforge-render job` render of the asset beside the ego sedan (ground-plane world, chase
// camera + top view) is judged by a vision model against the label and dims;
// the verdict is persisted next to the asset and drives status:
//   candidate -> approved | rejected   (search ranks approved first; rejected
//   assets are hidden unless explicitly forced).
//
// CLI:
//   node asset-library.mjs rebuild            normalize gallery derivatives + write models dirs
//   node asset-library.mjs repair             recover missing dims/labels (transcripts, then estimation)
//   node asset-library.mjs normalize [--id X] re-normalize generated GLBs to declared dims
//   node asset-library.mjs qa [--id X|--pending|--all] [--concurrency 4]
//   node asset-library.mjs dedupe             mark near-duplicate generations superseded
//   node asset-library.mjs search "query"
//   node asset-library.mjs report

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { pinnedDirSync } from '../../scripts/actor-assets/closures.mjs';

export const A3D = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(A3D, '..', '..');
export const GENERATED_ASSETS = process.env.SIMFORGE_GENERATED_ASSETS ?? path.join(A3D, 'generated-assets.json');
export const MODELS_DIR = path.join(A3D, 'models');
export const PED_MODELS = path.join(A3D, 'ped-models');
export const ASSETS_DIR = path.join(A3D, 'assets');
export const SIMFORGE_RENDER = process.env.SIMFORGE_RENDER_BIN ?? path.join(ROOT, 'renderer/target/release/simforge-render');
const GATEWAY = process.env.SIMFORGE_GATEWAY ?? 'http://127.0.0.1:4141/v1/chat/completions';
const QA_MODEL = process.env.SIMFORGE_ASSET_QA_MODEL ?? 'openai-codex/gpt-5.6-sol';
const CARLA_CATALOG = path.join(ROOT, 'catalog/vehicles-carla/catalog-models.json');
const GALLERY_TS = path.join(ROOT, 'packages/asset-catalog/src/gallery.generated.ts');
const GALLERY_DIR = path.join(ROOT, 'dev-assets/gallery-assets');
const NORMALIZER = path.join(A3D, 'normalize-glb.mjs');

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

/**
 * The CARLA packs are not in git: each is a content-addressed closure,
 * materialized by `node scripts/actor-assets/closures.mjs pull <pack>` (an
 * unmaterialized pack throws, naming that command). Their sidecars bind
 * pack-relative paths (`models/x.glb`); a repository path of the older form
 * `catalog/<pack>/models/x.glb` resolves into the same pack.
 */
function carlaGlb(glbPath) {
  return path.join(pinnedDirSync('vehicles-carla'), glbPath);
}
function repoGlb(glbPath) {
  const pack = /^catalog\/([^/]+)\/(models\/.+)$/u.exec(glbPath);
  return pack ? path.join(pinnedDirSync(pack[1]), pack[2]) : path.resolve(ROOT, glbPath);
}
const sha256File = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, cwd: ROOT, ...opts });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: (r.stderr ?? '') + (r.error ? ` [${r.error.message}]` : '') };
}

// ---------------------------------------------------------------------------
// Library model
// ---------------------------------------------------------------------------

/** Vehicle-like classes get auto-yaw (longest horizontal axis -> +X); props keep their authored facing. */
const VEHICLE_CLASSES = new Set(['vehicle', 'car', 'truck', 'bus', 'van', 'motorcycle', 'bicycle']);

/** The engine's actor catalog (`@simforge-oss/asset-catalog`): the ONLY ids a role actor may carry. */
const engineCatalog = await import('@simforge-oss/asset-catalog');
export const resolveEngineId = (id) => { try { return engineCatalog.resolveCatalogId(id) ?? null; } catch { return null; } };

/**
 * Derived live from the authoritative catalogs on every load — never cached —
 * so it cannot drift. Only generated entries persist (GENERATED_ASSETS).
 *
 * Three kinds of entry:
 *   engine  — actor ids from the engine catalog (roles). `render` says what
 *             the renderer draws for it: a CARLA GLB, a QA'd gallery derivative,
 *             or the procedural primitive. (pass b1/rr1 burned 55 iterations on
 *             CARLA blueprint ids that exist as render models but NOT as engine
 *             actor ids — those are never offered as actor ids again.)
 *   catalog-gallery / generated — PROP models (props only), QA-gated at true scale.
 */
export function loadLibrary() {
  const entries = [];
  const carla = readJson(CARLA_CATALOG).entries;
  const gallery = [];
  try {
    const ts = fs.readFileSync(GALLERY_TS, 'utf8');
    const arr = JSON.parse(ts.slice(ts.indexOf('['), ts.indexOf('] as const') + 1));
    const qa = galleryQa();
    for (const g of arr) {
      gallery.push({ id: g.id, label: g.label, description: g.description, class: g.actorClass, dims: g.dims,
        glbPath: path.join('dev-assets/gallery-assets', g.model.url.replace('/gallery-assets/', '')),
        source: 'catalog-gallery', status: qa[g.id]?.verdict ?? 'candidate', qa: qa[g.id] ?? undefined });
    }
  } catch (e) { console.error('gallery seed skipped:', String(e).slice(0, 200)); }
  const galleryById = new Map(gallery.map((g) => [g.id, g]));
  for (const id of engineCatalog.CATALOG_IDS) {
    const e = engineCatalog.getEntry(id);
    const classes = engineCatalog.actorClassesForCatalogEntry(e) ?? [];
    const g = galleryById.get(`gallery.${id}`);
    const render = carla[id] ? 'carla' : g ? (g.status === 'approved' ? 'gallery' : `gallery-${g.status}`) : 'primitive';
    entries.push({ id, label: e.label, description: e.description, class: e.actorClass ?? classes[0] ?? e.class, classes, dims: e.dims,
      source: 'engine', render, status: render === 'carla' || render === 'gallery' ? 'approved' : render === 'primitive' ? 'primitive' : 'candidate' });
  }
  // CARLA blueprint render models: renderer-side only (never actor ids).
  for (const [id, v] of Object.entries(carla)) {
    if (engineCatalog.CATALOG_IDS.includes(id)) continue;
    const m = v.model ?? v;
    entries.push({ id, label: id.replace('vehicle.', '') + ' (CARLA render model)', description: path.basename(m.glbPath, '.glb').replace(/_/g, ' '),
      class: 'vehicle', glbPath: m.glbPath, source: 'carla', status: 'approved', renderOnly: true });
  }
  entries.push(...gallery);
  if (fs.existsSync(GENERATED_ASSETS)) {
    for (const e of readJson(GENERATED_ASSETS)) entries.push({ status: 'candidate', ...e });
  }
  return { entries };
}

/** Gallery QA verdicts persist beside the derivatives (gallery entries themselves come from the catalog). */
const GALLERY_QA = path.join(MODELS_DIR, 'gallery-qa.json');
function galleryQa() { try { return readJson(GALLERY_QA); } catch { return {}; } }
function saveGalleryQa(id, qa) {
  const all = galleryQa();
  all[id] = qa;
  fs.mkdirSync(MODELS_DIR, { recursive: true });
  const tmp = `${GALLERY_QA}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 1));
  fs.renameSync(tmp, GALLERY_QA);
}

/** Persist generated entries: O_EXCL lockfile + read/merge-by-id/temp/rename. */
export function saveGeneratedEntries(lib) {
  const mine = lib.entries.filter((e) => e.source === 'generated');
  const lock = `${GENERATED_ASSETS}.lock`;
  const t0 = Date.now();
  for (;;) {
    try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); break; }
    catch {
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 10_000) { fs.rmSync(lock, { force: true }); continue; } } catch { continue; }
      if (Date.now() - t0 > 15_000) throw new Error('generated-assets lock timeout');
      const until = Date.now() + 50; while (Date.now() < until) { /* spin: sync context */ }
    }
  }
  try {
    const byId = new Map();
    try { for (const e of readJson(GENERATED_ASSETS)) byId.set(e.id, e); } catch { /* first write */ }
    for (const e of mine) byId.set(e.id, e);
    const tmp = `${GENERATED_ASSETS}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...byId.values()], null, 1));
    fs.renameSync(tmp, GENERATED_ASSETS);
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

const STATUS_RANK = { approved: 0, candidate: 1, rejected: 2 };
export function librarySearch(lib, query, { includeRejected = false, limit = 8 } = {}) {
  const terms = String(query).toLowerCase().split(/\W+/).filter((t) => t.length > 2);
  return lib.entries
    .filter((e) => !e.supersededBy && (includeRejected || e.status !== 'rejected'))
    .map((e) => {
      const head = `${e.id} ${e.label}`.toLowerCase(), body = String(e.description ?? '').toLowerCase();
      return [terms.reduce((n, t) => n + (head.includes(t) ? 3 : body.includes(t) ? 1 : 0), 0), e];
    })
    .filter(([s]) => s > 0)
    .sort((a, b) => b[0] - a[0] || (STATUS_RANK[a[1].status] ?? 1) - (STATUS_RANK[b[1].status] ?? 1))
    .slice(0, limit)
    .map(([, e]) => e);
}

// ---------------------------------------------------------------------------
// Normalization + models dirs
// ---------------------------------------------------------------------------

/** Normalize a GLB in place (or to `out`) to the actor frame at true scale. Returns {size, scale, yaw}. */
export function normalizeGlb(file, { dims, cls, out = file, yaw = null } = {}) {
  const args = [NORMALIZER, file, '--out', out];
  if (yaw !== null) args.push('--yaw', String(yaw));
  else if (!VEHICLE_CLASSES.has(cls)) args.push('--yaw', '0');
  if (dims?.l > 0 && dims?.w > 0 && dims?.h > 0) args.push('--dims', `${dims.l},${dims.w},${dims.h}`);
  const r = run(process.execPath, args);
  if (r.status !== 0) throw new Error(`normalize ${path.basename(file)}: ${r.stderr.slice(-400)}`);
  const last = r.stdout.trim().split('\n').pop();
  return JSON.parse(last);
}

/** Absolute path of the renderer-facing GLB for an entry (derived for gallery, in place for generated). */
function rendererGlb(e) {
  if (e.source === 'catalog-gallery') return path.join(MODELS_DIR, 'gallery', `${e.id}.glb`);
  if (e.source === 'carla') return carlaGlb(e.glbPath);
  return repoGlb(e.glbPath);
}

/** Per-gallery-id normalization overrides (facing flips found by QA): { "<id>": { "yaw": deg } }. */
const GALLERY_OVERRIDES = path.join(MODELS_DIR, 'gallery-overrides.json');
function galleryOverrides() { try { return readJson(GALLERY_OVERRIDES); } catch { return {}; } }
function setGalleryOverride(id, patch) {
  const all = galleryOverrides();
  all[id] = { ...(all[id] ?? {}), ...patch };
  fs.mkdirSync(MODELS_DIR, { recursive: true });
  fs.writeFileSync(GALLERY_OVERRIDES, JSON.stringify(all, null, 1));
}

/**
 * Gallery GLBs are raw generator exports too: derive normalized copies under
 * models/gallery/, cached by (source sha, dims, yaw override). Generated
 * assets are normalized at generation time; `normalize` re-derives them.
 */
function ensureGalleryDerivative(e) {
  const src = path.resolve(ROOT, e.glbPath);
  if (!fs.existsSync(src)) return null;
  const outDir = path.join(MODELS_DIR, 'gallery');
  fs.mkdirSync(outDir, { recursive: true });
  const out = rendererGlb(e);
  const stamp = `${out}.src.json`;
  const yaw = galleryOverrides()[e.id]?.yaw ?? null;
  const key = { srcSha: sha256File(src), dims: e.dims ?? null, cls: e.class, yaw };
  try {
    if (fs.existsSync(out)) { const { yawApplied, ...prev } = readJson(stamp); if (JSON.stringify(prev) === JSON.stringify(key)) return out; }
  } catch { /* rebuild */ }
  const n = normalizeGlb(src, { dims: e.dims, cls: e.class, out, yaw });
  fs.writeFileSync(stamp, JSON.stringify({ ...key, yawApplied: n.yaw }));
  return out;
}

/** One flat catalog-models.json over the whole library for the renderer, plus the pedestrian catalog. */
export function rebuildModelsDir(lib) {
  fs.mkdirSync(MODELS_DIR, { recursive: true });
  const out = {};
  const ped = {};
  const carla = readJson(CARLA_CATALOG).entries;
  for (const e of lib.entries) {
    if (e.source === 'engine') continue; // resolved below, after every model row exists
    let glb = rendererGlb(e);
    if (e.source === 'catalog-gallery') glb = ensureGalleryDerivative(e);
    if (!glb || !fs.existsSync(glb)) continue;
    const trueScale = e.source !== 'carla';
    const row = { model: { glbPath: glb, attribution: e.source, source: e.source }, tintable: e.source === 'carla', scaleToDims: !trueScale };
    if (e.class === 'pedestrian') ped[e.id] = row;
    out[e.id] = row;
  }
  // Engine actor ids draw the CARLA model of the same id when one exists,
  // else the QA-approved gallery derivative `gallery.<id>`, else nothing
  // (procedural primitive; recorded as render:'primitive' in the library).
  for (const e of lib.entries) {
    if (e.source !== 'engine') continue;
    const c = carla[e.id];
    if (c) {
      const m = c.model ?? c;
      out[e.id] = { model: { glbPath: carlaGlb(m.glbPath), attribution: 'carla', source: 'carla' }, tintable: true, scaleToDims: false };
    } else if (String(e.render).startsWith('gallery') && out[`gallery.${e.id}`]) {
      out[e.id] = out[`gallery.${e.id}`];
    }
    if (e.class === 'pedestrian' && out[e.id]) ped[e.id] = out[e.id];
  }
  // Render-side overrides (engine ids whose stock mesh audits poorly -> better GLB).
  try {
    for (const [id, o] of Object.entries(readJson(path.join(A3D, 'model-overrides.json')))) {
      out[id] = { model: { glbPath: repoGlb(o.glbPath), attribution: o.attribution ?? 'override', source: 'override' },
        tintable: o.tintable ?? false, scaleToDims: o.scaleToDims ?? false };
    }
  } catch { /* no overrides file */ }
  const stable = (obj) => Object.fromEntries(Object.keys(obj).sort().map((k) => [k, obj[k]]));
  fs.writeFileSync(path.join(MODELS_DIR, 'catalog-models.json'), JSON.stringify(stable(out), null, 2));
  // Pedestrian catalog: walker ids plus the exact library ids. The renderer resolves
  // exact catalog ids only (it never substitutes a walker for an unknown id).
  fs.mkdirSync(PED_MODELS, { recursive: true });
  const walkers = {};
  const humans = Object.entries(ped).filter(([id]) => /pedestrian\.(adult|child|elderly|worker|teen)/.test(id));
  if (humans.length) {
    humans.forEach(([id, row], i) => {
      walkers[`walker.pedestrian.${String(i + 1).padStart(4, '0')}`] = row;
      walkers[id] = row;
      walkers[id.replace(/^gallery\./, '')] = row; // engine pedestrian ids are bare (pedestrian.adult)
    });
    fs.writeFileSync(path.join(PED_MODELS, 'catalog-models.json'), JSON.stringify({ entries: stable(walkers) }, null, 2));
  }
  return { models: Object.keys(out).length, pedestrians: Object.keys(walkers).length };
}

/** Digest of everything the render fleet must mirror (catalog + every referenced GLB). */
export function libraryDigest() {
  const cat = path.join(MODELS_DIR, 'catalog-models.json');
  const h = crypto.createHash('sha256');
  if (fs.existsSync(cat)) {
    const rows = readJson(cat);
    for (const id of Object.keys(rows).sort()) {
      const p = rows[id].model.glbPath;
      let st = null; try { st = fs.statSync(p); } catch { /* missing */ }
      h.update(`${id}\t${p}\t${st ? `${st.size}:${Math.round(st.mtimeMs)}` : 'missing'}\n`);
    }
  }
  return h.digest('hex');
}

// ---------------------------------------------------------------------------
// Asset QA: render beside the ego sedan, vision verdict, status promotion
// ---------------------------------------------------------------------------

/** Flat 1200 m ground plane at y = 0 (what the retired playback binary's `--ground-plane` drew):
 *  a self-contained glTF (one quad, embedded buffer, matte grey), written once. */
function groundPlaneGltf() {
  const file = path.join(MODELS_DIR, 'qa-ground-plane.gltf');
  if (fs.existsSync(file)) return file;
  const h = 600;
  const positions = new Float32Array([-h, 0, -h, h, 0, -h, h, 0, h, -h, 0, h]);
  const normals = new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]);
  const indices = new Uint16Array([0, 2, 1, 0, 3, 2]); // counter-clockwise seen from +Y
  const bytes = Buffer.concat([Buffer.from(positions.buffer), Buffer.from(normals.buffer), Buffer.from(indices.buffer)]);
  const gltf = {
    asset: { version: '2.0', generator: 'experiments/agentic-3d asset QA' },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: 'qa-ground-plane' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
    materials: [{ name: 'ground', pbrMetallicRoughness: { baseColorFactor: [0.0953, 0.1022, 0.1144, 1], metallicFactor: 0, roughnessFactor: 0.95 } }],
    buffers: [{ byteLength: bytes.length, uri: `data:application/octet-stream;base64,${bytes.toString('base64')}` }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 48, target: 34962 },
      { buffer: 0, byteOffset: 48, byteLength: 48, target: 34962 },
      { buffer: 0, byteOffset: 96, byteLength: 12, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [-h, 0, -h], max: [h, 0, h] },
      { bufferView: 1, componentType: 5126, count: 4, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: 6, type: 'SCALAR' },
    ],
  };
  fs.mkdirSync(MODELS_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(gltf));
  return file;
}

/** The render service's scene-state stream (one simforge.scene-state.v1 document per tick): ego sedan
 *  at the origin heading +X, the asset BESIDE it on the left (same distance from the chase camera, so
 *  size compares directly). Deterministic. */
function qaScene(entry, ticks = 3) {
  const d = entry.dims ?? { l: 1, w: 1, h: 1 };
  const aheadM = Math.max(0, (d.l - 4.7) / 2) + 1.5; // long assets edge forward so nothing hides behind the ego
  const leftM = 1.82 / 2 + 1.6 + d.w / 2; // left of a +X-heading ego is -Z
  const actor = (id, kind, catalogId, actorClass, dims, position) => ({
    id, kind, catalogId, actorClass, dims, transform: { position, rotation: [0, 0, 0, 1] }, velocity: [0, 0, 0],
  });
  const stream = [];
  for (let t = 0; t < ticks; t++) {
    const kind = t === 0 ? 'spawn' : 'update';
    stream.push({
      version: 'simforge.scene-state.v1', mapId: 'asset-qa', tick: t, tickHz: 10,
      weather: { preset: 'clear' }, timeOfDay: 12, groundY: 0,
      actors: [
        actor('ego', kind, 'vehicle.sedan', 'car', { l: 4.7, w: 1.82, h: 1.45 }, [0, 0, 0]),
        actor('asset', kind, entry.id, entry.class === 'pedestrian' ? 'pedestrian' : 'car', { l: d.l, w: d.w, h: d.h }, [aheadM, 0, -leftM]),
      ],
    });
  }
  return { stream, aheadM, leftM };
}

/**
 * Render the QA views for one entry with `simforge-render job`: a chase
 * camera 9 m behind / 3 m above the ego aimed 8 m ahead of it (the retired
 * playback follow camera) and a top-down view centred between ego and asset (image
 * up = ego forward). The service never draws a proxy for a model it cannot
 * load (no allowPrimitiveActors), so a finished render drew the asset's GLB.
 * Returns { chase, top } PNG paths or throws.
 */
export function renderAssetQa(entry, outDir) {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const { stream, aheadM, leftM } = qaScene(entry);
  const scenePath = path.join(outDir, 'scene-state.json');
  fs.writeFileSync(scenePath, JSON.stringify(stream));
  const attach = (offsetM, pitchDeg) => ({ actorId: 'ego', offsetM, pitchDeg, hostVisible: true });
  const job = {
    schema: 'simforge.render-job/v2',
    scene: {
      glbs: [groundPlaneGltf()],
      lighting: { sun_elev_deg: 38, sun_azim_deg: 145, sun_lux: 28000, ambient: 0.6 },
      render: { preset: 'training' },
      warmupFrames: 40,
      vehicleModels: MODELS_DIR,
      pedestrianModels: PED_MODELS,
    },
    sceneState: scenePath,
    rig: { cameras: [
      { sensorId: 'chase', width: 736, height: 416, fovDeg: 58, eye: [0, 0, 0], target: [0, 0, 1],
        attach: attach([-9, 0, 3], -Math.atan2(3, 17) * 180 / Math.PI) },
      { sensorId: 'top', width: 736, height: 416, fovDeg: 58, eye: [0, 0, 0], target: [0, 0, 1],
        attach: attach([aheadM / 2, -leftM / 2, 14], -90) },
    ] },
    ticks: { start: 0, count: stream.length },
    passes: ['rgb'],
    outDir,
  };
  const jobPath = path.join(outDir, 'job.json');
  fs.writeFileSync(jobPath, JSON.stringify(job, null, 2));
  const r = run(SIMFORGE_RENDER, ['job', '--job', jobPath], { timeout: 180_000, killSignal: 'SIGKILL' });
  if (r.status !== 0) throw new Error(`asset QA render failed: ${r.stderr.slice(-600)}`);
  const last = String(stream.length - 1).padStart(8, '0');
  const chase = path.join(outDir, 'chase', `${last}.rgb.png`);
  const top = path.join(outDir, 'top', `${last}.rgb.png`);
  if (!fs.existsSync(chase)) throw new Error('asset QA render produced no chase frame');
  return { chase, top: fs.existsSync(top) ? top : null };
}

const imgPart = (p) => ({ type: 'image_url', image_url: { url: `data:image/${p.endsWith('.png') ? 'png' : 'jpeg'};base64,${fs.readFileSync(p).toString('base64')}` } });

async function llm(model, messages, extra = {}) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(GATEWAY, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages, max_tokens: 4000, ...extra }) });
    const body = await res.json().catch(() => ({}));
    const content = body?.choices?.[0]?.message?.content;
    if (res.ok && typeof content === 'string' && content.length > 0) return content;
    if (attempt >= 6) throw new Error(`gateway ${model}: ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, Math.min(3000 * attempt * attempt, 60000)));
  }
}
function extractJson(text) {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  for (const c of [...fenced.reverse(), text]) {
    const start = c.indexOf('{');
    if (start < 0) continue;
    for (let end = c.length; end > start; end--) {
      if (c[end - 1] !== '}') continue;
      try { return JSON.parse(c.slice(start, end)); } catch { /* shrink */ }
    }
  }
  throw new Error('no JSON in QA reply');
}

/**
 * Judge one asset from its QA render. The bar is the factory's bar: does a
 * chase-camera viewer read it as the labeled object at a plausible size next
 * to a 4.7 m sedan, with no obvious defects (floating/buried, sideways
 * vehicle, untextured, missing parts)?
 */
export async function judgeAssetQa(entry, views) {
  const d = entry.dims ?? {};
  const system = 'You are a strict visual QA reviewer for 3D props used in a driving simulator. Reply with ONE JSON object only.';
  const user = [
    { type: 'text', text: [
      `Asset id: ${entry.id}`, `Label: ${entry.label}`, `Class: ${entry.class}`,
      `Declared size (m): length ${d.l ?? '?'}, width ${d.w ?? '?'}, height ${d.h ?? '?'}`,
      `Generation prompt: ${String(entry.description ?? '').slice(0, 500)}`,
      '',
      'Image 1: chase camera 9 m behind and 3 m above a sedan (4.7 m long, 1.45 m tall) facing +X (away from the camera); the asset stands directly BESIDE the sedan on its LEFT, at the same distance from the camera, on a flat ground plane. Compare sizes directly against the sedan.',
      'Image 2 (if present): top-down view of the same scene.',
      '',
      'Answer strictly as JSON: {"reads_as_label": true|false, "scale_plausible": true|false, "grounded": true|false, "facing_ok": true|false, "textured": true|false, "defects": ["..."], "verdict": "approved"|"rejected", "reason": "one sentence"}.',
      'Rules: verdict is "approved" only if reads_as_label AND scale_plausible AND grounded AND textured are all true, and facing_ok is true for vehicle-class assets. A vehicle-class asset must face the SAME way as the sedan (front away from the chase camera; toward the top of the top-down view). For props, facing_ok is true unless the object is obviously lying on its side or upside down. Scale is plausible when the asset is within roughly 0.6x-1.6x of the real-world size a viewer would expect next to that sedan.',
    ].join('\n') },
    imgPart(views.chase),
    ...(views.top ? [imgPart(views.top)] : []),
  ];
  const reply = await llm(QA_MODEL, [{ role: 'system', content: system }, { role: 'user', content: user }]);
  const v = extractJson(reply);
  const verdict = v.verdict === 'approved' ? 'approved' : 'rejected';
  return { model: QA_MODEL, verdict, reasons: v, reply: reply.slice(0, 2000) };
}

/** Full QA for one library entry: render -> judge -> persist status + dossier next to the asset. */
export async function qaAsset(lib, entry) {
  const dir = entry.source === 'generated' ? path.join(ASSETS_DIR, entry.id, 'qa') : path.join(MODELS_DIR, 'qa', entry.id);
  let result;
  try {
    let views = renderAssetQa(entry, dir);
    let judged = await judgeAssetQa(entry, views);
    // Auto-yaw picks the longest axis but cannot know front from back: a
    // vehicle rejected ONLY for facing is flipped 180° and re-judged once.
    const r = judged.reasons ?? {};
    if (judged.verdict === 'rejected' && r.facing_ok === false && r.reads_as_label && r.grounded && r.textured &&
        VEHICLE_CLASSES.has(entry.class)) {
      let flipped = false;
      if (entry.source === 'generated') {
        const modelDir = path.join(ASSETS_DIR, entry.id);
        const raw = path.join(modelDir, 'raw.glb');
        const model = path.join(modelDir, 'model.glb');
        const yaw = ((entry.normalized?.yaw ?? 0) + 180) % 360;
        const dims = entry.declaredDims ?? entry.dims;
        try {
          normalizeGlb(fs.existsSync(raw) ? raw : model, { dims, cls: entry.class, out: model, yaw });
          entry.normalized = { ...(entry.normalized ?? {}), yaw, flipped: true };
          entry.sha256 = sha256File(model);
          flipped = true;
        } catch { /* keep the first verdict */ }
      } else if (entry.source === 'catalog-gallery') {
        let applied = 0;
        try { applied = readJson(`${rendererGlb(entry)}.src.json`).yawApplied ?? 0; } catch { /* default */ }
        setGalleryOverride(entry.id, { yaw: (applied + 180) % 360 });
        try { ensureGalleryDerivative(entry); flipped = true; } catch { /* keep the first verdict */ }
      }
      if (flipped) {
        views = renderAssetQa(entry, dir);
        judged = await judgeAssetQa(entry, views);
      }
    }
    result = { at: new Date().toISOString(), verdict: judged.verdict, model: judged.model, reasons: judged.reasons,
      chase: path.relative(ROOT, views.chase), top: views.top ? path.relative(ROOT, views.top) : null,
      sha256: entry.sha256 ?? null };
  } catch (e) {
    result = { at: new Date().toISOString(), verdict: 'rejected', error: String(e).slice(0, 600) };
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'qa.json'), JSON.stringify(result, null, 2));
  entry.status = result.verdict;
  entry.qa = { at: result.at, verdict: result.verdict, reason: result.reasons?.reason ?? result.error ?? null, sheet: result.chase ?? null, sha256: result.sha256 ?? null };
  if (entry.source === 'generated') saveGeneratedEntries(lib);
  else if (entry.source === 'catalog-gallery') saveGalleryQa(entry.id, entry.qa);
  return result;
}

// ---------------------------------------------------------------------------
// Maintenance: normalize, dedupe
// ---------------------------------------------------------------------------


/** Re-normalize generated GLBs to their declared dims (raw.glb if kept, else the in-place model, idempotently). */
export function normalizeGenerated(lib, onlyId = null) {
  const done = [];
  for (const e of lib.entries) {
    if (e.source !== 'generated' || (onlyId && e.id !== onlyId)) continue;
    const dims = e.declaredDims ?? e.dims;
    if (!dims) continue;
    const dir = path.join(ASSETS_DIR, e.id);
    const model = path.join(dir, 'model.glb');
    if (!fs.existsSync(model)) continue;
    const raw = path.join(dir, 'raw.glb');
    const src = fs.existsSync(raw) ? raw : model;
    const norm = normalizeGlb(src, { dims, cls: e.class, out: model });
    e.dims = norm.size; e.normalized = { scale: norm.scale, yaw: norm.yaw }; e.sha256 = sha256File(model);
    if (e.status === 'approved' && e.qa && e.qa.sha256 !== e.sha256) e.status = 'candidate'; // re-QA after geometry change
    done.push([e.id, norm.size]);
  }
  saveGeneratedEntries(lib);
  return done;
}

/** Near-duplicate generations (v2/v3/final/... chains, same concept): keep the best, mark the rest superseded. */
export function dedupeLibrary(lib) {
  const stem = (id) => id.replace(/^custom\./, '').replace(/[-_.]?(v\d+|final|mid|thin|runtime|solid|readable|baked|simple|realistic)(?=$|[-_.])/g, '').replace(/[-_.]+$/, '');
  const groups = new Map();
  for (const e of lib.entries) if (e.source === 'generated') { const k = stem(e.id); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(e); }
  const rank = (e) => (STATUS_RANK[e.status] ?? 1) * 1e13 - Date.parse(e.generatedAt ?? 0);
  const out = [];
  for (const [k, es] of groups) {
    if (es.length < 2) continue;
    es.sort((a, b) => rank(a) - rank(b));
    const keep = es[0];
    for (const e of es.slice(1)) { if (e.status !== 'rejected' && e.id !== keep.id) { e.supersededBy = keep.id; } }
    out.push([k, keep.id, es.slice(1).map((e) => e.id)]);
  }
  saveGeneratedEntries(lib);
  return out;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const argOf = (f, d) => { const i = process.argv.indexOf(`--${f}`); return i >= 0 ? process.argv[i + 1] : d; };
const has = (f) => process.argv.includes(`--${f}`);

async function main() {
  const cmd = process.argv[2];
  const lib = loadLibrary();
  if (cmd === 'rebuild') {
    console.log(JSON.stringify({ ...rebuildModelsDir(lib), digest: libraryDigest() }));
  } else if (cmd === 'normalize') {
    const done = normalizeGenerated(lib, argOf('id', null));
    console.log(JSON.stringify(rebuildModelsDir(lib)));
    console.log(`normalized ${done.length}: ` + done.map(([id, s]) => `${id}=${s.l}x${s.w}x${s.h}`).join(' '));
  } else if (cmd === 'qa') {
    const id = argOf('id', null);
    const targets = lib.entries.filter((e) => (e.source === 'generated' || (has('gallery') && e.source === 'catalog-gallery')) && !e.supersededBy &&
      (id ? e.id === id : has('all') ? true : (e.status ?? 'candidate') === 'candidate' || !e.qa));
    const conc = Number(argOf('concurrency', 3));
    let i = 0; const results = [];
    await Promise.all(Array.from({ length: conc }, async () => {
      while (i < targets.length) {
        const e = targets[i++];
        const r = await qaAsset(lib, e);
        results.push([e.id, r.verdict, r.reasons?.reason ?? r.error]);
        console.log(`[qa] ${e.id}: ${r.verdict} — ${r.reasons?.reason ?? r.error ?? ''}`);
      }
    }));
    const n = results.filter((r) => r[1] === 'approved').length;
    console.log(`[qa] approved ${n}/${results.length}`);
  } else if (cmd === 'dedupe') {
    for (const [k, keep, rest] of dedupeLibrary(lib)) console.log(`${k}: keep ${keep}; superseded ${rest.join(', ')}`);
  } else if (cmd === 'search') {
    for (const e of librarySearch(lib, process.argv[3] ?? '', { includeRejected: has('rejected') })) console.log(`${e.status.padEnd(9)} ${e.id} — ${e.label}`);
  } else if (cmd === 'report') {
    const by = {};
    for (const e of lib.entries) { const k = `${e.source}/${e.status ?? 'candidate'}${e.supersededBy ? '/superseded' : ''}`; by[k] = (by[k] ?? 0) + 1; }
    console.log(JSON.stringify({ entries: lib.entries.length, by, digest: libraryDigest() }, null, 1));
  } else {
    console.error('usage: asset-library.mjs rebuild|normalize|qa|dedupe|search|report');
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
