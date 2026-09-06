#!/usr/bin/env node
// Normalize a generated GLB into the actor frame expected by the renderer
// (catalog/vehicles-carla/CONVENTIONS.md): y-up, +X-forward, ground-origin
// (min y = 0), footprint centered, and TRUE SCALE in meters.
//
// Meshy exports are center-origin, arbitrarily faced, and sized to a ~1.9-unit
// bounding cube regardless of what the object is. Without this step every
// generated model renders half underground, sideways, and at toy scale (a
// 4.6 m tractor drew 1.9 m long in passes 2-17: scen-play's scaleToDims needs
// a manifest length the loop never wrote, so scale stayed 1.0).
//
// Usage: node normalize-glb.mjs <model.glb> [--yaw 90|auto] [--dims l,w,h] [--out <path>]
//   --dims: declared real-world size (l along +X after yaw, w along Z, h along Y).
//           The model is scaled UNIFORMLY by the median of the three per-axis
//           ratios (robust to one loosely-declared axis); the achieved size is
//           printed as JSON on the last stdout line: {"size":{"l","w","h"},"scale"}.

import path from 'node:path';

const argOf = (f, d) => { const i = process.argv.indexOf(`--${f}`); return i >= 0 ? process.argv[i + 1] : d; };
const file = process.argv[2];
if (!file) { console.error('usage: normalize-glb.mjs <model.glb> [--yaw deg|auto] [--dims l,w,h] [--out path]'); process.exit(1); }
const yawDeg = Number(argOf('yaw', 'auto'));
const out = argOf('out', file);
const dimsArg = argOf('dims', null);
const dims = dimsArg ? (() => { const [l, w, h] = dimsArg.split(',').map(Number); return { l, w, h }; })() : null;
if (dims && !(dims.l > 0 && dims.w > 0 && dims.h > 0)) { console.error('--dims must be three positive numbers l,w,h'); process.exit(1); }

const { NodeIO } = await import('@gltf-transform/core');
const io = new NodeIO();
const doc = await io.read(file);

/** World-space AABB over every mesh instance (node transforms applied). */
function bbox() {
  const min = [1e9, 1e9, 1e9], max = [-1e9, -1e9, -1e9];
  const visit = (node, parent) => {
    const m = mul(parent, node.getMatrix());
    const mesh = node.getMesh();
    if (mesh) for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      if (!pos) continue;
      const mn = pos.getMin([]), mx = pos.getMax([]);
      for (const x of [mn[0], mx[0]]) for (const y of [mn[1], mx[1]]) for (const z of [mn[2], mx[2]]) {
        const p = xform(m, [x, y, z]);
        for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], p[i]); max[i] = Math.max(max[i], p[i]); }
      }
    }
    for (const c of node.listChildren()) visit(c, m);
  };
  for (const scene of doc.getRoot().listScenes()) for (const n of scene.listChildren()) visit(n, IDENT);
  if (min[0] > max[0]) throw new Error('GLB has no positioned geometry');
  return { min, max, size: max.map((v, i) => v - min[i]) };
}
const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function mul(a, b) { // column-major 4x4
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
function xform(m, p) {
  return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
}

// If a previous normalization wrapper exists, unwrap it so the operation is idempotent.
const scene = doc.getRoot().listScenes()[0];
for (const n of scene.listChildren()) {
  if (n.getName() === 'actor_frame_normalized') {
    for (const c of n.listChildren()) { n.removeChild(c); scene.addChild(c); }
    scene.removeChild(n); n.dispose();
  }
}

const b = bbox();
// auto yaw: put the longest horizontal axis along X.
const yaw = Number.isFinite(yawDeg) ? yawDeg : (b.size[2] > b.size[0] ? 90 : 0);
const rad = (yaw * Math.PI) / 180;
const rot = [0, Math.sin(rad / 2), 0, Math.cos(rad / 2)];
const c = Math.cos(rad), s = Math.sin(rad);
const corners = [];
for (const x of [b.min[0], b.max[0]]) for (const z of [b.min[2], b.max[2]]) corners.push([x * c + z * s, -x * s + z * c]);
const rx = corners.map((p) => p[0]), rz = corners.map((p) => p[1]);
const rotated = { l: Math.max(...rx) - Math.min(...rx), w: Math.max(...rz) - Math.min(...rz), h: b.size[1] };

let scale = 1;
if (dims) {
  const ratios = [dims.l / rotated.l, dims.w / rotated.w, dims.h / rotated.h].filter(Number.isFinite).sort((a, z) => a - z);
  scale = ratios[Math.floor(ratios.length / 2)];
  if (!(scale > 0)) throw new Error('degenerate scale');
}
const t = [-(Math.min(...rx) + Math.max(...rx)) / 2 * scale, -b.min[1] * scale, -(Math.min(...rz) + Math.max(...rz)) / 2 * scale];

// Wrap all scene roots under one normalizing node so existing transforms are preserved.
const wrapper = doc.createNode('actor_frame_normalized').setRotation(rot).setScale([scale, scale, scale]).setTranslation(t);
for (const n of scene.listChildren()) { scene.removeChild(n); wrapper.addChild(n); }
scene.addChild(wrapper);
await io.write(out, doc);
const size = { l: +(rotated.l * scale).toFixed(3), w: +(rotated.w * scale).toFixed(3), h: +(rotated.h * scale).toFixed(3) };
console.error(`[normalize] ${path.basename(file)}: yaw ${yaw}deg, scale ${scale.toFixed(4)}, translate [${t.map((v) => v.toFixed(2))}] -> ${out}`);
console.error(`[normalize] pre-bbox size [${b.size.map((v) => v.toFixed(2))}] -> size l/w/h ${size.l}/${size.w}/${size.h} m`);
console.log(JSON.stringify({ size, scale, yaw }));
