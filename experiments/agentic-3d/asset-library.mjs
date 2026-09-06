#!/usr/bin/env node
// Shared, quality-gated 3D asset library for the scenario factory.
//
// One library, three sources, one contract for the renderer:
//   - CARLA vehicles   (catalog/vehicles-carla)            — engine actor ids
//   - gallery props    (packages/asset-catalog gallery)    — Meshy exports, raw
//   - generated assets (meshy-assets.json + assets/<id>/)  — Meshy exports, raw
// Meshy exports are ~1.9-unit center-origin cubes whatever the object is. Every
// gallery/generated GLB the renderer sees is a NORMALIZED derivative: y-up,
// +X-forward, ground-origin, TRUE SCALE from the declared dims (normalize-glb.mjs).
// scen-play draws them with scaleToDims:false, so what the catalog says is what
// is drawn — no runtime length lookup that silently degrades to scale 1.0.
//
// Every generated asset is QA'd BEFORE authors may rely on it: a deterministic
// scen-play render of the asset beside the ego sedan (ground-plane world, chase
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

export const A3D = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(A3D, '..', '..');
export const MESHY_ASSETS = process.env.SIMFORGE_MESHY_ASSETS ?? path.join(A3D, 'meshy-assets.json');
export const MODELS_DIR = path.join(A3D, 'models');
export const PED_MODELS = path.join(A3D, 'ped-models');
export const ASSETS_DIR = path.join(A3D, 'assets');
export const SCEN_PLAY = path.join(ROOT, 'renderer/target/release/scen-play');
const GATEWAY = process.env.SIMFORGE_GATEWAY ?? 'http://127.0.0.1:4141/v1/chat/completions';
const QA_MODEL = process.env.SIMFORGE_ASSET_QA_MODEL ?? 'openai-codex/gpt-5.6-sol';
const MESHY_ROOT = 'https://api.meshy.ai/openapi';
const CARLA_CATALOG = path.join(ROOT, 'catalog/vehicles-carla/catalog-models.json');
const GALLERY_TS = path.join(ROOT, 'packages/asset-catalog/src/gallery.generated.ts');
const GALLERY_DIR = path.join(ROOT, 'dev-assets/gallery-assets');
const NORMALIZER = path.join(A3D, 'normalize-glb.mjs');

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
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
 * so it cannot drift. Only generated entries persist (MESHY_ASSETS).
 *
 * Three kinds of entry:
 *   engine  — actor ids from the engine catalog (roles). `render` says what
 *             scen-play draws for it: a CARLA GLB, a QA'd gallery derivative,
 *             or the procedural primitive. (pass b1/rr1 burned 55 iterations on
 *             CARLA blueprint ids that exist as render models but NOT as engine
 *             actor ids — those are never offered as actor ids again.)
 *   gallery / meshy — PROP models (props only), QA-gated at true scale.
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
        source: 'meshy-gallery', status: qa[g.id]?.verdict ?? 'candidate', qa: qa[g.id] ?? undefined });
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
  if (fs.existsSync(MESHY_ASSETS)) {
    for (const e of readJson(MESHY_ASSETS)) entries.push({ status: 'candidate', ...e });
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
export function saveMeshyEntries(lib) {
  const mine = lib.entries.filter((e) => e.source === 'meshy');
  const lock = `${MESHY_ASSETS}.lock`;
  const t0 = Date.now();
  for (;;) {
    try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); break; }
    catch {
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 10_000) { fs.rmSync(lock, { force: true }); continue; } } catch { continue; }
      if (Date.now() - t0 > 15_000) throw new Error('meshy-assets lock timeout');
      const until = Date.now() + 50; while (Date.now() < until) { /* spin: sync context */ }
    }
  }
  try {
    const byId = new Map();
    try { for (const e of readJson(MESHY_ASSETS)) byId.set(e.id, e); } catch { /* first write */ }
    for (const e of mine) byId.set(e.id, e);
    const tmp = `${MESHY_ASSETS}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...byId.values()], null, 1));
    fs.renameSync(tmp, MESHY_ASSETS);
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
  if (e.source === 'meshy-gallery') return path.join(MODELS_DIR, 'gallery', `${e.id}.glb`);
  return path.resolve(ROOT, e.glbPath);
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
 * Gallery GLBs are raw Meshy exports too: derive normalized copies under
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

/** One flat catalog-models.json over the whole library for scen-play, plus the pedestrian catalog. */
export function rebuildModelsDir(lib) {
  fs.mkdirSync(MODELS_DIR, { recursive: true });
  const out = {};
  const ped = {};
  const carla = readJson(CARLA_CATALOG).entries;
  for (const e of lib.entries) {
    if (e.source === 'engine') continue; // resolved below, after every model row exists
    let glb = rendererGlb(e);
    if (e.source === 'meshy-gallery') glb = ensureGalleryDerivative(e);
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
      out[e.id] = { model: { glbPath: path.resolve(ROOT, m.glbPath), attribution: 'carla', source: 'carla' }, tintable: true, scaleToDims: false };
    } else if (String(e.render).startsWith('gallery') && out[`gallery.${e.id}`]) {
      out[e.id] = out[`gallery.${e.id}`];
    }
    if (e.class === 'pedestrian' && out[e.id]) ped[e.id] = out[e.id];
  }
  // Render-side overrides (engine ids whose stock mesh audits poorly -> better GLB).
  try {
    for (const [id, o] of Object.entries(readJson(path.join(A3D, 'model-overrides.json')))) {
      out[id] = { model: { glbPath: path.resolve(ROOT, o.glbPath), attribution: o.attribution ?? 'override', source: 'override' },
        tintable: o.tintable ?? false, scaleToDims: o.scaleToDims ?? false };
    }
  } catch { /* no overrides file */ }
  const stable = (obj) => Object.fromEntries(Object.keys(obj).sort().map((k) => [k, obj[k]]));
  fs.writeFileSync(path.join(MODELS_DIR, 'catalog-models.json'), JSON.stringify(stable(out), null, 2));
  // Pedestrian catalog: walker ids for exact matches + generic entries; scen-play assigns
  // generic pedestrians deterministically across this list.
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

/** Minimal simforge.scene-state.v1: ego sedan at the origin heading +X, the asset BESIDE it on the
 *  left (same distance from the chase camera, so size compares directly). Deterministic. */
function qaScene(entry, ticks = 3) {
  const d = entry.dims ?? { l: 1, w: 1, h: 1 };
  const aheadM = Math.max(0, (d.l - 4.7) / 2) + 1.5; // long assets edge forward so nothing hides behind the ego
  const leftM = 1.82 / 2 + 1.6 + d.w / 2; // left of a +X-heading ego is -Z
  const asset = { id: 'asset', catalogId: entry.id, actorClass: entry.class === 'pedestrian' ? 'pedestrian' : 'car', dims: { l: d.l, w: d.w, h: d.h } };
  const frames = [];
  for (let t = 0; t < ticks; t++) {
    frames.push({ tick: t, t: t * 0.1, actors: [
      { id: 'ego', kind: t === 0 ? 'spawn' : 'update', position: [0, 0, 0], rotation: [0, 0, 0, 1], yawRad: 0, velocity: [0, 0, 0], acceleration: [0, 0, 0] },
      { id: 'asset', kind: t === 0 ? 'spawn' : 'update', position: [aheadM, 0, -leftM], rotation: [0, 0, 0, 1], yawRad: 0, velocity: [0, 0, 0], acceleration: [0, 0, 0] },
    ] });
  }
  return { version: 'simforge.scene-state.v1', mapId: 'asset-qa', frame: 'scene-yup', dt: 0.1, tickHz: 10, tickCount: ticks,
    weather: { preset: 'clear', fogDensity: 0, rainIntensity: 0, wetness: 0 }, timeOfDay: 12, profile: 'sensor', groundY: 0,
    actors: [{ id: 'ego', catalogId: 'vehicle.sedan', actorClass: 'car', dims: { l: 4.7, w: 1.82, h: 1.45 } }, asset], frames };
}

/** Render the QA views for one entry. Returns { chase, top, visuals } paths or throws. */
export function renderAssetQa(entry, outDir) {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const scenePath = path.join(outDir, 'scene.json');
  fs.writeFileSync(scenePath, JSON.stringify(qaScene(entry)));
  const args = ['--ground-plane', '--scene-state', scenePath, '--out-dir', outDir, '--camera', 'follow', '--ticks', '3', '--warmup', '40',
    '--no-id-pass', '--jpeg', '92', '--top-every', '1', '--top-dist', '4', '--top-height', '14', '--ground-y', '0',
    '--vehicle-models', MODELS_DIR, '--pedestrian-models', PED_MODELS, '--strict-models'];
  let r = run(SCEN_PLAY, args, { timeout: 180_000, killSignal: 'SIGKILL' });
  if (r.status !== 0 && /unexpected argument '--strict-models'/.test(r.stderr)) {
    r = run(SCEN_PLAY, args.filter((a) => a !== '--strict-models'), { timeout: 180_000, killSignal: 'SIGKILL' });
  }
  if (r.status !== 0) throw new Error(`asset QA render failed: ${r.stderr.slice(-600)}`);
  const chase = path.join(outDir, 'frame-0002.rgb.jpg');
  const top = path.join(outDir, 'frame-0002.top.jpg');
  if (!fs.existsSync(chase)) throw new Error('asset QA render produced no chase frame');
  let visuals = null;
  try { visuals = readJson(path.join(outDir, 'actor-visuals.json')); } catch { /* older binary */ }
  const drawn = visuals?.actors?.[entry.id]?.path?.kind ?? null;
  if (drawn && drawn !== 'glb') throw new Error(`asset QA: renderer drew ${drawn} for ${entry.id} (GLB not loaded)`);
  return { chase, top: fs.existsSync(top) ? top : null, visuals };
}

const imgPart = (p) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${fs.readFileSync(p).toString('base64')}` } });

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
  const dir = entry.source === 'meshy' ? path.join(ASSETS_DIR, entry.id, 'qa') : path.join(MODELS_DIR, 'qa', entry.id);
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
      if (entry.source === 'meshy') {
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
      } else if (entry.source === 'meshy-gallery') {
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
      drawn: views.visuals?.actors?.[entry.id]?.path ?? null, sha256: entry.sha256 ?? null };
  } catch (e) {
    result = { at: new Date().toISOString(), verdict: 'rejected', error: String(e).slice(0, 600) };
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'qa.json'), JSON.stringify(result, null, 2));
  entry.status = result.verdict;
  entry.qa = { at: result.at, verdict: result.verdict, reason: result.reasons?.reason ?? result.error ?? null, sheet: result.chase ?? null, sha256: result.sha256 ?? null };
  if (entry.source === 'meshy') saveMeshyEntries(lib);
  else if (entry.source === 'meshy-gallery') saveGalleryQa(entry.id, entry.qa);
  return result;
}

// ---------------------------------------------------------------------------
// Meshy generation (search first; generate -> normalize -> register -> QA)
// ---------------------------------------------------------------------------

function meshyKey() {
  if (process.env.MESHY_API_KEY) return process.env.MESHY_API_KEY;
  const r = run(path.join(process.env.HOME, 'bin', 'op-michaelagents'),
    ['item', 'get', 'Meshy', '--vault', 'MichaelAgents', '--fields', 'credential', '--reveal']);
  const key = r.stdout.trim();
  if (!key) throw new Error('Meshy API key unavailable (env MESHY_API_KEY or op vault)');
  return key;
}
async function meshyCall(key, method, url, payload) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${MESHY_ROOT}${url}`, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: payload ? JSON.stringify(payload) : undefined });
    const body = await res.json().catch(() => ({}));
    if (res.ok) return body;
    if (res.status === 402) throw new Error('Meshy credits exhausted');
    if (res.status !== 429 && res.status < 500) throw new Error(`Meshy ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
    if (attempt >= 5) throw new Error(`Meshy ${res.status} after ${attempt} attempts`);
    await new Promise((r) => setTimeout(r, 5000 * attempt));
  }
}
async function meshyPoll(key, taskId) {
  const deadline = Date.now() + 30 * 60 * 1000;
  while (Date.now() < deadline) {
    const task = await meshyCall(key, 'GET', `/v2/text-to-3d/${encodeURIComponent(taskId)}`);
    if (task.status === 'SUCCEEDED') return task;
    if (['FAILED', 'CANCELED'].includes(task.status)) throw new Error(`Meshy task ${task.status}: ${task.task_error?.message ?? '?'}`);
    await new Promise((r) => setTimeout(r, 15000));
  }
  throw new Error('Meshy task timed out (30 min)');
}

/** Generate, normalize to declared dims, register, QA. Returns the library entry (status set by QA). */
export async function meshyGenerate(lib, req, { qa = true } = {}) {
  if (!/^custom\.[a-z0-9][a-z0-9._-]{1,40}$/.test(String(req.assetId ?? ''))) throw new Error('assetId must match ^custom.[a-z0-9][a-z0-9._-]{1,40}$');
  if (lib.entries.some((e) => e.id === req.assetId)) throw new Error(`asset ${req.assetId} already exists — use it or pick a new id`);
  if (typeof req.prompt !== 'string' || req.prompt.length < 8 || req.prompt.length > 600) throw new Error('prompt must be 8-600 chars');
  for (const k of ['l', 'w', 'h']) {
    const v = req.dims?.[k];
    if (!(typeof v === 'number' && v > 0.05 && v < 30)) throw new Error(`dims.${k} must be a number in (0.05, 30) meters`);
  }
  const key = meshyKey();
  const finalDir = path.join(ASSETS_DIR, req.assetId);
  const dir = finalDir + '.tmp';
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  let refined, thumbnail = null, norm;
  try {
    const prev = await meshyCall(key, 'POST', '/v2/text-to-3d', { mode: 'preview', prompt: req.prompt, should_remesh: true, topology: 'triangle', target_polycount: 60000 });
    const preview = await meshyPoll(key, prev.result);
    const ref = await meshyCall(key, 'POST', '/v2/text-to-3d', { mode: 'refine', preview_task_id: preview.id });
    refined = await meshyPoll(key, ref.result);
    const glb = await fetch(refined.model_urls.glb);
    fs.writeFileSync(path.join(dir, 'raw.glb'), Buffer.from(await glb.arrayBuffer()));
    norm = normalizeGlb(path.join(dir, 'raw.glb'), { dims: req.dims, cls: req.class ?? 'prop', out: path.join(dir, 'model.glb') });
    if (refined.thumbnail_url) {
      thumbnail = path.join(dir, 'thumb.png');
      fs.writeFileSync(thumbnail, Buffer.from(await (await fetch(refined.thumbnail_url)).arrayBuffer()));
    }
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  fs.rmSync(finalDir, { recursive: true, force: true });
  fs.renameSync(dir, finalDir);
  const finalGlb = path.join(finalDir, 'model.glb');
  const entry = {
    id: req.assetId, label: req.label ?? req.assetId, description: req.prompt,
    class: req.class ?? 'prop', dims: norm.size, declaredDims: req.dims, dimsSource: 'request',
    glbPath: path.relative(ROOT, finalGlb),
    thumbnail: thumbnail ? path.relative(ROOT, path.join(finalDir, 'thumb.png')) : undefined,
    source: 'meshy', status: 'candidate', generatedAt: new Date().toISOString(), sha256: sha256File(finalGlb),
    normalized: { scale: norm.scale, yaw: norm.yaw },
  };
  lib.entries.push(entry);
  saveMeshyEntries(lib);
  rebuildModelsDir(lib);
  if (qa) await qaAsset(lib, entry);
  return entry;
}

// ---------------------------------------------------------------------------
// Maintenance: normalize, dedupe
// ---------------------------------------------------------------------------


/** Re-normalize generated GLBs to their declared dims (raw.glb if kept, else the in-place model, idempotently). */
export function normalizeGenerated(lib, onlyId = null) {
  const done = [];
  for (const e of lib.entries) {
    if (e.source !== 'meshy' || (onlyId && e.id !== onlyId)) continue;
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
  saveMeshyEntries(lib);
  return done;
}

/** Near-duplicate generations (v2/v3/final/... chains, same concept): keep the best, mark the rest superseded. */
export function dedupeLibrary(lib) {
  const stem = (id) => id.replace(/^custom\./, '').replace(/[-_.]?(v\d+|final|mid|thin|runtime|solid|readable|baked|simple|realistic)(?=$|[-_.])/g, '').replace(/[-_.]+$/, '');
  const groups = new Map();
  for (const e of lib.entries) if (e.source === 'meshy') { const k = stem(e.id); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(e); }
  const rank = (e) => (STATUS_RANK[e.status] ?? 1) * 1e13 - Date.parse(e.generatedAt ?? 0);
  const out = [];
  for (const [k, es] of groups) {
    if (es.length < 2) continue;
    es.sort((a, b) => rank(a) - rank(b));
    const keep = es[0];
    for (const e of es.slice(1)) { if (e.status !== 'rejected' && e.id !== keep.id) { e.supersededBy = keep.id; } }
    out.push([k, keep.id, es.slice(1).map((e) => e.id)]);
  }
  saveMeshyEntries(lib);
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
    const targets = lib.entries.filter((e) => (e.source === 'meshy' || (has('gallery') && e.source === 'meshy-gallery')) && !e.supersededBy &&
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
