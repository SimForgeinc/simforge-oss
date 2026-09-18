const LOCAL_OBJECTS = "/api/local-objects/";

/**
 * Where a worker reaches the local object store.
 *
 * The store is served by the very host the worker claimed its work from, which
 * is why `local-object-auth.ts` deliberately leaves the authority out of the
 * signature. So every object URL is resolved against that host: a relative URL
 * the obvious way, and an absolute local-object URL by replacing its authority.
 * Any other absolute URL is passed through byte-for-byte.
 *
 * This existed twice, in two different shapes. The CPU-job client honoured an
 * env knob (`SIMFORGE_WORKER_OBJECT_BASE_URL`) that re-based local-object URLs
 * onto a configured origin; the compiler client fetched whatever origin the
 * server had invented, with no knob and no fallback. A host bound to a network
 * address (`simforge daemon --hostname 100.72.252.40`) mints its object URLs
 * from `SIMFORGE_API_BASE_URL`, whose default is `http://127.0.0.1:<port>` —
 * an address such a host is not listening on. The compiler's map downloads then
 * failed with a bare `TypeError: fetch failed`, which surfaced as an export
 * whose `errorCode` was the single word `fetch`, and took every render of that
 * scenario with it.
 *
 * One rule, both clients, no configuration: the host that handed out the work
 * is the host that holds the bytes.
 */
export function hostObjectUrl(value: string, baseUrl: URL): string {
  const url = new URL(value, baseUrl);
  if (url.origin === baseUrl.origin || !url.pathname.startsWith(LOCAL_OBJECTS)) return url.href;
  const rebased = new URL(baseUrl.origin);
  rebased.pathname = url.pathname;
  rebased.search = url.search;
  rebased.hash = url.hash;
  return rebased.href;
}
