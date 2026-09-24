"use client";

import type { AmbientTrafficProvenance, SimScenarioInput, SimTrace } from "@simforge-oss/engine";
import { parsePlaybackPair, scenarioInstanceEnvelope, type PlaybackBundle } from "@simforge-oss/playback";
import type { ScenarioSimulationResultDto } from "@simforge-oss/studio-host";

import { fetchContentAddressedArtifact } from "../artifact-cache";

/**
 * The editor's view of one authoritative simulation.
 *
 * The editor always runs its own local WASM simulation (the instant "Local
 * preview"). When the host's authoritative result for the same saved draft
 * arrives, equal trace digests mean the preview *is* the authoritative trace
 * ("Verified"); anything else is a determinism bug: the authoritative trace is
 * shown instead, flagged, and reported.
 */
export type SimulationVerificationState =
  /** Unsaved edits, or no authoritative result yet: the preview is the editor's own run. */
  | { readonly status: "local"; readonly detail?: string }
  /** The host is simulating this saved draft (inline, or queued on a CPU runner). */
  | { readonly status: "verifying"; readonly queued?: boolean }
  | { readonly status: "verified"; readonly simKey: string; readonly traceSha256: string; readonly engineSemVer: string }
  | {
      readonly status: "mismatch";
      readonly simKey: string;
      readonly localTraceSha256: string | null;
      readonly authoritativeTraceSha256: string;
      /** True once the authoritative trace replaced the local preview on screen. */
      readonly showingAuthoritative: boolean;
    }
  /**
   * The host could not simulate the saved draft. `message` is its reason (else `failureCode`);
   * `retriesRemaining` is how many explicit retries the host still allows, null from a host
   * that predates explicit retries (the editor then only re-checks).
   */
  | {
      readonly status: "failed";
      readonly failureCode: string;
      readonly message: string | null;
      readonly retriesRemaining: number | null;
    }
  | { readonly status: "unavailable"; readonly message: string };

/** The digest a local preview is compared against: SUMO documents preview their authored actors only. */
export function comparableTraceSha256(result: ScenarioSimulationResultDto): readonly string[] {
  return result.trafficProvider === "sumo"
    ? [result.authoredTraceSha256, result.traceSha256]
    : [result.traceSha256];
}

async function gunzipJson(bytes: Uint8Array): Promise<unknown> {
  const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const text = await new Response(new Blob([body]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
  return JSON.parse(text) as unknown;
}

/** The authoritative trace, served from Cache Storage under its `traceSha256` when present. */
export async function loadAuthoritativeTrace(result: ScenarioSimulationResultDto, signal?: AbortSignal): Promise<SimTrace> {
  const bytes = await fetchContentAddressedArtifact(
    result.trace.downloadUrl,
    { sha256: result.trace.gzipSha256, sizeBytes: result.trace.sizeBytes, cacheKey: `trace/${result.traceSha256}` },
    { signal, label: "Authoritative simulation" },
  );
  return await gunzipJson(bytes) as SimTrace;
}

type ResolutionRecord = {
  readonly contract: string;
  readonly resolvedInput: SimScenarioInput;
  readonly materialization: Record<string, unknown>;
  readonly ambientTraffic: AmbientTrafficProvenance;
};

async function loadResolution(result: ScenarioSimulationResultDto, signal?: AbortSignal): Promise<ResolutionRecord> {
  const bytes = await fetchContentAddressedArtifact(
    result.resolution.downloadUrl,
    { sha256: result.resolution.sha256, sizeBytes: result.resolution.sizeBytes },
    { signal, label: "Simulation resolution" },
  );
  return await gunzipJson(bytes) as ResolutionRecord;
}

/**
 * A playback bundle replaying the authoritative trace. The local instance is
 * reused when it is the exact input the trace ran; otherwise the instance is
 * rebuilt from the result's resolution record, the same way the editor worker
 * builds its own.
 */
export async function authoritativePlaybackBundle(
  result: ScenarioSimulationResultDto,
  local: PlaybackBundle | null,
  signal?: AbortSignal,
): Promise<PlaybackBundle> {
  const trace = await loadAuthoritativeTrace(result, signal);
  const source = { instanceName: "authoritative scenario", traceName: "authoritative simulation" };
  if (local && local.instance.manifest.inputHash === trace.header.inputHash) {
    return {
      ...parsePlaybackPair(local.instance, trace, source),
      ...(local.ambientTraffic ? { ambientTraffic: local.ambientTraffic } : {}),
      ...(local.mapCollisions ? { mapCollisions: local.mapCollisions } : {}),
      traceSha256: result.traceSha256,
    };
  }
  const resolution = await loadResolution(result, signal);
  const instance = scenarioInstanceEnvelope(resolution.materialization, resolution.resolvedInput, resolution.ambientTraffic);
  return {
    ...parsePlaybackPair(instance, trace, source),
    ambientTraffic: resolution.ambientTraffic,
    ...(local?.mapCollisions ? { mapCollisions: local.mapCollisions } : {}),
    traceSha256: result.traceSha256,
  };
}
