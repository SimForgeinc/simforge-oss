import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  STUDIO_HOST_CAPABILITIES_SCHEMA,
  STUDIO_HOST_PROTOCOL_VERSION,
  type StudioHostCapabilities,
} from "@simforge-oss/studio-host";
import { SIGN_OUT_PATH, signOutOfHost, switcherAccountKind } from "../account-session";

/**
 * Which account line the app switcher shows, and what signing out does.
 *
 * The switcher used to show one thing to everybody: a SimCloud connection
 * chip reading "Signed out — Sign in", linking to `/dashboard/simcloud`. On a
 * host whose identity IS an account that is wrong twice over — the person is
 * signed in to that very host, and the page it points at says the surface
 * does not apply there.
 */

function report(overrides: {
  kind: "local" | "cloud";
  mode: "fixed-local" | "account";
}): StudioHostCapabilities {
  return {
    schema: STUDIO_HOST_CAPABILITIES_SCHEMA,
    protocolVersion: STUDIO_HOST_PROTOCOL_VERSION,
    transports: ["http"],
    host: { kind: overrides.kind, label: "host", version: null },
    identity: {
      mode: overrides.mode,
      userId: "u_1",
      workspaceId: "ws_1",
      organizationId: null,
      displayName: "Ada Lovelace",
    },
    persistence: overrides.kind === "cloud"
      ? { kind: "managed-postgres-object-storage" }
      : { kind: "pglite-filesystem", dataRoot: "/home/me/.simforge" },
    execution: {
      browserSimulation: true,
      renderWorkers: {},
      workerNodes: [],
      nativeRuntime: { state: "unavailable", code: "not_installed", reason: "none", searchedPaths: [] },
    },
    jobs: { families: [], survivesUiClose: false },
  };
}

describe("the app switcher's account line", () => {
  it("offers a SimCloud connection on a local install, and while the host is still unknown", () => {
    assert.equal(switcherAccountKind(report({ kind: "local", mode: "fixed-local" })), "cloud-connection");
    assert.equal(
      switcherAccountKind(null),
      "cloud-connection",
      "an unanswered host behaves as every install did before this question existed",
    );
  });

  it("shows the host's own account instead, on a host whose identity is an account", () => {
    assert.equal(switcherAccountKind(report({ kind: "cloud", mode: "account" })), "host-account");
  });

  it("claims no account on a cloud host that has not reported one", () => {
    assert.equal(switcherAccountKind(report({ kind: "cloud", mode: "fixed-local" })), "none");
  });
});

describe("signing out of a host", () => {
  it("ends the session at the host's own route and leaves for the landing page", async () => {
    const calls: string[] = [];
    const navigated: string[] = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${String(input)}`);
      return Response.json({ ok: true });
    }) as typeof fetch;
    try {
      await signOutOfHost((href) => navigated.push(href));
    } finally {
      globalThis.fetch = previousFetch;
    }
    assert.deepEqual(calls, [`POST ${SIGN_OUT_PATH}`]);
    assert.deepEqual(navigated, ["/"]);
  });

  it("leaves anyway when the request fails, rather than stranding the person signed in", async () => {
    const navigated: string[] = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    try {
      await signOutOfHost((href) => navigated.push(href));
    } finally {
      globalThis.fetch = previousFetch;
    }
    assert.deepEqual(navigated, ["/"]);
  });
});
