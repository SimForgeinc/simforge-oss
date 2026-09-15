/**
 * Defect classes 3 and 4, against a running server.
 *
 * Class 3: commit `e3bf1229` deleted the `POST` from the simulation-preview
 * route and the only handler from its `complete/` route. The static guard in
 * `defects/api-handlers.spec.ts` names the file the moment a handler
 * disappears; this proves the chain those handlers exist for actually
 * completes — reserve, upload, complete, read back. The nastier half of that
 * commit was `complete/`, because reserve still succeeded and the failure
 * surfaced later as a preview that never appeared.
 *
 * Class 4: `simulation-preview-store.ts` was the one store handing the
 * browser a raw absolute URL from `objectUrl()`
 * (`s3-presign.ts:23-28`, which builds `http://127.0.0.1:<port>` from
 * `SIMFORGE_API_BASE_URL ?? PORT`). The host serves its pages on
 * `localhost:<port>`, so the upload died in CORS preflight: `OPTIONS 204`
 * followed by no `PUT` at all. The fix wraps both URLs in
 * `sameOriginWhenLocal`. Asserted here as a property of the URL the server
 * hands out, which is where the defect is and is checkable without a browser.
 *
 * No browser: one host, HTTP only. That keeps this in reach on a loaded
 * machine, where the `real-world` project is not.
 */

import { createHash, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { createE2eContext, type E2eContext } from "../support/context";
import { startLocalHost, type LocalHost } from "../support/host";
import { expect, test } from "../support/fixtures";

type MapsBody = { maps?: { mapVersionId?: string; label?: string }[] };
type DocumentBody = { document?: { id?: string; draftVersion?: number } };
type Reservation = { artifactId?: string; uploadUrl?: string; headers?: Record<string, string> };
type Preview = { sha256?: string; sizeBytes?: number; draftVersion?: number; downloadUrl?: string };

/** Absolute URLs the browser must never be handed for a local object. */
function describeOrigin(url: string): string {
  return /^[a-z]+:\/\//i.test(url) ? new URL(url).origin : "(relative)";
}

async function call<T>(host: LocalHost, path: string, init: RequestInit = {}): Promise<{ status: number; body: T; text: string }> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${host.controlToken}`);
  if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(new URL(path, host.baseUrl), { ...init, headers });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text === "" ? null : JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body: body as T, text };
}

test.describe("the simulation-preview reserve → complete → read chain", () => {
  let host: LocalHost;
  let context: E2eContext;

  /*
   * The context is created here rather than taken from the `e2e` fixture.
   * A test-scoped fixture requested in `beforeAll` is disposed with the
   * first test, which deletes the data root the remaining tests' host is
   * still serving from — the host then fails readiness with no hint that a
   * teardown caused it. Owning the lifetime explicitly keeps one host for
   * the file, which is also what makes a 2.3 GB seed clone affordable.
   */
  test.beforeAll(async () => {
    const e2e = await createE2eContext({ name: "defects-live" });
    context = e2e;
    // Echoed before the host starts, not after: `DEFAULT_CLOUD_ORIGIN` in
    // `connection.ts:33` is production, so a host launched without this
    // variable would talk to it. `createE2eContext` pins and refuses
    // production; printing it makes the guarantee auditable in the log.
    // eslint-disable-next-line no-console
    console.log(`[real-stack] SIMFORGE_CLOUD_ORIGIN=${e2e.env.SIMFORGE_CLOUD_ORIGIN}`);
    // The chain needs a document bound to a real *installed* map version:
    // `reserveSimulationPreview` returns null without one. Installation is a
    // database fact, so the context clones a seeded data root rather than
    // symlinking a corpus — see `SIMFORGE_E2E_SEED_DATA_ROOT`.
    host = await startLocalHost(e2e);
  });

  test.afterAll(async () => {
    await host?.stop();
    await context?.dispose();
  });

  test("a preview reserved, uploaded and completed can be read back", async () => {
    const maps = await call<MapsBody>(host, "/api/simforge/maps");
    expect(maps.status, `listing installed maps: ${maps.text.slice(0, 400)}`).toBe(200);
    const mapVersionId = maps.body.maps?.[0]?.mapVersionId;
    expect(mapVersionId, "at least one installed map to author against").toBeTruthy();

    // The fixture is created through the product's own first-run endpoint,
    // not by inserting rows: a hand-made document would not carry the
    // dataset, map binding and draft version the chain depends on, and the
    // test would pass over a state the product can never produce.
    const created = await call<DocumentBody>(host, `/api/simforge/maps/${mapVersionId}/documents/default`, { method: "POST" });
    expect(created.status, "creating a scenario document").toBe(201);
    const documentId = created.body.document?.id;
    const draftVersion = created.body.document?.draftVersion;
    expect(documentId, "the created document's id").toBeTruthy();
    expect(typeof draftVersion, "the created document's draft version").toBe("number");

    // Before anything is reserved there is genuinely no preview. Asserting
    // the 404 first is what makes the 200 at the end mean something: without
    // it, a route that always answered 200 would look identical.
    const before = await call(host, `/api/simforge/documents/${documentId}/simulation-preview`);
    expect(before.status, "reading a preview before one exists").toBe(404);

    const bytes = gzipSync(Buffer.from(JSON.stringify({ suite: "real-stack", nonce: randomUUID() })));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const identity = { expectedVersion: draftVersion!, sha256, sizeBytes: bytes.byteLength };

    const reserved = await call<Reservation>(host, `/api/simforge/documents/${documentId}/simulation-preview`, {
      method: "POST",
      body: JSON.stringify(identity),
    });
    // The handler `e3bf1229` deleted. Without it this is 405.
    expect(reserved.status, `POST simulation-preview (405 means the handler is gone): ${reserved.text.slice(0, 200)}`).toBe(200);
    const uploadUrl = reserved.body.uploadUrl;
    expect(uploadUrl, "the reservation's upload URL").toBeTruthy();

    // Defect class 4. A local-object URL handed to a client must not carry
    // an origin: `objectUrl()` builds `http://127.0.0.1:<port>` while the
    // page is served from `localhost:<port>`, and the browser then refuses
    // the PUT in preflight. Relative is the fix, and relative is checkable
    // here without a browser.
    expect(
      describeOrigin(uploadUrl!),
      `the upload URL must be same-origin-relative, got ${uploadUrl}`,
    ).toBe("(relative)");

    const put = await fetch(new URL(uploadUrl!, host.baseUrl), {
      method: "PUT",
      headers: { authorization: `Bearer ${host.controlToken}`, ...reserved.body.headers },
      body: new Uint8Array(bytes),
    });
    expect(put.status, `uploading the reserved object: ${await put.text().catch(() => "")}`).toBeLessThan(300);

    const completed = await call(host, `/api/simforge/documents/${documentId}/simulation-preview/complete`, {
      method: "POST",
      body: JSON.stringify({ ...identity, artifactId: reserved.body.artifactId }),
    });
    // The handler whose *entire file* `e3bf1229` left without an export.
    // This is the one that matters most: reserve above still succeeded, so
    // nothing upstream reports a problem when this is missing.
    expect(completed.status, `POST simulation-preview/complete (405 means the handler is gone): ${completed.text.slice(0, 200)}`).toBe(200);

    const after = await call<Preview>(host, `/api/simforge/documents/${documentId}/simulation-preview`);
    expect(after.status, "reading the preview after completing it").toBe(200);
    // Identity, not merely presence: a chain that stores the wrong bytes or
    // the wrong draft version is broken in a way a 200 cannot show.
    expect(after.body.sha256, "the stored preview's digest").toBe(sha256);
    expect(after.body.sizeBytes, "the stored preview's size").toBe(bytes.byteLength);
    expect(after.body.draftVersion, "the draft version the preview belongs to").toBe(draftVersion);

    if (after.body.downloadUrl !== undefined) {
      // The other half of class 4: the read path handed the browser the same
      // raw absolute URL, so the preview could be stored and still fail to
      // load.
      expect(
        describeOrigin(after.body.downloadUrl),
        `the download URL must be same-origin-relative, got ${after.body.downloadUrl}`,
      ).toBe("(relative)");
    }
  });

  test("a reservation against a stale draft version is refused", async () => {
    const maps = await call<MapsBody>(host, "/api/simforge/maps");
    const mapVersionId = maps.body.maps?.[0]?.mapVersionId;
    const created = await call<DocumentBody>(host, `/api/simforge/maps/${mapVersionId}/documents/default`, { method: "POST" });
    const documentId = created.body.document?.id;
    const draftVersion = created.body.document?.draftVersion ?? 1;

    const stale = await call(host, `/api/simforge/documents/${documentId}/simulation-preview`, {
      method: "POST",
      body: JSON.stringify({
        expectedVersion: draftVersion + 41,
        sha256: createHash("sha256").update("stale").digest("hex"),
        sizeBytes: 5,
      }),
    });
    // Optimistic concurrency is the whole reason `expectedVersion` is in the
    // payload: a preview attached to a draft the author has since changed
    // describes a scenario that no longer exists. 409 keeps that honest;
    // 200 would silently bind a stale trace to a live document.
    expect(stale.status, "reserving against a draft version that is not current").toBe(409);
  });
});
