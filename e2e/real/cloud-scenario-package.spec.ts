/**
 * "Export for CLI" on a real SimCloud dev deployment: a real revision of the
 * QA workspace goes through the product's own pipeline (freeze a revision
 * from the host's simulation, wait for its OpenSCENARIO export, export the
 * package), the download link is fetched like a browser would, and the
 * container is verified with the same reader the public `simforge` CLI uses
 * (`verifyScenarioPackage`, the simforge-package crate through N-API).
 *
 * Environment (see support/env.ts; loaded from ~/.config/simforge/e2e-qa.env):
 *   SIMFORGE_E2E_DEV_ORIGIN        the dev deployment (never production)
 *   SIMFORGE_E2E_QA_EMAIL / _PASSWORD   the shared QA identity
 *   SIMFORGE_E2E_DEV_WORKSPACE_ID  optional: the workspace to export from
 *   SIMFORGE_E2E_PACKAGE_DOCUMENT_ID    optional: the document to export
 *
 * Run (the product clients are imported from source, hence the condition):
 *   cd oss && NODE_OPTIONS=--conditions=development \
 *     npx playwright test -c e2e/playwright.config.ts --project real-cloud real/cloud-scenario-package.spec.ts
 */

import { verifyScenarioPackage } from "../../packages/native-runtime/src/index";
import { createHttpStudioHost } from "../../packages/studio-host/src/http-client";
import { REQUEST_SHAPES, WORKSPACE_HEADER } from "../support/cloud";
import { E2E_ENV, envValue } from "../support/env";
import { expect, test } from "../support/fixtures";

const PACKAGE_DOCUMENT_ENV = "SIMFORGE_E2E_PACKAGE_DOCUMENT_ID";
/** The CLI version this suite reads packages as (the first public release). */
const READER_CLI = "0.2.0";

function devOrigin(): string {
  const origin = envValue(E2E_ENV.devOrigin);
  if (!origin) throw new Error(`${E2E_ENV.devOrigin} is not set`);
  const { hostname } = new URL(origin);
  if (hostname === "simforge.ai" || hostname === "www.simforge.ai") {
    throw new Error(`Refusing to export from production (${origin}); this suite runs on dev`);
  }
  return origin.replace(/\/+$/, "");
}

async function signIn(origin: string): Promise<{ token: string; workspaceId: string }> {
  const email = envValue(E2E_ENV.qaEmail);
  const password = envValue(E2E_ENV.qaPassword);
  if (!email || !password) throw new Error(`${E2E_ENV.qaEmail}/${E2E_ENV.qaPassword} are not set`);
  const headers = { "content-type": "application/json", accept: "application/json", ...REQUEST_SHAPES.nodeClient };
  const signed = await fetch(`${origin}/api/desktop/auth/sign-in`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email, password, device_label: "scenario-package-e2e" }),
  });
  expect(signed.status, "QA sign-in on dev").toBe(200);
  const token = ((await signed.json()) as { access_token?: string }).access_token;
  if (!token) throw new Error("sign-in returned no access token");
  const configured = envValue(E2E_ENV.devWorkspaceId);
  if (configured) return { token, workspaceId: configured };
  const listed = await fetch(`${origin}/api/desktop/projects/workspaces`, { headers: { ...headers, authorization: `Bearer ${token}` } });
  const workspaceId = ((await listed.json()) as { workspaces?: { id?: string }[] }).workspaces?.[0]?.id;
  if (!workspaceId) throw new Error("the QA identity has no workspace on dev");
  return { token, workspaceId };
}

test.describe("Export for CLI on dev", () => {
  test.skip(!envValue(E2E_ENV.devOrigin) || !envValue(E2E_ENV.qaEmail), "needs SIMFORGE_E2E_DEV_ORIGIN and the QA identity");

  test("a real revision exports as a scenario package the CLI's reader verifies", async () => {
    test.setTimeout(15 * 60_000);
    const origin = devOrigin();
    const { token, workspaceId } = await signIn(origin);
    const host = createHttpStudioHost({
      baseUrl: origin,
      headers: { authorization: `Bearer ${token}`, [WORKSPACE_HEADER]: workspaceId },
    });
    try {
      // The feature flag is on in dev: the host advertises the action the menu item is shown for.
      const capabilities = await host.runtime.capabilities();
      expect(capabilities.actions?.["scenario-package-export"], "dev advertises Export for CLI").toEqual({ available: true, reason: null });

      // A real document of the QA workspace: the configured one, else the first bound to a map.
      let documentId = envValue(PACKAGE_DOCUMENT_ENV);
      if (!documentId) {
        for (const dataset of await host.projects.listDatasets()) {
          const document = (await host.projects.listDocuments(dataset.id)).find((d) => d.mapVersionId);
          if (document) {
            documentId = document.id;
            break;
          }
        }
      }
      if (!documentId) throw new Error("the QA workspace on dev has no scenario bound to a map");

      // The product's pipeline, exactly as the row menu runs it.
      const revision = await host.projects.ensureRevision({ documentId });
      const xosc = await host.jobs.waitForExport(revision.revisionId, revision.exportId, { attempts: 300, intervalMs: 2_000 });
      expect(xosc.executionPackageId, "the revision's OpenSCENARIO export").toBeTruthy();
      const exported = await host.jobs.exportScenarioPackage(revision.revisionId, { form: "thin" });

      expect(exported.state).toBe("succeeded");
      expect(exported.form).toBe("thin");
      expect(exported.fileName).toMatch(new RegExp(`^[a-z0-9-]+\\.${exported.packageId.slice(0, 12)}\\.scenario\\.zip$`));
      expect(exported.cliCommand).toContain(`simforge package import ${exported.fileName}`);
      expect(exported.downloadUrl, "a download link").toBeTruthy();

      // The download, as a browser follows the link.
      const download = await fetch(exported.downloadUrl!);
      expect(download.status, "the presigned download").toBe(200);
      const bytes = new Uint8Array(await download.arrayBuffer());
      expect(bytes.byteLength).toBe(exported.sizeBytes);

      const verification = verifyScenarioPackage(bytes, { cliVersion: READER_CLI });
      expect(verification.packageId).toBe(exported.packageId);
      expect(verification.form).toBe("thin");
      expect(verification.cliCheck).toBe("passed");
      const manifest = verification.manifest as {
        producer: { app: string; minCli: string };
        scenario: { origin?: { revisionId: string } };
        provenance: { installationKind: string };
      };
      expect(manifest.producer.app).toBe("simcloud");
      expect(manifest.scenario.origin?.revisionId).toBe(revision.revisionId);
      expect(manifest.provenance.installationKind).toBe("simcloud");

      // The status route answers the same export, with a fresh link.
      const again = await host.jobs.getScenarioPackageExport(revision.revisionId, exported.exportId);
      expect(again.packageId).toBe(exported.packageId);
      expect(again.state).toBe("succeeded");

      // Exporting the same revision again is the same package (the id is the manifest digest).
      const second = await host.jobs.exportScenarioPackage(revision.revisionId, { form: "thin" });
      expect(second.packageId).toBe(exported.packageId);
    } finally {
      await fetch(`${origin}/api/desktop/revoke`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...REQUEST_SHAPES.nodeClient },
        body: "{}",
      });
    }
  });
});
