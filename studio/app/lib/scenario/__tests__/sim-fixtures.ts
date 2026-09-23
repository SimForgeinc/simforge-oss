import { createHash } from "node:crypto";

import {
  gzipTrace,
  materializeTraceTraffic,
  simKey as computeSimKey,
  TRACE_SCHEMA,
  type AuthoritativeSimulation,
} from "@simforge-oss/compiler/node";
import { contentHash } from "@simforge-oss/engine";
import { runSimulation, traceDigest } from "@simforge-oss/engine/node";

import {
  LANE_LEFT,
  scenario,
  syntheticGraph,
  vehicle,
} from "../../../../../packages/engine/src/__tests__/fixtures/scenarios";

const graph = syntheticGraph();

/**
 * A real, tiny authoritative simulation (one car on a synthetic road) for
 * tests that commit revisions. Since the worker-authoritative simulation, a
 * commit resolves the draft's simulation before it freezes anything; a test
 * whose map fixture has no real closure installs this as the inline executor
 * (`setSimulationExecutorForTests`).
 */
export function fakeAuthoritativeSimulation(
  seed: string,
  map: { assetId: string; versionId: string; closureDigest?: string },
): AuthoritativeSimulation {
  const input = scenario({ seed, actors: [vehicle(graph, { id: "ego", rsl: LANE_LEFT, s: 60, speedMps: 10, cruiseSpeedMps: 10 })] });
  const result = runSimulation(input, { graph });
  const resolvedInputDigest = contentHash(result.input);
  const traceSha256 = traceDigest(result.trace);
  const traceGzip = gzipTrace(result.trace);
  const mapClosureDigest = map.closureDigest ?? "e".repeat(64);
  const traffic = materializeTraceTraffic({
    provider: "off",
    profile: {} as never,
    sourceInputDigest: resolvedInputDigest,
    map: { assetId: map.assetId, versionId: map.versionId },
    trace: result.trace,
    ambientActorIds: [],
  });
  return {
    simKey: computeSimKey({ resolvedInputDigest, mapClosureDigest, engineSemVer: "0.9.0", solverVer: "0.9.0", traceSchema: TRACE_SCHEMA }),
    traceSha256,
    authoredTraceSha256: traceSha256,
    trafficStepKey: null,
    resolvedInputDigest,
    mapClosureDigest,
    engineSemVer: "0.9.0",
    solverVer: "0.9.0",
    traceSchema: TRACE_SCHEMA,
    engineBuild: { engineVersion: "test" },
    provider: "off",
    resolved: {
      template: {} as never,
      axisUntilClamps: [],
      concrete: { input: result.input, siteId: "site", materialization: {}, ambientTraffic: { actors: [] } as never },
      resolvedInput: result.input,
      executedInput: result.input,
    },
    trace: result.trace,
    traceGzip,
    traceGzipSha256: createHash("sha256").update(traceGzip).digest("hex"),
    traffic,
    simulateMs: 1,
  };
}
