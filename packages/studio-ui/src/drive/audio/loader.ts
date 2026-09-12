/**
 * Sample loading, shared per AudioContext.
 *
 * Traffic puts a dozen cars of the same family on the road at once and they
 * all want the same loops, so decoded buffers are cached against the context
 * rather than the voice. The cache holds the promise, not the buffer, so two
 * cars created in the same frame issue one fetch between them.
 */

const caches = new WeakMap<BaseAudioContext, Map<string, Promise<AudioBuffer>>>();

/** Fetch and decode `url`, or join the decode already in flight for it. */
export function loadSample(ctx: BaseAudioContext, url: string): Promise<AudioBuffer> {
  let cache = caches.get(ctx);
  if (!cache) {
    cache = new Map();
    caches.set(ctx, cache);
  }
  const hit = cache.get(url);
  if (hit) return hit;
  const pending = fetch(url)
    .then(async (response) => {
      if (!response.ok) throw new Error(`drive audio: ${url} -> HTTP ${response.status}`);
      return ctx.decodeAudioData(await response.arrayBuffer());
    })
    .catch((cause: unknown) => {
      // A failed decode must not poison the cache: the next car should retry
      // rather than inherit a rejected promise forever.
      cache.delete(url);
      throw cause;
    });
  cache.set(url, pending);
  return pending;
}
