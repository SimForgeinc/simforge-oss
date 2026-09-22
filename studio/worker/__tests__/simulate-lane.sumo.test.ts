import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import {
  hostTrafficStep,
  simulateAuthoritative,
  simulationMapClosureFromFiles,
  SUMO_RUNTIME_FILES,
} from "@simforge-oss/compiler/node";
import { traceCarriesSumoTraffic } from "@simforge-oss/engine";
import { loadSumoRuntime, PINNED_SUMO_RUNTIME_VERSION } from "@simforge-oss/engine/node";

import { readInstalledMapClosureFiles } from "../../../packages/compiler/src/maps";
import { simulateClaim, type SimulationJobClaim } from "../simulate";

/**
 * The worker lane runs a SUMO document's traffic step from nothing but its
 * claim (presigned, digest-pinned map members and the pinned runtime), and
 * produces the same trace the host's inline path produces from the installed
 * map. Needs the Richmond map with its collider and SUMO derivatives
 * (`SIMFORGE_SIM_TEST_MAP_DIR`) and the pinned runtime (`SIMFORGE_SUMO_RUNTIME_DIR`).
 */

const devAssets = path.join(process.env.XDG_DATA_HOME ?? path.join(homedir(), ".local", "share"), "simforge", "maps", "dev-assets");
const mapDir = path.resolve(process.env.SIMFORGE_SIM_TEST_MAP_DIR ?? path.join(devAssets, "richmond-field-station"));
const runtimeDir = path.resolve(process.env.SIMFORGE_SUMO_RUNTIME_DIR ?? path.join(devAssets, "sumo-runtime"));
const available = existsSync(path.join(runtimeDir, "sumo.wasm"))
  && existsSync(path.join(mapDir, "derived", "sumo", "sumo-network-manifest.json"))
  && existsSync(path.join(mapDir, "3d", "variants", "static-colliders-v1.json"));
const HOST = new URL("http://simforge-host.test");

async function files(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? files(root, relative) : Promise.resolve([relative]);
  }));
  return nested.flat();
}

async function sumoDocument() {
  const template = JSON.parse(await readFile(path.resolve(import.meta.dirname, "../../../packages/compiler/src/__fixtures__/richmond-map-bound.template.json"), "utf8"));
  return {
    ...template,
    extensions: {
      ...template.extensions,
      "studio.ambientTraffic.provider.v1": "sumo",
      "studio.ambientTraffic.profile.v1": { version: 1, preset: "city", seed: "ambient-1", maxActors: 24 },
    },
  };
}

describe("worker simulate lane with SUMO traffic", { skip: !available }, () => {
  test("runs the SUMO step from the claim alone and matches the host's trace", async () => {
    const document = await sumoDocument();
    const networkManifest = JSON.parse(await readFile(path.join(mapDir, "derived/sumo/sumo-network-manifest.json"), "utf8")) as { sha256: string };
    const served = new Map<string, string>();
    const members = await Promise.all((await files(mapDir)).filter((relativePath) => relativePath !== "closure.json").map(async (relativePath) => {
      const bytes = await readFile(path.join(mapDir, relativePath));
      served.set(`/objects/${relativePath}`, path.join(mapDir, relativePath));
      return { relativePath, sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.byteLength, downloadUrl: `/objects/${relativePath}?sig` };
    }));
    for (const file of SUMO_RUNTIME_FILES) served.set(`/runtime/${file}`, path.join(runtimeDir, file));
    const claim: SimulationJobClaim = {
      contract: "simforge.sim-job-claim/v1",
      workspaceId: "ws_sumo",
      requestKey: "a".repeat(64),
      fenceToken: "f".repeat(64),
      leaseExpiresAt: "2026-09-22T00:00:00.000Z",
      contentSha256: "c".repeat(64),
      canonicalContent: document,
      catalogEntries: [],
      map: { mapVersionId: "usmapv_sumo", mapAssetId: "richmond-field-station", browserClosureSha256: "d".repeat(64), sumoNetworkSha256: networkManifest.sha256, members },
      sumoRuntime: SUMO_RUNTIME_FILES.map((file) => ({ file, downloadUrl: `/runtime/${file}` })),
    };
    const fetched: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      assert.equal(url.origin, HOST.origin);
      fetched.push(url.pathname);
      const file = served.get(url.pathname);
      return file ? new Response(await readFile(file)) : new Response(null, { status: 404 });
    }) as typeof fetch;

    const { simulation } = await simulateClaim(claim, HOST, fetchImpl);
    assert.equal(traceCarriesSumoTraffic(simulation.trace), true);
    assert.match(simulation.trafficStepKey ?? "", /^[a-f0-9]{64}$/);
    assert.equal(simulation.traffic?.ambient.mode, "sumo");
    assert.ok(fetched.includes("/objects/derived/sumo/map.net.xml"));
    // The runtime is staged once per host (already-staged pinned files are reused, not re-downloaded).
    assert.ok(existsSync(path.join(tmpdir(), "simforge-sumo-runtime", PINNED_SUMO_RUNTIME_VERSION, "sumo.wasm")));

    // The host's path over the installed files: the same trace and key.
    const closure = await simulationMapClosureFromFiles(await readInstalledMapClosureFiles(mapDir, "richmond-field-station"), {
      mapVersionId: "usmapv_sumo", mapAssetId: "richmond-field-station", browserClosureSha256: "d".repeat(64),
    });
    const host = simulateAuthoritative({
      canonicalContent: document,
      closure,
      trafficStep: await hostTrafficStep(document, {
        sumoNetworkSha256: networkManifest.sha256,
        readMember: async (relativePath) => new Uint8Array(await readFile(path.join(mapDir, relativePath))),
        runtime: () => loadSumoRuntime(runtimeDir),
      }),
    });
    assert.equal(simulation.traceSha256, host.traceSha256);
    assert.equal(simulation.simKey, host.simKey);
  });

  test("a SUMO document on a map without a SUMO network fails as a scenario error", async () => {
    await assert.rejects(
      hostTrafficStep(await sumoDocument(), { sumoNetworkSha256: null, readMember: async () => new Uint8Array(), runtime: () => loadSumoRuntime(runtimeDir) }),
      /^Error: sumo_network_unavailable/,
    );
  });
});
