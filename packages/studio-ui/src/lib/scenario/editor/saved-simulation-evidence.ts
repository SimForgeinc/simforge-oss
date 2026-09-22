import {
  ambientTrafficProviderFromExtensions,
  browserRevisionTraffic,
  previewAmbientTrafficProfile,
} from "@simforge-oss/playback/traffic";
import type { PlaybackBundle } from "@simforge-oss/playback";
import {
  ambientProvenanceForRevisionTraffic,
  resolveScenarioMap,
  type ScenarioDocumentDto,
  type ScenarioRevisionEvidenceDto,
  type StudioHostServices,
} from "@simforge-oss/studio-host";
import { playbackMapEntry } from "../maps";
import { downloadSimulationPreview, encodeSimulationPreview } from "../playback/simulationPreview";
import { ScenarioWorkerClient } from "../playback/scenarioWorkerClient";
import { uploadAndConsumeMaterializedTraffic } from "./materialized-traffic";

/**
 * Revision evidence for a draft from the simulation the editor saved for it,
 * with no world open.
 *
 * The evidence a snapshot needs is deterministic ambient traffic materialised
 * from the browser engine's own run of exactly this draft version. A live
 * session produces it by running the scenario; the editor also saves every
 * such run as the draft's simulation preview, and that saved run is the same
 * input `simforge render submit` freezes from. Reading it here is what lets a
 * render be created from the dataset list, where the editor session that
 * simulated the scenario has already been torn down.
 *
 * If the preview is missing or belongs to an older draft, the browser worker
 * prepares the exact current document here. Rendering therefore does not
 * require an author to perform a separate simulation ritual.
 */
export async function savedSimulationRevisionEvidence(
  host: StudioHostServices,
  document: ScenarioDocumentDto,
  signal?: AbortSignal,
): Promise<ScenarioRevisionEvidenceDto> {
  const map = resolveScenarioMap(document, await host.artifacts.listMaps(signal));
  const descriptor = await host.projects.getSimulationPreview(document.id, signal);
  let bundle: PlaybackBundle;
  let client: ScenarioWorkerClient | null = null;
  try {
    if (descriptor?.draftVersion === document.draftVersion) {
      bundle = await downloadSimulationPreview(descriptor, null, signal);
    } else {
      client = new ScenarioWorkerClient();
      bundle = await client.prepare(
        document.content,
        playbackMapEntry(map),
        previewAmbientTrafficProfile(
          ambientTrafficProviderFromExtensions(document.content.extensions),
          document.content.extensions,
          document.content.mapSignalPlans.length > 0,
        ),
        undefined,
        { backgroundPreview: true },
      );
      if (!map.browserClosureSha256) throw new Error("The map's browser runtime closure is unavailable.");
      const { bytes, sha256 } = await encodeSimulationPreview(bundle, document.draftVersion, {
        engine: await client.engineIdentity(),
        mapClosureSha256: map.browserClosureSha256,
      });
      await host.projects.saveSimulationPreview(document, bytes, sha256, signal);
    }
    const traffic = browserRevisionTraffic(document.content, map, bundle);
    if (!traffic) {
      throw new Error("This render is preparing SUMO traffic in the scenario worker; retry when preparation finishes.");
    }
    const { artifact, profile } = traffic;
    const replaceActorIds = new Set(bundle.ambientTraffic?.actors.map((actor) => actor.id) ?? []);
    const { reference } = await uploadAndConsumeMaterializedTraffic(
      host,
      document,
      artifact,
      artifact.artifact.sourceInputDigest,
      bundle.trace,
      replaceActorIds,
      { signal },
    );
    return {
      ambient: ambientProvenanceForRevisionTraffic(artifact, profile, playbackMapEntry(map)),
      materializedTraffic: reference,
    };
  } finally {
    client?.dispose();
  }
}
