import {
  createDisabledMaterializedTrafficArtifact,
  MaterializedTrafficRecorder,
  type MaterializedTrafficArtifactEnvelope,
  type MaterializedTrafficFrameActor,
  type AmbientProfileMissingDefault,
  type ResolvedAmbientTrafficProfile,
  ambientProfileMissingDefault,
  ambientTrafficProfileFromExtensions,
} from "@simforge-oss/engine";
import type { PlaybackBundle } from "../model";
import { ambientTrafficProviderFromExtensions, type AmbientTrafficProviderId } from "./provider";
export type RevisionTrafficMap = { sourceMapId: string; mapVersionId: string; sumoNetworkSha256?: string | null };

/**
 * Authored controllers must be the only signal authority. The browser SUMO
 * bridge cannot inject their tlLogic, so match Scenario Studio by running
 * native engine traffic—which consumes the compiled signal book—in that case.
 */
export function previewExecutionTrafficProvider(
  provider: AmbientTrafficProviderId,
  hasAuthoredMapSignals: boolean,
): AmbientTrafficProviderId {
  return provider === "sumo" && hasAuthoredMapSignals ? "native" : provider;
}

/**
 * `missing` is what an absent profile means for this document
 * (`ambientProfileMissingDefault(content)`: `off` once it has a pinned
 * `simulation` block). A malformed profile throws `AmbientTrafficProfileError`.
 */
export function previewAmbientTrafficProfile(
  provider: AmbientTrafficProviderId,
  extensions: Readonly<Record<string, unknown>> | undefined,
  hasAuthoredMapSignals: boolean,
  missing: AmbientProfileMissingDefault = "legacy-city",
): ResolvedAmbientTrafficProfile {
  return previewExecutionTrafficProvider(provider, hasAuthoredMapSignals) === "native"
    ? ambientTrafficProfileFromExtensions(extensions, missing)
    : ambientTrafficProfileFromExtensions({
        "studio.ambientTraffic.profile.v1": {
          version: 1,
          preset: "off",
          seed: "execution-provider-off",
        },
      });
}

/** Build deterministic renderer/off traffic bytes only after an explicit export/render action. */
export function materializeBrowserRevisionTraffic(
  provider: Exclude<AmbientTrafficProviderId, "sumo">,
  profile: ResolvedAmbientTrafficProfile,
  map: RevisionTrafficMap,
  bundle: PlaybackBundle,
): MaterializedTrafficArtifactEnvelope {
  if (provider === "off") {
    return createDisabledMaterializedTrafficArtifact({
      sourceInputDigest: bundle.instance.manifest.inputHash,
      map: { assetId: map.sourceMapId, versionId: map.mapVersionId },
      fixedStepSeconds: bundle.trace.header.dt,
      durationSeconds: bundle.endTime - bundle.startTime,
    });
  }

  const recorder = new MaterializedTrafficRecorder({
    sourceInputDigest: bundle.instance.manifest.inputHash,
    map: { assetId: map.sourceMapId, versionId: map.mapVersionId },
    provider: {
      id: "native",
      version: bundle.trace.header.engineVersion,
      seed: String(profile.seed),
    },
    fixedStepSeconds: bundle.trace.header.dt,
    durationSeconds: bundle.endTime - bundle.startTime,
  });
  const metadata = new Map(bundle.actors.map((actor) => [actor.id, actor]));
  const ambientIds = [...new Set(bundle.ambientTraffic?.actors.map((actor) => actor.id) ?? [])].sort();
  for (let index = 0; index < bundle.trace.ticks.t.length; index += 1) {
    const actors: MaterializedTrafficFrameActor[] = [];
    for (const actorId of ambientIds) {
      const track = bundle.trace.ticks.actors[actorId];
      const actor = metadata.get(actorId);
      if (!track || !actor || track.present[index] !== 1) continue;
      actors.push({
        id: actorId,
        kind: materializedActorKind(actor.kind),
        x: track.x[index]!,
        z: track.z[index]!,
        headingRad: track.headingRad[index]!,
        speedMps: track.speedMps[index]!,
        accelerationMps2: 0,
        signals: 0,
      });
    }
    const signals = Object.fromEntries(
      Object.entries(bundle.trace.ticks.signals ?? {}).map(([signalId, track]) => [
        signalId,
        materializedSignalState(track.phase[index] ?? "off"),
      ]),
    );
    // The trace's own `t` accumulates the step per tick, so by tick 7 of a
    // 0.1 s grid it reads 0.7000000000000001, and the recorder - which compares
    // against `index * step` exactly, and is right to - refuses the frame and
    // takes the whole render submission down with it. The tick index IS the grid
    // position and the recorder already computes that position, so hand it the
    // canonical time instead of an accumulated float.
    recorder.record({ t: recorder.nextTime, actors, signals });
  }
  return recorder.finalize();
}

/**
 * The evidence bytes for a draft whose ambient traffic runs in the browser
 * engine (`native`) or is off. `null` when the draft executes ambient traffic
 * through SUMO: that evidence is produced by the host's SUMO bridge, not from
 * a playback bundle.
 */
export function browserRevisionTraffic(
  content: { readonly simulation?: unknown; readonly extensions?: Readonly<Record<string, unknown>>; readonly mapSignalPlans: readonly unknown[] },
  map: RevisionTrafficMap,
  bundle: PlaybackBundle,
): { artifact: MaterializedTrafficArtifactEnvelope; profile: ResolvedAmbientTrafficProfile } | null {
  const requested = ambientTrafficProviderFromExtensions(content.extensions);
  const provider = previewExecutionTrafficProvider(requested, content.mapSignalPlans.length > 0);
  if (provider === "sumo") return null;
  const profile = ambientTrafficProfileFromExtensions(content.extensions, ambientProfileMissingDefault(content));
  return { artifact: materializeBrowserRevisionTraffic(provider, profile, map, bundle), profile };
}

function materializedActorKind(kind: string): MaterializedTrafficFrameActor["kind"] {
  if (kind === "pedestrian") return "pedestrian";
  if (kind === "bicycle" || kind === "scooter") return "bicycle";
  if (["vehicle", "car", "truck", "bus", "van", "motorcycle"].includes(kind)) return "vehicle";
  return "obstacle";
}

function materializedSignalState(state: string): "green" | "yellow" | "red" | "off" {
  if (state === "green" || state === "proceed" || state === "green_arrow") return "green";
  if (state === "yellow" || state === "flashing_yellow" || state === "yellow_arrow") return "yellow";
  if (state === "red" || state === "stop" || state === "flashing_red" || state === "red_x") return "red";
  return "off";
}
