import assert from 'node:assert/strict';

export type Tier = 'low' | 'medium' | 'render' | 'ml';
export interface TierSelection {
  readonly requested: Tier;
  readonly actual: Tier;
  readonly codec: 'uastc' | 'bc7' | 'astc';
  readonly longestEdgePx: 256 | 512 | null;
  readonly variantId: string | null;
  readonly downgradeReason: string | null;
}

// Belmont's measured first-view sliced payloads are 71.213 / 239.373 MB.
// These ceilings allow container headers + a 34–40% streaming margin, not masters.
export const TEXTURE_BUDGET_BYTES = { low: 100_000_000, medium: 320_000_000 } as const;
export const FRAME_P95_MS = 120;
export const STABILITY_MS = 8_000;

export function assertDimensions(dimensions: Record<string, number>, target: number): void {
  const rows = Object.entries(dimensions);
  let total = 0;
  let aboveLegacyCap = 0;
  assert(rows.length > 0, 'no resident texture dimensions reported');
  for (const [dimension, count] of rows) {
    assert(/^\d+x\d+$/.test(dimension) && Number.isInteger(count) && count > 0, `invalid histogram row ${dimension}:${count}`);
    const edge = Math.max(...dimension.split('x').map(Number));
    assert(edge > 0 && edge <= target, `${dimension}:${count} exceeds ${target}px target`);
    total += count;
    if (edge > 128) aboveLegacyCap += count;
  }
  assert(aboveLegacyCap / total >= 0.1,
    `${aboveLegacyCap}/${total} resident textures exceed legacy128; at least 10% required for non-degenerate tier fidelity`);
}

export interface ResidentTexture {
  url: string;
  authoredWidth: number;
  authoredHeight: number;
  width: number;
  height: number;
  allocatedMaxDimension?: number;
}
export function assertAuthoredDimensions(textures: readonly ResidentTexture[], target: number): void {
  assert(textures.length > 0, 'no resident source metadata');
  for (const texture of textures) {
    assert(texture.url && Number.isInteger(texture.authoredWidth) && texture.authoredWidth > 0
      && Number.isInteger(texture.authoredHeight) && texture.authoredHeight > 0, `invalid authored source: ${JSON.stringify(texture)}`);
    const cap = Math.min(target, texture.allocatedMaxDimension ?? target);
    let width = texture.authoredWidth, height = texture.authoredHeight;
    while (Math.max(width, height) > cap) {
      width = Math.max(1, Math.floor(width / 2));
      height = Math.max(1, Math.floor(height / 2));
    }
    assert.equal(texture.width, width, `${texture.url} loaded width does not match authored mip at ${cap}px`);
    assert.equal(texture.height, height, `${texture.url} loaded height does not match authored mip at ${cap}px`);
  }
}

export interface TextureRequest { url: string; bytes: number }
export interface NetworkTransfer {
  url: string;
  start: number;
  texture: boolean;
  chunks: { at: number; bytes: number }[];
  finished?: number;
  bytes?: number;
  failed?: string;
}
export function trafficBeforeReady(rows: readonly NetworkTransfer[], ready: number) {
  let textureBytes = 0, imagesBytes = 0, threeDBytes = 0, combinedBytes = 0;
  let textureRequests = 0;
  for (const row of rows) {
    if (row.start > ready) continue;
    const bytes = row.finished !== undefined && row.finished <= ready
      ? row.bytes!
      : row.chunks.reduce((sum, chunk) => sum + (chunk.at <= ready ? chunk.bytes : 0), 0);
    assert(Number.isFinite(bytes) && bytes >= 0, `invalid byte accounting for ${row.url}`);
    const texture = row.texture || isTextureUrl(row.url);
    const path = new URL(row.url).pathname;
    if (texture) { textureBytes += bytes; textureRequests++; }
    if (texture && /\/images\//.test(path)) imagesBytes += bytes;
    if (/\/3d\//.test(path)) threeDBytes += bytes;
    if (texture || /\/3d\//.test(path)) combinedBytes += bytes;
  }
  return { textureBytes, imagesBytes, threeDBytes, combinedBytes, textureRequests };
}
export function isTextureUrl(url: string): boolean {
  return /\.(?:ktx2|png|jpe?g|webp)(?:$|[?#])/i.test(url);
}
export function textureTraffic(requests: readonly TextureRequest[]) {
  const textures = requests.filter(row => isTextureUrl(row.url));
  const counts = new Map<string, number>();
  for (const row of textures) counts.set(row.url, (counts.get(row.url) ?? 0) + 1);
  return { bytes: textures.reduce((total, row) => total + row.bytes, 0),
    requests: textures.length, distinct: counts.size,
    duplicates: [...counts].filter(([, count]) => count > 1) };
}
export function assertNoDuplicateFetches(requests: readonly TextureRequest[]): void {
  const traffic = textureTraffic(requests);
  assert.equal(traffic.duplicates.length, 0,
    `repeated texture containers: ${JSON.stringify(traffic.duplicates.slice(0, 10))}`);
}

export class Checks {
  readonly results: { assertion: string; passed: boolean; measured: unknown; error?: string }[] = [];
  check(assertion: string, measured: unknown, test: () => void): void {
    try {
      test();
      this.results.push({ assertion, passed: true, measured });
      console.log(`PASS ${assertion}: ${JSON.stringify(measured)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.results.push({ assertion, passed: false, measured, error: message });
      console.error(`FAIL ${assertion}: ${JSON.stringify(measured)} — ${message}`);
    }
  }
  finish(): void { assert(this.results.every(row => row.passed), `${this.results.filter(row => !row.passed).length} tier assertions failed`); }
}
