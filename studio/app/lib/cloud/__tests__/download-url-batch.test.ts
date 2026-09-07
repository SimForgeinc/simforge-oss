import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("a member queued behind another signature batch resolves after its own batch completes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "simforge-signature-batch-"));
  const previousRoot = process.env.SIMFORGE_CLOUD_ROOT;
  const previousOrigin = process.env.SIMFORGE_CLOUD_ORIGIN;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ assets: body.assets.map((asset: { mapVersionId: string; relativePath: string }) => ({
      ...asset, url: `https://download.example.test/${asset.relativePath}`,
    })) }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  process.env.SIMFORGE_CLOUD_ROOT = root;
  process.env.SIMFORGE_CLOUD_ORIGIN = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    if (previousRoot === undefined) delete process.env.SIMFORGE_CLOUD_ROOT;
    else process.env.SIMFORGE_CLOUD_ROOT = previousRoot;
    if (previousOrigin === undefined) delete process.env.SIMFORGE_CLOUD_ORIGIN;
    else process.env.SIMFORGE_CLOUD_ORIGIN = previousOrigin;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const { rememberUpstreamMap, MAP_CACHE_BUCKET } = await import("../map-registry");
  const { resolveMapAssetSource } = await import("../access");
  const mapVersionId = "map_signature_batch_regression";
  const members = new Map(Array.from({ length: 512 }, (_, index) => [`member-${index}.bin`, {
    sha256: "a".repeat(64), byteLength: 1, mediaType: "application/octet-stream",
    bucket: MAP_CACHE_BUCKET, key: "objects/" + "a".repeat(64),
  }] as const));
  rememberUpstreamMap({ mapVersionId, access: "public", origin: process.env.SIMFORGE_CLOUD_ORIGIN,
    registryReleaseDigest: "b".repeat(64), canonicalDigest: "c".repeat(64), browser: members, semantic: new Map() });
  const [first, late] = await Promise.all([
    resolveMapAssetSource(`/api/simforge/maps/${mapVersionId}/browser-assets/member-0.bin`),
    resolveMapAssetSource(`/api/simforge/maps/${mapVersionId}/browser-assets/member-511.bin`),
  ]);
  assert.ok("url" in first && "url" in late);
  assert.equal(first.url, "https://download.example.test/member-0.bin");
  assert.equal(late.url, "https://download.example.test/member-511.bin");
});
