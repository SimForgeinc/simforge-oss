import type { SimTrace } from "@simforge-oss/engine";
import { parsePlaybackPair, type PlaybackBundle } from "./index";

// v2 invalidated traces generated before static map colliders were aligned to
// the browser scene frame. v3 binds a saved simulation to the engine build and
// the immutable map closure that executed it: a trace is only ever replayed as
// the preview of the exact runtime that would otherwise recompute it, never as
// evidence for an engine or map derivative it never ran on.
export const SIMULATION_PREVIEW_SCHEMA = "simforge.uniscenario-browser-preview/v3";

export type EngineBuildIdentity = {
  readonly engineVersion: string;
  readonly abiVersion: number;
};

/** Everything besides the document content that determines a browser trace. */
export type SimulationPreviewRuntime = {
  readonly engine: EngineBuildIdentity;
  readonly mapClosureSha256: string;
};

export type StoredSimulationPreview = {
  schema: typeof SIMULATION_PREVIEW_SCHEMA;
  draftVersion: number;
  engine: EngineBuildIdentity;
  mapClosureSha256: string;
  instance: PlaybackBundle["instance"];
  /** The engine's canonical ledger, exactly as the loader validates it. */
  trace: SimTrace;
  ambientTraffic?: PlaybackBundle["ambientTraffic"];
  mapCollisions?: PlaybackBundle["mapCollisions"];
  openScenario?: PlaybackBundle["openScenario"];
};

/**
 * Exact inverse of the engine's `traceToSceneFrame`: a playback bundle carries
 * the y-up scene copy (`x`, `z`), while `parsePlaybackPair` accepts only the
 * xodr-local ledger (`x`, `y = -z`, `frame: 'xodr-local'`). Storing the scene
 * copy made every saved simulation fail admission on download and recompile.
 */
export function traceToXodrFrame(trace: PlaybackBundle["trace"]): SimTrace {
  const actors: SimTrace["ticks"]["actors"] = {};
  for (const [id, track] of Object.entries(trace.ticks.actors)) {
    const { z, ...rest } = track;
    actors[id] = { ...rest, y: z.map((value) => -value) };
  }
  return { ...trace, header: { ...trace.header, frame: "xodr-local" }, ticks: { ...trace.ticks, actors } };
}

/** The JSON value a saved simulation stores (before compression). */
export function storedSimulationPreview(
  bundle: PlaybackBundle,
  draftVersion: number,
  runtime: SimulationPreviewRuntime,
): StoredSimulationPreview {
  return {
    schema: SIMULATION_PREVIEW_SCHEMA,
    draftVersion,
    engine: runtime.engine,
    mapClosureSha256: runtime.mapClosureSha256,
    instance: bundle.instance,
    trace: traceToXodrFrame(bundle.trace),
    ...(bundle.ambientTraffic ? { ambientTraffic: bundle.ambientTraffic } : {}),
    ...(bundle.mapCollisions ? { mapCollisions: bundle.mapCollisions } : {}),
    ...(bundle.openScenario ? { openScenario: bundle.openScenario } : {}),
  };
}

/**
 * Admit a stored simulation for one scenario version and, when given, one
 * runtime: the same engine build (as recorded at save time and as the trace
 * header itself claims) and the same immutable map closure. Anything else is
 * rejected so the caller recompiles instead of presenting a stale trace. A
 * caller without a runtime of its own (the CLI freezing a draft the browser
 * already simulated) admits whatever runtime produced the bytes.
 */
export function admitSimulationPreview(
  input: unknown,
  expected: { readonly draftVersion: number; readonly runtime?: SimulationPreviewRuntime },
): PlaybackBundle {
  const value = (input && typeof input === "object" ? input : {}) as Partial<StoredSimulationPreview>;
  if (value.schema !== SIMULATION_PREVIEW_SCHEMA || value.draftVersion !== expected.draftVersion) {
    throw new Error("Saved simulation does not match this scenario version");
  }
  const runtime = expected.runtime;
  if (
    runtime && (
      value.engine?.engineVersion !== runtime.engine.engineVersion
      || value.engine.abiVersion !== runtime.engine.abiVersion
      || value.mapClosureSha256 !== runtime.mapClosureSha256
    )
  ) throw new Error("Saved simulation was produced by a different engine or map runtime");
  const base = parsePlaybackPair(value.instance, value.trace, { instanceName: "saved scenario", traceName: "saved simulation" });
  if (base.trace.header.engineVersion !== (runtime?.engine.engineVersion ?? value.engine?.engineVersion)) {
    throw new Error("Saved simulation trace was executed by a different engine");
  }
  return {
    ...base,
    ...(value.ambientTraffic ? { ambientTraffic: value.ambientTraffic } : {}),
    ...(value.mapCollisions ? { mapCollisions: value.mapCollisions } : {}),
    ...(value.openScenario ? { openScenario: value.openScenario } : {}),
  };
}
