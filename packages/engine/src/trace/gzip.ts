/**
 * Trace file I/O.
 *
 * Canonical trace bytes (quantised, sorted keys, no whitespace) come from the
 * native runtime (`EngineRuntime.trace(...).toJson()`); this module only moves
 * them through gzip with `CompressionStream` in the browser and `node:zlib`
 * under Node. The *compressed* bytes are not guaranteed identical across those
 * two backends, so byte-comparison happens on the uncompressed canonical JSON.
 */

import type { SimTrace } from './trace.js';

// Node-only fallback: a static import would make this browser module unbundleable.
async function loadNodeZlib() {
  const specifier = ['node', 'zlib'].join(':');
  return import(/* webpackIgnore: true */ specifier);
}

export function isGzipBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

export async function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const CS = (globalThis as { CompressionStream?: typeof CompressionStream }).CompressionStream;
  if (CS) {
    const stream = new Blob([bytes.slice() as unknown as BlobPart]).stream().pipeThrough(new CS('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const { gzipSync } = await loadNodeZlib();
  return new Uint8Array(gzipSync(bytes));
}

export async function gunzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const DS = (globalThis as { DecompressionStream?: typeof DecompressionStream }).DecompressionStream;
  if (DS) {
    const stream = new Blob([bytes.slice() as unknown as BlobPart]).stream().pipeThrough(new DS('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const { gunzipSync } = await loadNodeZlib();
  return new Uint8Array(gunzipSync(bytes));
}

/** Gzip already-canonical trace JSON bytes — the `.trace.json.gz` payload. */
export async function encodeTraceGz(canonicalTraceJson: string | Uint8Array): Promise<Uint8Array> {
  return gzipBytes(typeof canonicalTraceJson === 'string' ? new TextEncoder().encode(canonicalTraceJson) : canonicalTraceJson);
}

/** Inverse of `encodeTraceGz`; also accepts uncompressed JSON bytes. Structural decode only: validate with `EngineRuntime.trace`. */
export async function decodeTraceGz(bytes: Uint8Array): Promise<SimTrace> {
  const plain = isGzipBytes(bytes) ? await gunzipBytes(bytes) : bytes;
  return JSON.parse(new TextDecoder().decode(plain)) as SimTrace;
}
