import { dilateRgba } from '../alpha-dilate.js';
import { positions } from './mesh-ops.js';
import type { AttributeData, PrimitiveData } from './mesh-ops.js';

/**
 * Cross-card impostors for distant vegetation.
 *
 * A tree far away is a few dozen pixels tall; drawing its 758k triangles
 * there is pure vertex cost. The impostor is `planes` vertical cards through
 * the tree's axis (0/60/120 degrees for three) plus one horizontal card for
 * views from above: 8 triangles. Each card carries an orthographic bake of
 * the full-detail tree seen along its normal: albedo with alpha coverage and
 * a tangent-space normal map, so the renderer's own lighting (sun, sky,
 * shadows) shades it like the tree. Standard alpha-masked PBR material; no
 * runtime shader work.
 *
 * The bake is a deterministic CPU rasterizer: fixed supersampling, fixed
 * traversal order, nearest-texel sampling from a box-filtered mip chain
 * chosen per triangle, integer quantization at the end.
 */

export interface BakeTexture {
  width: number;
  height: number;
  /** Mip chain, level 0 first; RGBA8, alpha-dilated before filtering. */
  mips: Array<{ width: number; height: number; data: Uint8Array }>;
}

export interface BakeMaterial {
  baseColorFactor: [number, number, number, number];
  baseColor?: BakeTexture;
  /** TEXCOORD_n of the base colour texture. */
  texCoord: number;
  alphaMasked: boolean;
  alphaCutoff: number;
  doubleSided: boolean;
}

export interface BakePrimitive {
  data: PrimitiveData;
  material: BakeMaterial;
}

export interface ImpostorOptions {
  /** Square tile edge per card, pixels. */
  tile: number;
  /** Supersampling factor per axis. */
  supersample: number;
  /** Vertical cards. */
  planes: number;
  /** Add the horizontal card. */
  top: boolean;
}

export const DEFAULT_IMPOSTOR_OPTIONS: ImpostorOptions = { tile: 512, supersample: 2, planes: 3, top: true };

export interface ImpostorImage {
  width: number;
  height: number;
  /** RGBA8. */
  rgba: Uint8Array;
}

export interface ImpostorBake {
  albedo: ImpostorImage;
  normal: ImpostorImage;
  mesh: PrimitiveData;
  /** Covered fraction of each card's texels (sanity: a card that sees nothing is a bug). */
  coverage: number[];
  /** Largest depth extent of the tree along a card normal: the parallax the cards flatten (mesh-local metres). */
  depthExtentM: number;
}

export function textureFromRgba(width: number, height: number, rgba: Uint8Array): BakeTexture {
  const base = new Uint8Array(rgba);
  dilateRgba(base, width, height);
  const mips = [{ width, height, data: base }];
  while (mips.at(-1)!.width > 1 || mips.at(-1)!.height > 1) {
    const prev = mips.at(-1)!;
    const w = Math.max(1, prev.width >> 1);
    const h = Math.max(1, prev.height >> 1);
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        for (let c = 0; c < 4; c++) {
          let sum = 0;
          let n = 0;
          for (let dy = 0; dy < 2; dy++) {
            for (let dx = 0; dx < 2; dx++) {
              const sx = Math.min(prev.width - 1, x * 2 + dx);
              const sy = Math.min(prev.height - 1, y * 2 + dy);
              sum += prev.data[(sy * prev.width + sx) * 4 + c]!;
              n++;
            }
          }
          data[(y * w + x) * 4 + c] = Math.round(sum / n);
        }
      }
    }
    mips.push({ width: w, height: h, data });
  }
  return { width, height, mips };
}

interface Card {
  /** Plane origin (on the tree axis). */
  origin: [number, number, number];
  right: [number, number, number];
  up: [number, number, number];
  normal: [number, number, number];
  /** Extent in (right, up) plane coordinates. */
  s0: number;
  s1: number;
  t0: number;
  t1: number;
}

const dot = (a: readonly number[], b: readonly number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;

function buildCards(primitives: readonly BakePrimitive[], options: ImpostorOptions): { cards: Card[]; depthExtentM: number } {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  // Axis and top-card height from the area-weighted surface, bounds from every vertex.
  let areaSum = 0;
  let yWeighted = 0;
  for (const primitive of primitives) {
    const P = positions(primitive.data);
    for (let i = 0; i < P.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k]!, P[i + k]!);
        hi[k] = Math.max(hi[k]!, P[i + k]!);
      }
    }
    const I = primitive.data.indices;
    if (!primitive.material.alphaMasked) continue;
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t]! * 3, b = I[t + 1]! * 3, c = I[t + 2]! * 3;
      const ux = P[b]! - P[a]!, uy = P[b + 1]! - P[a + 1]!, uz = P[b + 2]! - P[a + 2]!;
      const vx = P[c]! - P[a]!, vy = P[c + 1]! - P[a + 1]!, vz = P[c + 2]! - P[a + 2]!;
      const area = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
      areaSum += area;
      yWeighted += area * (P[a + 1]! + P[b + 1]! + P[c + 1]!) / 3;
    }
  }
  const cx = (lo[0]! + hi[0]!) / 2;
  const cz = (lo[2]! + hi[2]!) / 2;
  const cards: Card[] = [];
  let depthExtentM = 0;
  const extent = (card: Omit<Card, 's0' | 's1' | 't0' | 't1'>): Card => {
    let s0 = Infinity, s1 = -Infinity, t0 = Infinity, t1 = -Infinity, d0 = Infinity, d1 = -Infinity;
    for (const primitive of primitives) {
      const P = positions(primitive.data);
      for (let i = 0; i < P.length; i += 3) {
        const p = [P[i]! - card.origin[0], P[i + 1]! - card.origin[1], P[i + 2]! - card.origin[2]];
        const s = dot(p, card.right), t = dot(p, card.up), d = dot(p, card.normal);
        s0 = Math.min(s0, s); s1 = Math.max(s1, s);
        t0 = Math.min(t0, t); t1 = Math.max(t1, t);
        d0 = Math.min(d0, d); d1 = Math.max(d1, d);
      }
    }
    depthExtentM = Math.max(depthExtentM, d1 - d0);
    return { ...card, s0, s1, t0, t1 };
  };
  for (let i = 0; i < options.planes; i++) {
    const theta = (i * Math.PI) / options.planes;
    const normal: [number, number, number] = [Math.cos(theta), 0, Math.sin(theta)];
    // right = up x normal: the viewer at +normal sees `right` to its right.
    const right: [number, number, number] = [Math.sin(theta), 0, -Math.cos(theta)];
    cards.push(extent({ origin: [cx, 0, cz], right, up: [0, 1, 0], normal }));
  }
  if (options.top) {
    const y = areaSum > 0 ? yWeighted / areaSum : (lo[1]! + hi[1]!) / 2;
    cards.push(extent({ origin: [cx, y, cz], right: [1, 0, 0], up: [0, 0, -1], normal: [0, 1, 0] }));
  }
  return { cards, depthExtentM };
}

function sampleNearest(texture: BakeTexture, level: number, u: number, v: number, out: Float64Array): void {
  const mip = texture.mips[Math.min(texture.mips.length - 1, Math.max(0, level))]!;
  const fu = u - Math.floor(u);
  const fv = v - Math.floor(v);
  const x = Math.min(mip.width - 1, Math.floor(fu * mip.width));
  const y = Math.min(mip.height - 1, Math.floor(fv * mip.height));
  const o = (y * mip.width + x) * 4;
  out[0] = mip.data[o]! / 255;
  out[1] = mip.data[o + 1]! / 255;
  out[2] = mip.data[o + 2]! / 255;
  out[3] = mip.data[o + 3]! / 255;
}

const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (c: number): number => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

/**
 * Bake the cards. Returns the atlas (tiles in a grid, `planes + top` tiles),
 * and the 8-triangle impostor mesh with POSITION/NORMAL/TANGENT/TEXCOORD_0
 * in the source mesh's local space.
 */
export function bakeImpostor(primitives: readonly BakePrimitive[], options: ImpostorOptions = DEFAULT_IMPOSTOR_OPTIONS): ImpostorBake {
  const { cards, depthExtentM } = buildCards(primitives, options);
  const columns = Math.ceil(Math.sqrt(cards.length));
  const rows = Math.ceil(cards.length / columns);
  const tile = options.tile;
  const ss = options.supersample;
  const width = columns * tile;
  const height = rows * tile;
  const albedoOut = new Uint8Array(width * height * 4);
  const normalOut = new Uint8Array(width * height * 4);
  const coverage: number[] = [];
  const meshPositions: number[] = [];
  const meshNormals: number[] = [];
  const meshTangents: number[] = [];
  const meshUvs: number[] = [];
  const meshIndices: number[] = [];
  const sample = new Float64Array(4);

  cards.forEach((card, cardIndex) => {
    const size = tile * ss;
    const margin = 2 * ss;
    const spanS = Math.max(card.s1 - card.s0, 1e-6);
    const spanT = Math.max(card.t1 - card.t0, 1e-6);
    const scale = (size - 2 * margin) / Math.max(spanS, spanT);
    const offsetX = (size - spanS * scale) / 2;
    const offsetY = (size - spanT * scale) / 2;
    const depth = new Float64Array(size * size).fill(-Infinity);
    const color = new Float64Array(size * size * 3);
    const nrm = new Float64Array(size * size * 3);
    const hit = new Uint8Array(size * size);
    for (const primitive of primitives) {
      const data = primitive.data;
      const material = primitive.material;
      const P = positions(data);
      const N = data.attributes.get('NORMAL')?.data;
      const uvAttribute: AttributeData | undefined = data.attributes.get(`TEXCOORD_${material.texCoord}`);
      const UV = uvAttribute?.data;
      const texture = material.baseColor;
      const I = data.indices;
      const project = (v: number): [number, number, number] => {
        const px = P[v * 3]! - card.origin[0], py = P[v * 3 + 1]! - card.origin[1], pz = P[v * 3 + 2]! - card.origin[2];
        const s = px * card.right[0] + py * card.right[1] + pz * card.right[2];
        const t = px * card.up[0] + py * card.up[1] + pz * card.up[2];
        const d = px * card.normal[0] + py * card.normal[1] + pz * card.normal[2];
        return [(s - card.s0) * scale + offsetX, (card.t1 - t) * scale + offsetY, d];
      };
      for (let tri = 0; tri < I.length; tri += 3) {
        const ia = I[tri]!, ib = I[tri + 1]!, ic = I[tri + 2]!;
        const a = project(ia), b = project(ib), c = project(ic);
        const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
        if (Math.abs(area) < 1e-12) continue;
        const minX = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])));
        const maxX = Math.min(size - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
        const minY = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])));
        const maxY = Math.min(size - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
        if (minX > maxX || minY > maxY) continue;
        // Mip level: texels per pixel of this triangle.
        let level = 0;
        if (texture && UV) {
          const tw = texture.width, th = texture.height;
          const uvArea = Math.abs((UV[ib * 2]! - UV[ia * 2]!) * (UV[ic * 2 + 1]! - UV[ia * 2 + 1]!) - (UV[ib * 2 + 1]! - UV[ia * 2 + 1]!) * (UV[ic * 2]! - UV[ia * 2]!)) * tw * th;
          level = Math.max(0, Math.floor(0.5 * Math.log2(Math.max(uvArea / Math.abs(area), 1))));
        }
        for (let y = minY; y <= maxY; y++) {
          for (let x = minX; x <= maxX; x++) {
            const sx = x + 0.5, sy = y + 0.5;
            const w0 = ((b[0] - sx) * (c[1] - sy) - (b[1] - sy) * (c[0] - sx)) / area;
            const w1 = ((c[0] - sx) * (a[1] - sy) - (c[1] - sy) * (a[0] - sx)) / area;
            const w2 = 1 - w0 - w1;
            if (w0 < 0 || w1 < 0 || w2 < 0) continue;
            const d = w0 * a[2] + w1 * b[2] + w2 * c[2];
            const pixel = y * size + x;
            if (d <= depth[pixel]!) continue;
            let r = material.baseColorFactor[0], g = material.baseColorFactor[1], bl = material.baseColorFactor[2], al = material.baseColorFactor[3];
            if (texture && UV) {
              const u = w0 * UV[ia * 2]! + w1 * UV[ib * 2]! + w2 * UV[ic * 2]!;
              const v = w0 * UV[ia * 2 + 1]! + w1 * UV[ib * 2 + 1]! + w2 * UV[ic * 2 + 1]!;
              sampleNearest(texture, level, u, v, sample);
              r *= srgbToLinear(sample[0]!); g *= srgbToLinear(sample[1]!); bl *= srgbToLinear(sample[2]!); al *= sample[3]!;
            }
            if (material.alphaMasked && al < material.alphaCutoff) continue;
            depth[pixel] = d;
            hit[pixel] = 1;
            color[pixel * 3] = r;
            color[pixel * 3 + 1] = g;
            color[pixel * 3 + 2] = bl;
            let nx = 0, ny = 0, nz = 1;
            if (N) {
              const wx = w0 * N[ia * 3]! + w1 * N[ib * 3]! + w2 * N[ic * 3]!;
              const wy = w0 * N[ia * 3 + 1]! + w1 * N[ib * 3 + 1]! + w2 * N[ic * 3 + 1]!;
              const wz = w0 * N[ia * 3 + 2]! + w1 * N[ib * 3 + 2]! + w2 * N[ic * 3 + 2]!;
              nx = wx * card.right[0] + wy * card.right[1] + wz * card.right[2];
              ny = wx * card.up[0] + wy * card.up[1] + wz * card.up[2];
              nz = wx * card.normal[0] + wy * card.normal[1] + wz * card.normal[2];
              // A double-sided surface faces whoever looks at it.
              if (nz < 0 && material.doubleSided) { nx = -nx; ny = -ny; nz = -nz; }
              const len = Math.hypot(nx, ny, nz) || 1;
              nx /= len; ny /= len; nz /= len;
            }
            nrm[pixel * 3] = nx;
            nrm[pixel * 3 + 1] = ny;
            nrm[pixel * 3 + 2] = nz;
          }
        }
      }
    }
    // Resolve the supersampled tile into the atlas.
    const column = cardIndex % columns;
    const row = Math.floor(cardIndex / columns);
    let covered = 0;
    for (let y = 0; y < tile; y++) {
      for (let x = 0; x < tile; x++) {
        let hits = 0, r = 0, g = 0, b = 0, nx = 0, ny = 0, nz = 0;
        for (let dy = 0; dy < ss; dy++) {
          for (let dx = 0; dx < ss; dx++) {
            const p = (y * ss + dy) * size + (x * ss + dx);
            if (!hit[p]) continue;
            hits++;
            r += color[p * 3]!; g += color[p * 3 + 1]!; b += color[p * 3 + 2]!;
            nx += nrm[p * 3]!; ny += nrm[p * 3 + 1]!; nz += nrm[p * 3 + 2]!;
          }
        }
        const o = (((row * tile) + y) * width + column * tile + x) * 4;
        if (hits === 0) {
          normalOut[o] = 128; normalOut[o + 1] = 128; normalOut[o + 2] = 255; normalOut[o + 3] = 255;
          continue;
        }
        covered++;
        albedoOut[o] = Math.round(255 * linearToSrgb(r / hits));
        albedoOut[o + 1] = Math.round(255 * linearToSrgb(g / hits));
        albedoOut[o + 2] = Math.round(255 * linearToSrgb(b / hits));
        albedoOut[o + 3] = Math.round((255 * hits) / (ss * ss));
        const len = Math.hypot(nx, ny, nz) || 1;
        normalOut[o] = Math.round(255 * (nx / len * 0.5 + 0.5));
        normalOut[o + 1] = Math.round(255 * (ny / len * 0.5 + 0.5));
        normalOut[o + 2] = Math.round(255 * (nz / len * 0.5 + 0.5));
        normalOut[o + 3] = 255;
      }
    }
    coverage.push(covered / (tile * tile));
    // The card quad: exactly the baked rectangle.
    const toPlane = (px: number, py: number): [number, number] => [card.s0 + (px - offsetX) / scale, card.t1 - (py - offsetY) / scale];
    const corners: Array<[number, number]> = [[margin, margin], [size - margin, margin], [size - margin, size - margin], [margin, size - margin]];
    const base = meshPositions.length / 3;
    for (const [px, py] of corners) {
      const [s, t] = toPlane(px, py);
      meshPositions.push(
        card.origin[0] + card.right[0] * s + card.up[0] * t,
        card.origin[1] + card.right[1] * s + card.up[1] * t,
        card.origin[2] + card.right[2] * s + card.up[2] * t,
      );
      meshNormals.push(...card.normal);
      meshTangents.push(...card.right, 1);
      meshUvs.push((column * tile + px / ss) / width, (row * tile + py / ss) / height);
    }
    // Counter-clockwise seen from +normal.
    meshIndices.push(base, base + 3, base + 2, base, base + 2, base + 1);
  });
  dilateRgba(albedoOut, width, height);
  const f32 = (values: number[]) => Float32Array.from(values);
  const attribute = (data: Float32Array, components: number, type: AttributeData['type']): AttributeData => ({ data, components, componentType: 5126, normalized: false, type });
  const mesh: PrimitiveData = {
    attributes: new Map([
      ['POSITION', attribute(f32(meshPositions), 3, 'VEC3')],
      ['NORMAL', attribute(f32(meshNormals), 3, 'VEC3')],
      ['TANGENT', attribute(f32(meshTangents), 4, 'VEC4')],
      ['TEXCOORD_0', attribute(f32(meshUvs), 2, 'VEC2')],
    ]),
    indices: Uint32Array.from(meshIndices),
  };
  return { albedo: { width, height, rgba: albedoOut }, normal: { width, height, rgba: normalOut }, mesh, coverage, depthExtentM };
}
