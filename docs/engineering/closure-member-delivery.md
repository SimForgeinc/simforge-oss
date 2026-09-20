# Delivering closure members to a viewer

A map closure is thousands of files. `belmont@v2`'s 512-pixel texture tier
alone is ~3,000 `3d/variants/objects/*.ktx2` members, and the viewer asks for
essentially all of them to draw one frame.

## Where they come from today

`/api/simforge/maps/<id>/<profile>-assets/<path>` authorises the member and
then answers from whichever store its row names:

- the row names the map cache's own bucket — a local install has downloaded
  the closure, and the bytes stream from the cache with range support;
- the row names a real bucket and key — the bytes are already in the object
  store and the route answers `302` to a presigned URL for them.

Both are cacheable per browser, because a closure member is content-addressed
and its bytes cannot change: the redirect is `private` for just under the
signature's life, and the presigned URL carries `response-cache-control:
public, max-age=31536000, immutable` so the object itself is kept.

## The remaining cost, and the ask for rc.70

Caching fixes the second load. The first still pays one authorised hop per
member — ~3,000 round trips to the app before ~3,000 GETs to the store — and
at 70 ms of latency that is minutes before anything renders.

The hop exists because authorisation is per member and the URL that satisfies
it is minted one at a time. What the viewer actually needs is the set of URLs
for a profile, in one answer:

> **Ask:** a host-supplied `resolveAssetUrls(mapVersionId, profile, paths[])`
> on the Studio host boundary — one authorisation pass over the requested
> members, one batch presign, one response — so a hosted viewer fetches
> closure members from the object store directly and the app is not in the
> path of every tile.

The upstream download path already has the shape: `cloud/access.ts` batches
signature requests through a URL pool for exactly this reason when it is the
client. This is the same batching, offered to a viewer rather than used by a
downloader, and it belongs on the host boundary so a local install can answer
it from the cache and a hosted one from its store.
