import { join } from "node:path";
import { readLocalHostState } from "../../packages/studio-host/src/node/local-host-state";
import { expect, test, writeEvidence } from "../support";

/**
 * The harness's own proof: a Studio host really starts against an isolated
 * data root, the production trusted-session bootstrap is what lets the page
 * in, and nothing weaker than that is accepted.
 */
test.describe("local host bootstrap", () => {
  test("boots an isolated host and renders Studio through a trusted local session", async ({ e2e, studio }, testInfo) => {
    const record = await readLocalHostState({ SIMFORGE_CLOUD_ROOT: e2e.dataRoot });
    expect(record, `no host.json under ${e2e.dataRoot}`).not.toBeNull();
    expect(new URL(record!.baseUrl).port).toBe(new URL(studio.baseUrl).port);

    const capabilities = await studio.api<{
      host: { kind: string };
      identity: { mode: string };
      persistence: { kind: string; dataRoot: string };
    }>("/api/simforge/host/capabilities");
    expect(capabilities.host.kind).toBe("local");
    expect(capabilities.identity.mode).toBe("fixed-local");
    // The host persisted into this test's sandbox, not the developer's data root.
    expect(capabilities.persistence.dataRoot).toBe(e2e.dataRoot);

    await expect(studio.page.getByTestId("app-topbar")).toBeVisible();
    expect(new URL(studio.page.url()).pathname).toBe("/dashboard/scenario");

    await writeEvidence(e2e, "host-bootstrap", {
      mode: studio.mode,
      route: new URL(studio.page.url()).pathname,
      capabilities: { host: capabilities.host, identity: { mode: capabilities.identity.mode }, persistence: { kind: capabilities.persistence.kind } },
      isolated: { dataRoot: e2e.dataRoot, mapsCacheRoot: e2e.mapsCacheRoot, hostRecord: join(e2e.dataRoot, "host.json") },
      evidenceFor: testInfo.title,
    });
  });

  test("refuses application traffic without the trusted local session", async ({ studio }) => {
    const anonymous = await fetch(studio.url("/api/simforge/host/capabilities"));
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toMatchObject({ error: "local_access_denied" });

    const forgedBearer = await fetch(studio.url("/api/simforge/host/capabilities"), {
      headers: { authorization: "Bearer not-the-control-token" },
    });
    expect(forgedBearer.status).toBe(401);
  });
});
