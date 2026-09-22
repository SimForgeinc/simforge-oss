import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("compile jobs download a map artifact once and re-verify the cached copy", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "compiler-map-cache-"));
  process.env.SIMFORGE_COMPILER_CACHE_DIR = root;
  const { download } = await import("../compiler-core");
  const body = Buffer.from("<OpenDRIVE/>".repeat(1000));
  const sha = createHash("sha256").update(body).digest("hex");
  let requests = 0;
  const server = createServer((_request, response) => { requests += 1; response.end(body); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/xodr`;
  const signal = AbortSignal.timeout(5000);

  assert.deepEqual(Buffer.from(await download(url, body.length, sha, signal)), body);
  assert.deepEqual(Buffer.from(await download(url, body.length, sha, signal)), body);
  assert.equal(requests, 1, "the second job reads the verified cache");

  const [prefix] = await readdir(root);
  await writeFile(join(root, prefix!, sha), Buffer.alloc(body.length));
  assert.deepEqual(Buffer.from(await download(url, body.length, sha, signal)), body);
  assert.equal(requests, 2, "a corrupted cache entry is refetched, never trusted");
});
