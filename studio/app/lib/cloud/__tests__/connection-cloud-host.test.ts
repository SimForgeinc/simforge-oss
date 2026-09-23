import assert from "node:assert/strict";
import { mock, test } from "node:test";

/**
 * A cloud host IS SimCloud and must never open an OS credential vault. The
 * hosted dashboard used to read the connector status on every page load, which
 * probed the server's keyring; on a Linux box with a locked Secret Service
 * that probe never returned and wedged the whole server. The connector now
 * refuses on a cloud host before any vault is touched.
 *
 * Run with --experimental-test-module-mocks (and the react-server condition): `lib/host/kind` is the module a
 * hosted deployment replaces, so the test replaces it the same way.
 */

mock.module("@/app/lib/host/kind", { namedExports: { HOST_KIND: "cloud" } });

const STATE_KEY = Symbol.for("simforge.cloud-connection");
const opened: string[] = [];
// A vault whose every call records itself; the cloud host must reach none of them.
const vault = {
  persistence: "os-vault" as const,
  async get(account: string) { opened.push(`get ${account}`); return null; },
  async set(account: string) { opened.push(`set ${account}`); },
  async delete(account: string) { opened.push(`delete ${account}`); return false; },
};
(globalThis as Record<symbol, unknown>)[STATE_KEY] = {
  loaded: null,
  vault,
  credential: null,
  pending: null,
  expiredMessage: null,
  message: null,
  refreshing: null,
  providers: null,
  providersFetch: null,
  providersRetryAt: 0,
};

test("a cloud host answers the connector status with an explicit 404 and never opens the vault", async () => {
  const { getCloudStatus, primeCloudSession, CloudConnectionError } = await import("../connection");
  await assert.rejects(getCloudStatus(), (error: unknown) =>
    error instanceof CloudConnectionError && error.code === "cloud_connector_not_served" && error.status === 404);
  await primeCloudSession();
  assert.deepEqual(opened, []);

  // The status route's error answer for that refusal.
  const { transferErrorResponse } = await import("../projects");
  const refusal = await getCloudStatus().catch((error: unknown) => error);
  const response = transferErrorResponse(refusal);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, "cloud_connector_not_served");
  assert.deepEqual(opened, []);
});
