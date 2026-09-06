import type { MaterializedTrafficArtifactEnvelope, SceneTrace } from "@simforge-oss/engine";
import {
  consumeMaterializedTrafficSceneTraceEvidence,
  type BrowserMaterializedTrafficSceneTraceEvidence,
} from "@simforge-oss/playback/traffic";
import type { ScenarioDocumentDto, ScenarioMaterializedTrafficReferenceDto, StudioHostServices } from "@simforge-oss/studio-host";
import { fetchContentAddressedArtifact } from "../artifact-cache";

/**
 * Upload, refetch, decode, and bind the immutable bytes before the browser is
 * allowed to retain revision evidence or replay provider output.
 *
 * `registeredSourceInputDigest` is the digest the host's compiler recomputes and
 * compares against; the artifact bytes themselves embed the raw browser
 * `manifest.inputHash`, which the evidence consumer binds to the trace by exact
 * `trace.header.inputHash` equality.
 */
export async function uploadAndConsumeMaterializedTraffic(
  host: StudioHostServices,
  document: Pick<ScenarioDocumentDto, "id" | "draftVersion">,
  envelope: MaterializedTrafficArtifactEnvelope,
  registeredSourceInputDigest: string,
  trace: SceneTrace,
  replaceActorIds: ReadonlySet<string> = new Set(),
  options: { readonly signal?: AbortSignal } = {},
): Promise<{
  readonly reference: ScenarioMaterializedTrafficReferenceDto;
  readonly evidence: BrowserMaterializedTrafficSceneTraceEvidence;
}> {
  const reference = await host.projects.uploadMaterializedTraffic(
    document,
    {
      bytes: envelope.bytes,
      sha256: envelope.sha256,
      sizeBytes: envelope.sizeBytes,
      mapAssetId: envelope.artifact.map.assetId,
      mapVersionId: envelope.artifact.map.versionId,
    },
    registeredSourceInputDigest,
    options.signal,
  );
  const descriptor = await host.artifacts.getArtifact(reference.artifactId, { download: true, signal: options.signal });
  if (descriptor.id !== reference.artifactId || descriptor.sha256 !== reference.sha256
      || descriptor.sizeBytes !== reference.sizeBytes) {
    throw new Error("Materialized traffic download descriptor does not match the completed artifact");
  }
  // Digest-addressed, so the cache can serve this without a staleness window;
  // the size and checksum checks live in the cache and cover reads too.
  const bytes = await fetchContentAddressedArtifact(
    descriptor.downloadUrl,
    { sha256: reference.sha256, sizeBytes: reference.sizeBytes },
    { signal: options.signal, label: "Materialized traffic" },
  );
  return {
    reference,
    evidence: consumeMaterializedTrafficSceneTraceEvidence(trace, bytes, {
      sourceInputDigest: envelope.artifact.sourceInputDigest,
      mapAssetId: reference.mapAssetId,
      mapVersionId: reference.mapVersionId,
      durationSeconds: envelope.artifact.durationSeconds,
      sha256: reference.sha256,
    }, { replaceActorIds }),
  };
}
