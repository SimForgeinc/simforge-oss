import type { MapAssetArtifact } from "@simforge-oss/studio-shared";
import { partitionReferencedObjects, type RetainedObject } from "@/app/lib/db/retention-refs";
import { deleteS3Keys, listS3Keys } from "@/app/lib/s3/s3-delete";
import { splitMapArtifactUri } from "@/app/lib/db/map-asset-store";

/** What happened to the objects of artifacts a map-asset edit dropped. */
export type MapAssetObjectCleanup = {
  deletedS3Objects: number;
  /** Objects left in place because an immutable record still needs them (orphans are collected later, never here). */
  retainedS3Objects: RetainedObject[];
  /** Set when the reference check or a delete failed; nothing past that point was deleted. */
  cleanupError?: string;
};

/**
 * Delete the stored objects of artifacts a map-asset edit removed, except any
 * object a map version (retired or not), revision, simulation result or render
 * job still references by key or digest. The edit itself is already committed;
 * a failed reference check deletes nothing and is reported, never assumed away.
 */
export async function cleanupRemovedMapAssetObjects(input: {
  mapAssetId: string;
  bucket: string;
  removedArtifacts: readonly MapAssetArtifact[];
}): Promise<MapAssetObjectCleanup> {
  const report: MapAssetObjectCleanup = { deletedS3Objects: 0, retainedS3Objects: [] };
  if (input.removedArtifacts.length === 0) return report;
  try {
    const candidates: Array<{ key: string; sha256?: string | null }> = [];
    for (const artifact of input.removedArtifacts) {
      let location: { bucket: string; key: string } | null = null;
      try {
        location = splitMapArtifactUri(artifact.uri);
      } catch {
        location = null;
      }
      if (!location || location.bucket !== input.bucket) {
        // Only objects in this route's bucket are ours to delete.
        report.retainedS3Objects.push({ key: artifact.uri, reasons: ["outside-map-asset-bucket"] });
        continue;
      }
      candidates.push({ key: location.key, sha256: artifact.sha256 });
    }
    // A dropped 3d_manifest owns its untracked tile files under 3d/.
    if (input.removedArtifacts.some((artifact) => artifact.artifact_type === "3d_manifest")) {
      for (const key of await listS3Keys(`maps/${input.mapAssetId}/3d/`, input.bucket)) candidates.push({ key });
    }
    const { deletable, retained } = await partitionReferencedObjects(input.bucket, candidates);
    report.retainedS3Objects.push(...retained);
    if (deletable.length > 0) report.deletedS3Objects = await deleteS3Keys(deletable, input.bucket);
  } catch (error) {
    report.cleanupError = error instanceof Error ? error.message : String(error);
    console.error("map-asset object cleanup stopped; remaining objects kept:", error);
  }
  return report;
}
