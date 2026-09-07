import type { ScenarioSimulationPreviewDto } from "../contracts";
import { fetchContentAddressedArtifact } from "../artifact-cache";
import { parsePlaybackPair, type PlaybackBundle } from "@simforge-oss/playback";
import type { SimTrace } from "@simforge-oss/engine";
import type { ScenarioWorkerEngineIdentity } from "./scenario-worker";
// v2 invalidated traces generated before static map colliders were aligned to
// the browser scene frame. v3 binds a saved simulation to the engine build and
// the immutable map closure that executed it: a trace is only ever replayed as
// the preview of the exact runtime that would otherwise recompute it, never as
// evidence for an engine or map derivative it never ran on.
const SCHEMA = "simforge.uniscenario-browser-preview/v3";

/** Everything besides the document content that determines a browser trace. */
export type SimulationPreviewRuntime = {
  readonly engine: ScenarioWorkerEngineIdentity;
  readonly mapClosureSha256: string;
};

type Stored = {
  schema: typeof SCHEMA;
  draftVersion: number;
  engine: ScenarioWorkerEngineIdentity;
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
function traceToXodrFrame(trace: PlaybackBundle["trace"]): SimTrace {
  const actors: SimTrace["ticks"]["actors"] = {};
  for (const [id, track] of Object.entries(trace.ticks.actors)) {
    const { z, ...rest } = track;
    actors[id] = { ...rest, y: z.map((value) => -value) };
  }
  return { ...trace, header: { ...trace.header, frame: "xodr-local" }, ticks: { ...trace.ticks, actors } };
}

export async function encodeSimulationPreview(bundle: PlaybackBundle, draftVersion: number, runtime: SimulationPreviewRuntime) {
  const value: Stored = {
    schema: SCHEMA,
    draftVersion,
    engine: runtime.engine,
    mapClosureSha256: runtime.mapClosureSha256,
    instance: bundle.instance,
    trace: traceToXodrFrame(bundle.trace),
    ...(bundle.ambientTraffic ? { ambientTraffic: bundle.ambientTraffic } : {}),
    ...(bundle.mapCollisions ? { mapCollisions: bundle.mapCollisions } : {}),
    ...(bundle.openScenario ? { openScenario: bundle.openScenario } : {}),
  };
  const compressed = await new Response(new Blob([JSON.stringify(value)]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
  const bytes = new Uint8Array(compressed); return { bytes, sha256: await sha256Hex(bytes) };
}

/**
 * Download a saved simulation and admit it only for `runtime`: the same
 * scenario version, the same engine build (as recorded at save time and as the
 * trace header itself claims) and the same immutable map closure. Anything
 * else is rejected so the caller recompiles instead of presenting a stale trace.
 */
export async function downloadSimulationPreview(
  descriptor: ScenarioSimulationPreviewDto,
  runtime: SimulationPreviewRuntime,
  signal?: AbortSignal,
): Promise<PlaybackBundle> {
  // Digest-addressed, so a cache hit is the same bytes by definition; the size
  // and checksum checks that used to live here moved into the cache and now
  // cover reads as well as downloads.
  const bytes = await fetchContentAddressedArtifact(
    descriptor.downloadUrl,
    { sha256: descriptor.sha256, sizeBytes: descriptor.sizeBytes },
    { signal, label: "Saved simulation" },
  );
  const json = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text(); const value = JSON.parse(json) as Partial<Stored>;
  if (value.schema !== SCHEMA || value.draftVersion !== descriptor.draftVersion) throw new Error("Saved simulation does not match this scenario version");
  if (
    value.engine?.engineVersion !== runtime.engine.engineVersion
    || value.engine.abiVersion !== runtime.engine.abiVersion
    || value.mapClosureSha256 !== runtime.mapClosureSha256
  ) throw new Error("Saved simulation was produced by a different engine or map runtime");
  const base = parsePlaybackPair(value.instance, value.trace, { instanceName: "saved scenario", traceName: "saved simulation" });
  if (base.trace.header.engineVersion !== runtime.engine.engineVersion) throw new Error("Saved simulation trace was executed by a different engine");
  return { ...base, ...(value.ambientTraffic ? { ambientTraffic: value.ambientTraffic } : {}), ...(value.mapCollisions ? { mapCollisions: value.mapCollisions } : {}), ...(value.openScenario ? { openScenario: value.openScenario } : {}) };
}
async function sha256Hex(bytes: Uint8Array) { const digest = await crypto.subtle.digest("SHA-256", bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer); return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join(""); }
