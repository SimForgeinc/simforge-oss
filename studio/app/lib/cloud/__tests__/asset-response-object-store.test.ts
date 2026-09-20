import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LOCAL_HOST_TOKEN_ENV } from "@simforge-oss/studio-host/node";

/**
 * Where `/api/simforge/maps/<id>/browser-assets/<path>` gets the bytes.
 *
 * A closure member's row says where its bytes live. When it names the map
 * cache's own bucket, the cache is the store and a miss is filled from
 * upstream. When it names a real bucket and key, the object store already has
 * them — and a host that serves closures from object storage has a
 * permanently cold cache, so filling it means asking its own upstream for its
 * own objects. That is what turned every tile into a 404.
 */

// The modules under test read SIMFORGE_CLOUD_ROOT/ORIGIN at module load, so
// every import here is deliberately deferred until the harness has set them.
const BYTES = Buffer.from("ktx2-tile-bytes");
const SHA = createHash("sha256").update(BYTES).digest("hex");

async function harness(t: { after: (fn: () => unknown) => void }) {
  const root = await mkdtemp(join(tmpdir(), "simforge-asset-response-"));
  // The cache store lays these out on first open; the tests reach it through
  // a transfer, which expects them to exist already.
  await mkdir(join(root, "map-cache", "incomplete"), { recursive: true });
  await mkdir(join(root, "map-cache", "objects"), { recursive: true });
  const previous = {
    root: process.env.SIMFORGE_CLOUD_ROOT,
    origin: process.env.SIMFORGE_CLOUD_ORIGIN,
    token: process.env[LOCAL_HOST_TOKEN_ENV],
  };
  // Signing a local-object URL needs the supervised host's control token.
  process.env[LOCAL_HOST_TOKEN_ENV] = "test-control-token";
  // Stands in for the upstream cloud: signs one download URL per member and
  // serves the bytes, so the ensure path can actually succeed.
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/blob") {
      response.setHeader("content-type", "application/octet-stream");
      response.setHeader("content-length", String(BYTES.byteLength));
      response.end(BYTES);
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      assets: Array<{ mapVersionId: string; relativePath: string }>;
    };
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      assets: body.assets.map((asset) => ({ ...asset, url: `${process.env.SIMFORGE_CLOUD_ORIGIN}/blob` })),
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  process.env.SIMFORGE_CLOUD_ROOT = root;
  process.env.SIMFORGE_CLOUD_ORIGIN = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    if (previous.root === undefined) delete process.env.SIMFORGE_CLOUD_ROOT;
    else process.env.SIMFORGE_CLOUD_ROOT = previous.root;
    if (previous.origin === undefined) delete process.env.SIMFORGE_CLOUD_ORIGIN;
    else process.env.SIMFORGE_CLOUD_ORIGIN = previous.origin;
    if (previous.token === undefined) delete process.env[LOCAL_HOST_TOKEN_ENV];
    else process.env[LOCAL_HOST_TOKEN_ENV] = previous.token;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  });
}

function get(mapVersionId: string, relativePath: string, method = "GET") {
  return new Request(
    `http://127.0.0.1/api/simforge/maps/${mapVersionId}/browser-assets/${relativePath}`,
    { method },
  );
}

test("the member's own row decides where its bytes come from", async (t) => {
  await harness(t);
  const { rememberUpstreamMap } = await import("../map-registry");
  const { serveLocalMapAsset } = await import("../asset-response");
  const mapVersionId = "usmap_object_store_member";
  rememberUpstreamMap({
    mapVersionId,
    access: "public",
    origin: process.env.SIMFORGE_CLOUD_ORIGIN!,
    registryReleaseDigest: "b".repeat(64),
    canonicalDigest: "c".repeat(64),
    browser: new Map([["3d/variants/objects/tile.ktx2", {
      sha256: SHA,
      byteLength: BYTES.byteLength,
      mediaType: "image/ktx2",
      bucket: "simforge-maps-internal",
      key: `blobs/sha256/${SHA.slice(0, 2)}/${SHA}`,
    }]]),
    semantic: new Map(),
  });

  const response = await serveLocalMapAsset(get(mapVersionId, "3d/variants/objects/tile.ktx2"), false);
  assert.equal(response.status, 302);
  const location = response.headers.get("location");
  assert.ok(location, "a redirect must carry a Location");
  const { getPresignedGetUrl } = await import("@/app/lib/s3/s3-presign");
  assert.equal(
    new URL(location, "http://127.0.0.1").pathname,
    new URL(
      await getPresignedGetUrl(`blobs/sha256/${SHA.slice(0, 2)}/${SHA}`, "simforge-maps-internal"),
      "http://127.0.0.1",
    ).pathname,
    "the redirect goes to the URL the presigner signs for that bucket and key",
  );

  // The redirect and the bytes behind it are both cacheable: a closure member
  // is content-addressed, and answering no-store made a reload re-fetch
  // thousands of tiles across the wire it already paid for.
  const redirectCacheControl = response.headers.get("cache-control");
  assert.match(redirectCacheControl ?? "", /^private, max-age=[1-9]\d{2,}$/, redirectCacheControl ?? "absent");
  assert.equal(
    new URL(location, "http://127.0.0.1").searchParams.get("response-cache-control"),
    "public, max-age=31536000, immutable",
    "the store is told to mark the object immutable",
  );

  // A HEAD asks the same question and must get the same answer, or a client
  // that probes before fetching concludes the member is gone.
  const head = await serveLocalMapAsset(get(mapVersionId, "3d/variants/objects/tile.ktx2", "HEAD"), true);
  assert.equal(head.status, 302);

  const { MAP_CACHE_BUCKET } = await import("../map-registry");
  const cacheMapVersionId = "usmap_cache_member";
  // Nothing has downloaded this member and the digest names no cached file,
  // so the ensure path runs and fails to produce bytes. What matters is that
  // it ran at all: the cache bucket is not an object-store coordinate, and
  // redirecting a client there would send it to a bucket that does not exist.
  rememberUpstreamMap({
    mapVersionId: cacheMapVersionId,
    access: "public",
    origin: process.env.SIMFORGE_CLOUD_ORIGIN!,
    registryReleaseDigest: "b".repeat(64),
    canonicalDigest: "c".repeat(64),
    browser: new Map([["3d/tile.ktx2", {
      sha256: "d".repeat(64),
      byteLength: BYTES.byteLength,
      mediaType: "image/ktx2",
      bucket: MAP_CACHE_BUCKET,
      key: `objects/${"d".repeat(64)}`,
    }]]),
    semantic: new Map(),
  });

  const cacheResponse = await serveLocalMapAsset(get(cacheMapVersionId, "3d/tile.ktx2"), false);
  assert.notEqual(cacheResponse.status, 302, "a map-cache member is never redirected to an object store");
  assert.ok(cacheResponse.status >= 400, `expected a failed fill, got ${cacheResponse.status}`);
});
