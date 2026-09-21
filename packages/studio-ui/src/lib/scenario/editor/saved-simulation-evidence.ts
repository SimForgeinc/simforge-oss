import { browserRevisionTraffic } from "@simforge-oss/playback/traffic";
import {
  ambientProvenanceForRevisionTraffic,
  resolveScenarioMap,
  type ScenarioDocumentDto,
  type ScenarioRevisionEvidenceDto,
  type StudioHostServices,
} from "@simforge-oss/studio-host";
import { playbackMapEntry } from "../maps";
import { downloadSimulationPreview } from "../playback/simulationPreview";
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
 * Refused, with the action the author can take, when the draft was never
 * simulated or was edited since: only a run of this exact version is evidence
 * for it.
 */
export async function savedSimulationRevisionEvidence(
  host: StudioHostServices,
  document: ScenarioDocumentDto,
  signal?: AbortSignal,
): Promise<ScenarioRevisionEvidenceDto> {
  const descriptor = await host.projects.getSimulationPreview(document.id, signal);
  if (!descriptor) {
    throw new Error("This scenario has no saved simulation yet. Open it in the editor and let it simulate once, then create the render.");
  }
  if (descriptor.draftVersion !== document.draftVersion) {
    throw new Error("The saved simulation is from an earlier version of this scenario. Open it in the editor to simulate the current version, then create the render.");
  }
  const map = resolveScenarioMap(document, await host.artifacts.listMaps(signal));
  const bundle = await downloadSimulationPreview(descriptor, null, signal);
  const traffic = browserRevisionTraffic(document.content, map, bundle);
  if (!traffic) {
    throw new Error("This scenario runs ambient traffic through SUMO, which only the editor can freeze. Open it in the editor to create the render.");
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
}
