import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { describe, it } from "node:test";
import { STUDIO_HOST_PROTOCOL_VERSION } from "@simforge-oss/studio-host";

import { CpuJobsClient } from "../http-client";

const TOKEN = "test-only-worker-token";

/**
 * A host whose capability document is `capabilities`, recording every path it
 * is asked for so a test can prove the worker refused *before* claiming work.
 */
async function fakeHost(capabilities: unknown) {
  const paths: string[] = [];
  const server: Server = createServer((request, response) => {
    paths.push(request.url ?? "");
    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      response.writeHead(401).end();
      return;
    }
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/simforge/host/capabilities") response.end(JSON.stringify(capabilities));
    else response.writeHead(204).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake host did not bind a TCP port");
  return {
    baseUrl: new URL(`http://127.0.0.1:${address.port}`),
    paths,
    close() {
      server.closeAllConnections();
      server.close();
    },
  };
}

function client(baseUrl: URL) {
  return new CpuJobsClient(baseUrl, TOKEN, "test-worker", ["browser"], 5_000);
}

describe("render worker host protocol handshake", () => {
  it("claims work from a host that speaks this worker's protocol version", async () => {
    const host = await fakeHost({ protocolVersion: STUDIO_HOST_PROTOCOL_VERSION, transports: ["http"] });
    try {
      await client(host.baseUrl).claim(AbortSignal.timeout(5_000));
      assert.deepEqual(host.paths, ["/api/simforge/host/capabilities", "/api/simforge/internal/cpu-jobs/claim"]);
    } finally {
      host.close();
    }
  });

  it("refuses another protocol version before claiming, naming both versions and the side to upgrade", async () => {
    const host = await fakeHost({ protocolVersion: STUDIO_HOST_PROTOCOL_VERSION + 1, transports: ["http"] });
    try {
      const error = await client(host.baseUrl).claim(AbortSignal.timeout(5_000)).then(() => null, (reason: Error) => reason);
      assert.equal(error?.name, "HostProtocolMismatch");
      assert.match(error?.message ?? "", new RegExp(`protocol ${STUDIO_HOST_PROTOCOL_VERSION + 1}.*protocol ${STUDIO_HOST_PROTOCOL_VERSION}.*upgrade the client`));
      assert.deepEqual(host.paths, ["/api/simforge/host/capabilities"], "the worker must not claim work from an incompatible host");
    } finally {
      host.close();
    }
  });

  it("refuses a host whose document predates the protocol version instead of assuming agreement", async () => {
    const host = await fakeHost({ schema: "simforge.studio-host-capabilities/v1", host: { kind: "local", version: "0.1.0" } });
    try {
      const error = await client(host.baseUrl).claim(AbortSignal.timeout(5_000)).then(() => null, (reason: Error) => reason);
      assert.equal(error?.name, "HostProtocolMismatch");
      assert.match(error?.message ?? "", /predates protocol 1.*upgrade the host/);
      assert.deepEqual(host.paths, ["/api/simforge/host/capabilities"]);
    } finally {
      host.close();
    }
  });

  it("refuses a protocol version that is not a number", async () => {
    const host = await fakeHost({ protocolVersion: "1", transports: ["http"] });
    try {
      const error = await client(host.baseUrl).claim(AbortSignal.timeout(5_000)).then(() => null, (reason: Error) => reason);
      assert.equal(error?.name, "HostProtocolMismatch");
      assert.match(error?.message ?? "", /unreadable Studio host protocol version.*upgrade the host/);
      assert.deepEqual(host.paths, ["/api/simforge/host/capabilities"]);
    } finally {
      host.close();
    }
  });
});
