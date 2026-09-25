import "server-only";

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ScenarioPackageError,
  verifyScenarioPackage,
  verifyScenarioPackageFile,
  writeScenarioPackage,
  writeScenarioPackageFile,
  type ScenarioPackageVerification,
} from "@simforge-oss/native-runtime";
import { actorAssetBlobUrl } from "@simforge-oss/render/native";

import type { AppContext } from "@/app/lib/db/app-context";
import { queryOne, queryRows } from "@/app/lib/db/data-api";
import { parseJsonObject } from "@/app/lib/db/json-helpers";
import { getPresignedGetUrl } from "@/app/lib/s3/s3-presign";
import { putS3Object, putS3ObjectFromFile } from "@/app/lib/s3/s3-put-object";
import { readServerMapMember } from "@/app/lib/scenario/sim-closure.server";
import { simforgeEnv } from "@/lib/simforge-env";

import { scenarioId } from "../core";
import {
  composeScenarioPackage,
  scenarioPackageCliCommand,
  scenarioPackageDisplayId,
  scenarioPackageFileName,
  SCENARIO_PACKAGE_MEDIA_TYPE,
  sha256Hex,
  type ComposedScenarioPackage,
  type ScenarioPackageBlobRef,
  type ScenarioPackageSummary,
} from "./compose";
import { ScenarioPackageExportError } from "./errors";
import { readRevisionPackageSources } from "./sources.server";

/**
 * "Export for CLI": a revision as a `simforge.scenario-package/v1` container
 * the public `simforge` CLI imports, renders and runs.
 *
 * - Thin (default): written, verified and stored in the request. It plays
 *   where the map version and the actor closure resolve by digest.
 * - Full: the same manifest plus every map member and the actor blobs the
 *   timeline binds, built by a background job (it can be hundreds of MB),
 *   verified, stored, and offered through a download link.
 *
 * Every container is verified with the reader (`verifyScenarioPackage`)
 * before it is offered. A container is a disposable cache (scenario-package.md
 * R7); the package id is the identity.
 */

export type ScenarioPackageForm = "thin" | "full";
export type ScenarioPackageExportState = "queued" | "building" | "succeeded" | "failed";

export type ScenarioPackageExportDto = {
  exportId: string;
  revisionId: string;
  form: ScenarioPackageForm;
  textures: "include" | "exclude" | null;
  state: ScenarioPackageExportState;
  packageId: string;
  displayId: string;
  fileName: string;
  mediaType: typeof SCENARIO_PACKAGE_MEDIA_TYPE;
  sizeBytes: number | null;
  estimatedSizeBytes: number | null;
  sha256: string | null;
  /** Presigned, expiring; present once the container is stored. The package id does not expire. */
  downloadUrl: string | null;
  cliCommand: string;
  summary: ScenarioPackageSummary | Record<string, never>;
  error: { code: string; message: string } | null;
  createdAt: string;
  completedAt: string | null;
};

/** How long a download link lives. */
const DOWNLOAD_URL_TTL_SECONDS = 60 * 60;
/** A queued or building job with no heartbeat for this long is reported failed, never left spinning. */
const JOB_STALE_SECONDS = 10 * 60;
const HEARTBEAT_EVERY_MS = 15_000;
/** Full-form jobs a workspace may run at once. */
const MAX_ACTIVE_FULL_EXPORTS = 2;

function artifactBucket(): string {
  return simforgeEnv("ARTIFACT_BUCKET")?.trim() || "local-artifacts";
}

/**
 * The largest full container this host builds. A job stages every blob and
 * the container on local disk, so a serverless host (512 MB of /tmp) is
 * capped well below the 4 GiB format limit. Configurable per deployment.
 */
export function fullPackageByteLimit(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.SIMFORGE_SCENARIO_PACKAGE_FULL_MAX_BYTES);
  if (Number.isSafeInteger(configured) && configured > 0) return configured;
  return env.VERCEL ? 200 * 1024 * 1024 : 4 * 1024 * 1024 * 1024 - 64 * 1024 * 1024;
}

function storageKey(workspaceId: string, packageId: string, exportId: string, fileName: string): string {
  return `${workspaceId}/scenario-packages/${packageId}/${exportId}/${fileName}`;
}

/** A writer or reader refusal of our own output is a server fault, with the crate's code and rule. */
function packageFault(error: unknown, stage: string): never {
  if (error instanceof ScenarioPackageError) {
    throw new ScenarioPackageExportError(error.code, `${stage}: ${error.message}`, 500, { rule: error.rule, path: error.path });
  }
  throw error;
}

function exportedAt(): string {
  return new Date().toISOString();
}

type Composed = { composed: ComposedScenarioPackage; thin: Buffer; packageId: string; manifestJson: string };

/** Compose, write and verify the thin form (the full form's manifest is the same bytes). */
async function composeAndWriteThin(workspaceId: string, revisionId: string): Promise<Composed> {
  const sources = await readRevisionPackageSources(workspaceId, revisionId);
  const composed = composeScenarioPackage(sources);
  let written;
  try {
    written = writeScenarioPackage({
      manifest: composed.manifest,
      members: composed.members,
      receipt: { exportedAt: exportedAt(), exporterRelease: sources.appVersion },
    });
  } catch (error) {
    packageFault(error, "the package writer refused the export");
  }
  let verification: ScenarioPackageVerification;
  try {
    verification = verifyScenarioPackage(written.bytes);
  } catch (error) {
    packageFault(error, "the written package does not verify");
  }
  if (verification.packageId !== written.packageId || verification.form !== "thin") {
    throw new ScenarioPackageExportError("package_identity_mismatch", "the written package verified as another package", 500);
  }
  return { composed, thin: written.bytes, packageId: written.packageId, manifestJson: written.manifestJson };
}

type ExportRow = {
  id: string;
  revision_id: string;
  form: ScenarioPackageForm;
  textures: "include" | "exclude" | null;
  export_state: ScenarioPackageExportState;
  package_id: string;
  file_name: string;
  summary: string | Record<string, unknown> | null;
  estimated_byte_length: number | string | null;
  storage_bucket: string | null;
  storage_key: string | null;
  byte_length: number | string | null;
  sha256: string | null;
  error_code: string | null;
  error_detail: string | null;
  created_at: string;
  completed_at: string | null;
};

const EXPORT_COLUMNS = `id, revision_id, form, textures, export_state, package_id, file_name, summary,
  estimated_byte_length, storage_bucket, storage_key, byte_length, sha256, error_code, error_detail,
  created_at::text AS created_at, completed_at::text AS completed_at`;

async function exportDto(row: ExportRow): Promise<ScenarioPackageExportDto> {
  const downloadUrl = row.export_state === "succeeded" && row.storage_bucket && row.storage_key
    ? await getPresignedGetUrl(
        row.storage_key,
        row.storage_bucket,
        DOWNLOAD_URL_TTL_SECONDS,
        `attachment; filename="${row.file_name}"`,
      )
    : null;
  return {
    exportId: row.id,
    revisionId: row.revision_id,
    form: row.form,
    textures: row.textures,
    state: row.export_state,
    packageId: row.package_id,
    displayId: scenarioPackageDisplayId(row.package_id),
    fileName: row.file_name,
    mediaType: SCENARIO_PACKAGE_MEDIA_TYPE,
    sizeBytes: row.byte_length === null ? null : Number(row.byte_length),
    estimatedSizeBytes: row.estimated_byte_length === null ? null : Number(row.estimated_byte_length),
    sha256: row.sha256,
    downloadUrl,
    cliCommand: scenarioPackageCliCommand(row.file_name),
    summary: parseJsonObject(row.summary as never) as ScenarioPackageSummary,
    error: row.error_code ? { code: row.error_code, message: row.error_detail ?? row.error_code } : null,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

/** Export a revision. Thin: stored and returned `succeeded`. Full: returned `queued`; run {@link runFullScenarioPackageExport} after responding. */
export async function exportScenarioPackage(
  context: Pick<AppContext, "workspaceId" | "userId">,
  revisionId: string,
  request: { form: ScenarioPackageForm; textures?: "include" | "exclude" },
): Promise<ScenarioPackageExportDto> {
  const { composed, thin, packageId, manifestJson } = await composeAndWriteThin(context.workspaceId, revisionId);
  const fileName = scenarioPackageFileName(composed.title, packageId);
  const exportId = scenarioId("uspkg");

  if (request.form === "thin") {
    const bucket = artifactBucket();
    const key = storageKey(context.workspaceId, packageId, exportId, fileName);
    await putS3Object(bucket, key, thin, SCENARIO_PACKAGE_MEDIA_TYPE);
    const rows = await queryRows<ExportRow>(
      `INSERT INTO simforge.scenario_package_exports (
         id, workspace_id, revision_id, form, export_state, package_id, file_name, manifest, summary,
         storage_bucket, storage_key, byte_length, sha256, created_by_user_id, started_at, completed_at
       ) VALUES (
         :id, :workspace_id, :revision_id, 'thin', 'succeeded', :package_id, :file_name, CAST(:manifest AS JSONB),
         CAST(:summary AS JSONB), :bucket, :key, :byte_length, :sha256, :user_id, NOW(), NOW()
       ) RETURNING ${EXPORT_COLUMNS}`,
      {
        id: exportId,
        workspace_id: context.workspaceId,
        revision_id: revisionId,
        package_id: packageId,
        file_name: fileName,
        manifest: manifestJson,
        summary: JSON.stringify(composed.summary),
        bucket,
        key,
        byte_length: thin.byteLength,
        sha256: sha256Hex(thin),
        user_id: context.userId,
      },
    );
    return exportDto(rows[0]!);
  }

  const textures = request.textures ?? "include";
  const blobs = composed.fullBlobs({ textures: textures === "include" });
  const estimated = thin.byteLength + blobs.reduce((sum, b) => sum + b.bytes, 0);
  const limit = fullPackageByteLimit();
  if (estimated > limit) {
    throw new ScenarioPackageExportError(
      "package_too_large",
      `the full package would be about ${Math.ceil(estimated / 1024 / 1024)} MB; this host builds full packages up to ${Math.floor(limit / 1024 / 1024)} MB.${textures === "include" ? " Exclude textures, or" : ""} Use the thin package on a machine where the map is installed.`,
      413,
      { estimatedSizeBytes: estimated, limitBytes: limit },
    );
  }
  const active = await queryOne<{ n: number | string }>(
    `SELECT COUNT(*)::int AS n FROM simforge.scenario_package_exports
      WHERE workspace_id = :workspace_id AND form = 'full' AND export_state IN ('queued', 'building')
        AND COALESCE(heartbeat_at, created_at) > NOW() - make_interval(secs => :stale)`,
    { workspace_id: context.workspaceId, stale: JOB_STALE_SECONDS },
  );
  if (Number(active?.n ?? 0) >= MAX_ACTIVE_FULL_EXPORTS) {
    throw new ScenarioPackageExportError(
      "package_export_busy",
      `this workspace already has ${MAX_ACTIVE_FULL_EXPORTS} full package exports running; wait for one to finish`,
      429,
    );
  }
  const rows = await queryRows<ExportRow>(
    `INSERT INTO simforge.scenario_package_exports (
       id, workspace_id, revision_id, form, textures, export_state, package_id, file_name, manifest, summary,
       estimated_byte_length, created_by_user_id
     ) VALUES (
       :id, :workspace_id, :revision_id, 'full', :textures, 'queued', :package_id, :file_name, CAST(:manifest AS JSONB),
       CAST(:summary AS JSONB), :estimated, :user_id
     ) RETURNING ${EXPORT_COLUMNS}`,
    {
      id: exportId,
      workspace_id: context.workspaceId,
      revision_id: revisionId,
      textures,
      package_id: packageId,
      file_name: fileName,
      manifest: manifestJson,
      summary: JSON.stringify(composed.summary),
      estimated,
      user_id: context.userId,
    },
  );
  return exportDto(rows[0]!);
}

/** Fail jobs whose runner stopped heartbeating (a killed function, a restarted host). */
async function failStaleJobs(workspaceId: string): Promise<void> {
  await queryRows(
    `UPDATE simforge.scenario_package_exports
        SET export_state = 'failed', error_code = 'package_job_lost', completed_at = NOW(),
            error_detail = 'The export job stopped reporting progress before it finished; start the export again.'
      WHERE workspace_id = :workspace_id AND export_state IN ('queued', 'building')
        AND COALESCE(heartbeat_at, created_at) < NOW() - make_interval(secs => :stale)
      RETURNING id`,
    { workspace_id: workspaceId, stale: JOB_STALE_SECONDS },
  );
}

export async function getScenarioPackageExport(workspaceId: string, revisionId: string, exportId: string): Promise<ScenarioPackageExportDto | null> {
  await failStaleJobs(workspaceId);
  const row = await queryOne<ExportRow>(
    `SELECT ${EXPORT_COLUMNS} FROM simforge.scenario_package_exports
      WHERE workspace_id = :workspace_id AND revision_id = :revision_id AND id = :id`,
    { workspace_id: workspaceId, revision_id: revisionId, id: exportId },
  );
  return row ? exportDto(row) : null;
}

async function heartbeat(exportId: string): Promise<void> {
  await queryRows(
    `UPDATE simforge.scenario_package_exports SET heartbeat_at = NOW()
      WHERE id = :id AND export_state = 'building' RETURNING id`,
    { id: exportId },
  );
}

async function fetchActorBlob(ref: ScenarioPackageBlobRef, file: string): Promise<void> {
  const response = await fetch(actorAssetBlobUrl(ref.sha256), { signal: AbortSignal.timeout(10 * 60_000) });
  if (!response.ok) {
    throw new ScenarioPackageExportError("package_actor_assets_missing", `actor blob ${ref.path} is not available from the actor origin (${response.status})`, 502);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== ref.bytes || sha256Hex(bytes) !== ref.sha256) {
    throw new ScenarioPackageExportError("package_digest_mismatch", `the actor origin served other bytes for ${ref.path}`, 502);
  }
  await writeFile(file, bytes);
}

async function stageMapBlob(mapVersionId: string, ref: ScenarioPackageBlobRef, file: string): Promise<void> {
  const bytes = await readServerMapMember(mapVersionId, ref.path);
  if (bytes.byteLength !== ref.bytes || sha256Hex(bytes) !== ref.sha256) {
    throw new ScenarioPackageExportError("package_digest_mismatch", `map member ${ref.path} does not match the closure listing`, 500);
  }
  await writeFile(file, bytes);
}

async function fileSha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * The full-form job: stage every blob on local disk (each verified against
 * its closure listing), stream the container to a file, verify it with the
 * reader, store it. Any failure fails the job with its code; nothing partial
 * is ever stored or offered.
 */
export async function runFullScenarioPackageExport(workspaceId: string, exportId: string): Promise<void> {
  const claimed = await queryOne<{ revision_id: string; package_id: string; textures: "include" | "exclude" | null; file_name: string }>(
    `UPDATE simforge.scenario_package_exports
        SET export_state = 'building', started_at = NOW(), heartbeat_at = NOW()
      WHERE workspace_id = :workspace_id AND id = :id AND export_state = 'queued'
      RETURNING revision_id, package_id, textures, file_name`,
    { workspace_id: workspaceId, id: exportId },
  );
  if (!claimed) return;
  const beat = setInterval(() => void heartbeat(exportId).catch(() => undefined), HEARTBEAT_EVERY_MS);
  let dir: string | null = null;
  try {
    const sources = await readRevisionPackageSources(workspaceId, claimed.revision_id);
    const composed = composeScenarioPackage(sources);
    dir = await mkdtemp(path.join(tmpdir(), "simforge-package-"));
    const blobs = composed.fullBlobs({ textures: claimed.textures !== "exclude" });
    const staged: { sha256: string; file: string }[] = [];
    for (const ref of blobs) {
      const file = path.join(dir, ref.sha256);
      if (ref.source === "map") await stageMapBlob(sources.map.mapVersionId, ref, file);
      else await fetchActorBlob(ref, file);
      staged.push({ sha256: ref.sha256, file });
    }
    const out = path.join(dir, claimed.file_name);
    let written;
    try {
      written = writeScenarioPackageFile(out, {
        manifest: composed.manifest,
        members: composed.members,
        blobs: staged,
        receipt: {
          exportedAt: exportedAt(),
          exporterRelease: sources.appVersion,
          textureTier: claimed.textures === "exclude" ? "none" : "browser-closure",
        },
      });
    } catch (error) {
      packageFault(error, "the package writer refused the full export");
    }
    if (written.packageId !== claimed.package_id) {
      throw new ScenarioPackageExportError(
        "package_identity_mismatch",
        `the revision now packages as ${written.packageId.slice(0, 12)}, not ${claimed.package_id.slice(0, 12)}; start the export again`,
        409,
      );
    }
    let verification: ScenarioPackageVerification;
    try {
      verification = verifyScenarioPackageFile(out);
    } catch (error) {
      packageFault(error, "the written full package does not verify");
    }
    if (verification.form !== "full" || verification.packageId !== claimed.package_id) {
      throw new ScenarioPackageExportError("package_identity_mismatch", "the written full package verified as another package", 500);
    }
    const size = (await stat(out)).size;
    const digest = await fileSha256(out);
    const bucket = artifactBucket();
    const key = storageKey(workspaceId, claimed.package_id, exportId, claimed.file_name);
    await putS3ObjectFromFile(bucket, key, out, SCENARIO_PACKAGE_MEDIA_TYPE);
    await queryRows(
      `UPDATE simforge.scenario_package_exports
          SET export_state = 'succeeded', storage_bucket = :bucket, storage_key = :key, byte_length = :size,
              sha256 = :sha256, receipt = CAST(:receipt AS JSONB), completed_at = NOW(), heartbeat_at = NOW()
        WHERE id = :id AND export_state = 'building'
        RETURNING id`,
      { id: exportId, bucket, key, size, sha256: digest, receipt: JSON.stringify(verification.receipt) },
    );
  } catch (error) {
    const code = error instanceof ScenarioPackageExportError ? error.code : "package_export_failed";
    const message = error instanceof Error ? error.message : String(error);
    await queryRows(
      `UPDATE simforge.scenario_package_exports
          SET export_state = 'failed', error_code = :code, error_detail = :detail, completed_at = NOW()
        WHERE id = :id AND export_state IN ('queued', 'building')
        RETURNING id`,
      { id: exportId, code, detail: message.slice(0, 2000) },
    );
  } finally {
    clearInterval(beat);
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}
