import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { it } from "node:test";
import { RenderControlClient } from "../render-control-client.js";

it("accepts the deployed legacy response namespace but rejects unrelated namespaces and wrong response tags", async () => {
  let schema = "uniscenario.render-worker-control/v2";
  let type = "job.none";
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(request.url, "/api/simforge/internal/render-jobs/lease");
    assert.equal(request.headers.authorization, "Bearer test-token");
    assert.equal(body.schema, "simforge.render-worker-control/v2");
    assert.equal(body.type, "job.claim");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ schema, type, retryAfterMs: 2000 }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const client = new RenderControlClient(new URL(`http://127.0.0.1:${address.port}`), "test-token", "worker", {
    async uploadNativeArtifact() { throw new Error("unexpected upload"); },
  });
  try {
    assert.equal((await client.claim("registration", AbortSignal.timeout(5000))).type, "job.none");
    schema = "unrelated.render-worker-control/v2";
    await assert.rejects(client.claim("registration", AbortSignal.timeout(5000)));
    schema = "simforge.render-worker-control/v2";
    type = "job.claimed";
    await assert.rejects(client.claim("registration", AbortSignal.timeout(5000)));
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
});
