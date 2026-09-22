import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * Map-graph sidecars (map.xodr, topology, derived, locations, signals) come
 * through the app so their digest can be attested. Every editor and drive
 * session reads them from a worker, where only the browser's HTTP cache can
 * reuse them, so a revalidation that names the digest must answer 304 and
 * must not read the object store at all.
 */

const SHA = "ab".repeat(32);
const member = { sha256: SHA, byteLength: 8_500_000, mediaType: "application/xml" };
// A bucket that does not exist: any read of the store fails the test.
const storedAt = { bucket: "simforge-test-no-such-bucket", key: `blobs/sha256/ab/${SHA}` };

test("a revalidation naming the member's digest answers 304 without reading the store", async () => {
  const { attestedObject } = await import("../asset-response");
  for (const header of [`"${SHA}"`, `W/"${SHA}"`, `"other", "${SHA}"`, "*"]) {
    const response = await attestedObject(
      new Request("http://studio.test/api/simforge/maps/m/browser-assets/map.xodr", { headers: { "if-none-match": header } }),
      member,
      storedAt,
      false,
    );
    assert.equal(response.status, 304, header);
    assert.equal(response.headers.get("etag"), `"${SHA}"`);
    assert.equal(response.headers.get("x-content-sha256"), SHA);
    assert.equal(response.headers.get("cache-control"), "private, no-cache");
    assert.equal(response.body, null);
  }
});

test("a different or absent validator still goes to the store", async () => {
  const { attestedObject } = await import("../asset-response");
  for (const headers of [{ "if-none-match": `"${"cd".repeat(32)}"` }, {}]) {
    await assert.rejects(attestedObject(
      new Request("http://studio.test/api/simforge/maps/m/browser-assets/map.xodr", { headers }),
      member,
      storedAt,
      false,
    ));
  }
});
