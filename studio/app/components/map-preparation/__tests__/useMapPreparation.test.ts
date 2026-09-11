import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import * as React from "react";
import { JSDOM } from "jsdom";
import type { MapPreparation } from "../useMapPreparation";

/**
 * The preparation loop under a real React renderer: the sequence, the stop at a
 * failure, and what Retry and Skip do to it. jsdom because the hook is a client
 * hook and the studio app has no other browser-rendered test.
 */

type InstallState = {
  mapVersionId: string;
  profile: string;
  state: "idle" | "materializing" | "ready" | "error";
  progress: { members: number; completedMembers: number; bytes: number; completedBytes: number } | null;
  directory: string | null;
  message: string | null;
};

const CATALOG = {
  maps: [
    { mapVersionId: "map-a", label: "Alpha", closureBytes: { browser: 10, semantic: 100 } },
    { mapVersionId: "map-b", label: "Bravo", closureBytes: { browser: 20, semantic: 200 } },
    { mapVersionId: "map-c", label: "Charlie", closureBytes: { browser: 30, semantic: 300 } },
  ],
};

/** Installs that answer `ready`, except the ids in `failing`, which answer `error`. */
const failing = new Set<string>();
const started: string[] = [];

function installResponse(mapVersionId: string, method: string): InstallState {
  if (method === "POST") started.push(mapVersionId);
  const broken = failing.has(mapVersionId);
  return {
    mapVersionId,
    profile: "semantic",
    state: method === "POST" ? (broken ? "error" : "ready") : "idle",
    progress: broken ? null : { members: 2, completedMembers: 2, bytes: 100, completedBytes: 100 },
    directory: null,
    message: broken ? `${mapVersionId} failed to install` : null,
  };
}

// The hook and react-dom/client read browser globals at module scope, so the
// jsdom window has to exist before they are loaded: these specifiers are known
// but the load order is the point.
let dom: JSDOM;
let act: typeof import("react").act;
let createRoot: typeof import("react-dom/client").createRoot;
let useMapPreparation: typeof import("../useMapPreparation").useMapPreparation;

before(async () => {
  dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    url: "http://127.0.0.1:5199/onboarding/maps",
  });
  const globals = globalThis as Record<string, unknown>;
  globals.window = dom.window;
  globals.document = dom.window.document;
  // `navigator` is a getter-only global in Node; React only needs userAgent.
  Object.defineProperty(globals, "navigator", { value: dom.window.navigator, configurable: true });
  globals.HTMLElement = dom.window.HTMLElement;
  globals.Node = dom.window.Node;
  globals.Event = dom.window.Event;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  globals.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    if (url.startsWith("/api/simforge/maps/catalog")) return Response.json(CATALOG);
    const install = /^\/api\/simforge\/maps\/([^/]+)\/install/.exec(url);
    if (install) return Response.json(installResponse(decodeURIComponent(install[1]), method));
    // A finished install refreshes the host's map library; its content does
    // not matter here, only that the request succeeds.
    if (url.startsWith("/api/simforge/maps")) return Response.json({ maps: [] });
    throw new Error(`unexpected request: ${method} ${url}`);
  };

  ({ createRoot } = await import("react-dom/client"));
  ({ useMapPreparation } = await import("../useMapPreparation"));
});

after(() => dom.window.close());

beforeEach(() => {
  failing.clear();
  started.length = 0;
});

type Harness = {
  current: MapPreparation;
  render: (ids: string[]) => Promise<void>;
  unmount: () => Promise<void>;
};

async function mount(ids: string[]): Promise<Harness> {
  const harness = { current: null } as unknown as Harness;
  function Probe({ mapVersionIds }: { mapVersionIds: string[] }) {
    harness.current = useMapPreparation({ mapVersionIds });
    return null;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  harness.render = async (next) => {
    await React.act(async () => {
      root.render(React.createElement(Probe, { mapVersionIds: next }));
    });
  };
  harness.unmount = async () => {
    await React.act(async () => root.unmount());
  };
  await harness.render(ids);
  return harness;
}

/** The loop awaits a 1.5 s poll between install reads; give it real time to settle. */
async function settle() {
  await React.act(async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 50);
    await promise;
  });
}

describe("useMapPreparation", () => {
  it("installs the selection in order and reports catalog labels and sizes", async () => {
    const harness = await mount(["map-a", "map-b", "map-c"]);
    await settle();
    assert.deepEqual(
      harness.current.maps.map((row) => [row.label, row.bytes]),
      [["Alpha", 100], ["Bravo", 200], ["Charlie", 300]],
    );
    assert.equal(harness.current.phase, "idle");

    await React.act(async () => harness.current.start());
    await settle();

    assert.deepEqual(started, ["map-a", "map-b", "map-c"]);
    assert.equal(harness.current.phase, "complete");
    assert.deepEqual(harness.current.maps.map((row) => row.state), ["ready", "ready", "ready"]);
    await harness.unmount();
  });

  it("stops at a failing map, keeps its message, and never starts the rest", async () => {
    failing.add("map-b");
    const harness = await mount(["map-a", "map-b", "map-c"]);
    await settle();
    await React.act(async () => harness.current.start());
    await settle();

    assert.equal(harness.current.phase, "blocked");
    assert.deepEqual(harness.current.maps.map((row) => row.state), ["ready", "error", "pending"]);
    assert.match(harness.current.maps[1].message ?? "", /map-b failed to install/);
    assert.deepEqual(started, ["map-a", "map-b"]);
    await harness.unmount();
  });

  it("retries only the failed map and then continues the queue", async () => {
    failing.add("map-b");
    const harness = await mount(["map-a", "map-b", "map-c"]);
    await settle();
    await React.act(async () => harness.current.start());
    await settle();

    failing.clear();
    await React.act(async () => harness.current.retry("map-b"));
    await settle();

    assert.equal(harness.current.phase, "complete");
    assert.deepEqual(harness.current.maps.map((row) => row.state), ["ready", "ready", "ready"]);
    // map-a is installed once; the retry re-runs map-b and then reaches map-c.
    assert.deepEqual(started, ["map-a", "map-b", "map-b", "map-c"]);
    await harness.unmount();
  });

  it("skips a map that keeps failing and completes with the rest", async () => {
    failing.add("map-b");
    const harness = await mount(["map-a", "map-b", "map-c"]);
    await settle();
    await React.act(async () => harness.current.start());
    await settle();

    await React.act(async () => harness.current.skip("map-b"));
    await settle();

    assert.equal(harness.current.phase, "complete");
    assert.deepEqual(harness.current.maps.map((row) => row.state), ["ready", "skipped", "ready"]);
    assert.deepEqual(started, ["map-a", "map-b", "map-c"]);
    await harness.unmount();
  });
});
