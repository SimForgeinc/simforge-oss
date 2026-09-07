import assert from "node:assert/strict";
import { after, test } from "node:test";
import { NextRequest } from "next/server";
import { LOCAL_HOST_SESSION_COOKIE, LOCAL_HOST_TOKEN_ENV, localHostSessionToken } from "@simforge-oss/studio-host/node";
import { proxy } from "./proxy";

const previous = process.env[LOCAL_HOST_TOKEN_ENV];
const token = "isolated-loopback-origin-regression-token";
process.env[LOCAL_HOST_TOKEN_ENV] = token;
after(() => {
  if (previous === undefined) delete process.env[LOCAL_HOST_TOKEN_ENV];
  else process.env[LOCAL_HOST_TOKEN_ENV] = previous;
});

function mutation(origin: string) {
  return new NextRequest("http://127.0.0.1:5339/api/simforge/maps/example-map/install", {
    method: "POST",
    headers: {
      host: "127.0.0.1:5339",
      origin,
      cookie: `${LOCAL_HOST_SESSION_COOKIE}=${localHostSessionToken(token)}`,
    },
  });
}

test("a trusted browser can mutate through its literal loopback authority", () => {
  assert.equal(proxy(mutation("http://127.0.0.1:5339")).status, 200);
});

test("the same trusted cookie does not authorize another local origin", () => {
  assert.equal(proxy(mutation("http://127.0.0.1:5340")).status, 403);
});
