import { NextResponse } from "next/server";
import type { DatasetExportPublication } from "@simforge-oss/studio-shared";
import { resolveExportableDataset } from "@/app/lib/dataset-export/datasets";
import { queryOne } from "@/app/lib/db/data-api";
import {
  getDatasetExportJobV2,
  getDatasetExportPublicationByKind,
  getDefaultDatasetExportPublication,
} from "@/app/lib/db/dataset-export-v2-store";
import { requireScenarioContext, SCENARIO_PRIVATE_CACHE_HEADERS } from "@/app/lib/scenario/http";
import { sameOriginWhenLocal } from "@/app/lib/s3/local-object-redirect";
import { getPresignedGetUrl, MEDIA_URL_TTL_SECONDS } from "@/app/lib/s3/s3-presign";

type RouteContext = { params: Promise<{ id: string; exportId: string }> };

type StoredArtifact = {
  storage_bucket: string;
  storage_key: string;
  byte_length: number;
  sha256: string;
  media_type: string;
  metadata: string;
};

async function publishedArtifact(workspaceId: string, artifactId: string) {
  return queryOne<StoredArtifact>(
    `SELECT storage_bucket, storage_key, byte_length, sha256, media_type, metadata::text AS metadata
       FROM simforge.artifacts
      WHERE workspace_id = :workspace_id AND id = :artifact_id
        AND artifact_state = 'available' AND deleted_at IS NULL
      LIMIT 1`,
    { workspace_id: workspaceId, artifact_id: artifactId },
  );
}

async function publicationUrl(
  workspaceId: string,
  publication: DatasetExportPublication | null,
  fileName?: string,
) {
  if (!publication || publication.status !== "ready") return null;
  const artifact = await publishedArtifact(workspaceId, publication.artifactId);
  if (!artifact) return null;
  const url = await getPresignedGetUrl(
    artifact.storage_key,
    artifact.storage_bucket,
    MEDIA_URL_TTL_SECONDS,
    fileName ? `attachment; filename="${fileName}"` : undefined,
  );
  return { url: sameOriginWhenLocal(url), artifact };
}

/**
 * Resolve the ready publication of an export to a browser-openable URL.
 *
 * Package publications hand back the archive itself; prefix publications hand
 * back the manifest (the prefix is a directory of hard-linked artifacts, not a
 * single object) along with the prefix coordinates so tooling can walk it.
 */
export async function GET(_request: Request, context: RouteContext) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const { id: datasetId, exportId } = await context.params;
  const dataset = await resolveExportableDataset(auth.context, datasetId);
  if (!dataset) return NextResponse.json({ error: "Dataset not found" }, { status: 404 });

  const job = await getDatasetExportJobV2(dataset.workspaceId, exportId);
  if (!job || job.datasetId !== datasetId) {
    return NextResponse.json({ error: "Export not found" }, { status: 404 });
  }
  const publication = await getDefaultDatasetExportPublication(dataset.workspaceId, exportId);
  if (!publication || publication.status !== "ready") {
    return NextResponse.json({ error: "Export publication is not ready yet" }, { status: 409 });
  }

  if (publication.kind === "prefix") {
    const metadata = publication.metadataJson;
    const prefix =
      metadata && typeof metadata === "object" && typeof metadata.s3Prefix === "string"
        ? metadata.s3Prefix
        : null;
    const bucket =
      metadata && typeof metadata === "object" && typeof metadata.s3Bucket === "string"
        ? metadata.s3Bucket
        : null;
    if (!prefix || !bucket) {
      return NextResponse.json({ error: "Export prefix publication has no storage prefix" }, { status: 409 });
    }
    const manifest = await publicationUrl(
      dataset.workspaceId,
      await getDatasetExportPublicationByKind(dataset.workspaceId, exportId, "manifest"),
    );
    if (!manifest) {
      return NextResponse.json(
        { error: "Export prefix publication is missing a ready manifest" },
        { status: 409 },
      );
    }
    const odvg = await publicationUrl(
      dataset.workspaceId,
      await getDatasetExportPublicationByKind(dataset.workspaceId, exportId, "odvg"),
    );
    return NextResponse.json(
      {
        kind: "prefix",
        url: manifest.url,
        manifestUrl: manifest.url,
        ...(odvg ? { odvgUrl: odvg.url } : {}),
        s3Bucket: bucket,
        s3Prefix: prefix,
        manifest: JSON.parse(manifest.artifact.metadata) as unknown,
        expiresIn: MEDIA_URL_TTL_SECONDS,
      },
      { headers: SCENARIO_PRIVATE_CACHE_HEADERS },
    );
  }

  const extension = publication.kind === "package"
    ? (publication.metadataJson?.delivery === "tar" ? "tar" : "zip")
    : publication.kind === "odvg"
      ? "jsonl"
      : "json";
  const resolved = await publicationUrl(
    dataset.workspaceId,
    publication,
    `${dataset.name.replace(/[^A-Za-z0-9._-]+/g, "_")}-${job.recipe ?? job.format.toLowerCase()}-${exportId}.${extension}`,
  );
  if (!resolved) {
    return NextResponse.json({ error: "Export artifact not found" }, { status: 404 });
  }
  return NextResponse.json(
    {
      kind: publication.kind,
      url: resolved.url,
      sizeBytes: Number(resolved.artifact.byte_length),
      sha256: resolved.artifact.sha256,
      contentType: resolved.artifact.media_type,
      expiresIn: MEDIA_URL_TTL_SECONDS,
    },
    { headers: SCENARIO_PRIVATE_CACHE_HEADERS },
  );
}
