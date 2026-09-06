import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  LOCAL_ORGANIZATION_ID,
  LOCAL_USER_ID,
  LOCAL_WORKSPACE_ID,
} from "../app/lib/auth/session";
import { queryRows, withTransaction } from "../app/lib/db/data-api";
import { LOCAL_ARTIFACT_BUCKET, LOCAL_CLOUD_ROOT } from "../app/lib/db/config";
import {
  publishDevAssetMap,
  resolveRegistryMapInstallation,
  type DevAssetMap,
  type RegistryMapInstallation,
} from "../app/lib/map-ingest/server/dev-asset-publication";
import { registerLocalFile, writeLocalObject } from "../app/lib/s3/s3-object";
import { CATALOG } from "@simforge-oss/asset-catalog";
import { SUMO_RUNTIME_VERSION } from "@simforge-oss/studio-ui/lib/scenario/sumo-runtime";
import { migrate } from "./migrate";
import { ensureStarterMapAssets, STARTER_MAP } from "./starter-map";

const dataHome = process.env.XDG_DATA_HOME?.trim() || resolve(homedir(), ".local/share");
const mapsCacheRoot =
  process.env.SIMFORGE_MAPS_CACHE_ROOT?.trim() || resolve(dataHome, "simforge/maps");
const semanticProfilesRoot = resolve(mapsCacheRoot, "dev-assets");
const webProfilesRoot = resolve(mapsCacheRoot, "map-bundles");
const nativeProfilesRoot = resolve(mapsCacheRoot, ".corpus");
const starterAssetsRoot = resolve(LOCAL_CLOUD_ROOT, "starter-map-assets");
const catalogSourceSha256 = sha256(JSON.stringify(CATALOG));
const catalogBody = Buffer.from(JSON.stringify({
  contractVersion: "uniscenario.asset-catalog/v1",
  pipelineVersion: "dev-assets-publication/v3",
  sourceInventorySha256: catalogSourceSha256,
  entries: CATALOG,
}));
const catalogManifestSha256 = sha256(catalogBody);
const catalogArtifactId = `artifact_local_catalog_${catalogManifestSha256}`;
const catalogVersionId = `catalog_local_${catalogManifestSha256}`;
const editorReleaseId = `editor_release_local_dev_assets_${catalogManifestSha256}`;

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

const MAP_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

async function installedMapNames(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && MAP_NAME.test(entry.name))
      .map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function mapLabel(name: string): string {
  return name.split("-").map((word) => `${word[0]!.toUpperCase()}${word.slice(1)}`).join(" ");
}

/**
 * Every map with any installed profile is a candidate; the release contract in
 * resolveRegistryMapInstallation decides whether it is complete, so a partial
 * installation is reported instead of silently falling back to Starter Road.
 */
async function discoverRegistryMaps(): Promise<Array<{
  map: DevAssetMap;
  installation: RegistryMapInstallation;
}>> {
  const names = [...new Set([
    ...await installedMapNames(semanticProfilesRoot),
    ...await installedMapNames(webProfilesRoot),
    ...await installedMapNames(nativeProfilesRoot),
  ])].sort();
  const installed: Array<{ map: DevAssetMap; installation: RegistryMapInstallation }> = [];
  for (const name of names) {
    try {
      const installation = await resolveRegistryMapInstallation({
        name,
        semanticRoot: resolve(semanticProfilesRoot, name),
        webRoot: resolve(webProfilesRoot, name),
        nativeRoot: resolve(nativeProfilesRoot, name),
      });
      installed.push({ map: [name, mapLabel(name), "Installed map"], installation });
    } catch (error) {
      console.warn(`ignored incomplete installed map ${name}: ${
        error instanceof Error ? error.message : String(error)
      }`);
    }
  }
  return installed;
}

async function seedIdentity(): Promise<void> {
  await withTransaction(async (tx) => {
    await tx.execute(
      `INSERT INTO public.ba_user (id, name, email, "emailVerified", role)
       VALUES (:id, :name, :email, TRUE, 'owner') ON CONFLICT (id) DO NOTHING`,
      { id: LOCAL_USER_ID, name: "Local Owner", email: "owner@local.simforge" },
    );
    await tx.execute(
      `INSERT INTO public.ba_organization (id, name, slug)
       VALUES (:id, 'Local Workspace', 'local') ON CONFLICT (id) DO NOTHING`,
      { id: LOCAL_ORGANIZATION_ID },
    );
    await tx.execute(
      `INSERT INTO public.ba_member (id, "organizationId", "userId", role)
       VALUES (:id, :organization_id, :user_id, 'owner') ON CONFLICT (id) DO NOTHING`,
      {
        id: "00000000-0000-4000-8000-000000000005",
        organization_id: LOCAL_ORGANIZATION_ID,
        user_id: LOCAL_USER_ID,
      },
    );
    await tx.execute(
      `INSERT INTO public.workspaces (id, type, slug, name, created_by_user_id, auth_organization_id)
       VALUES (:id, 'personal', 'local', 'Local Workspace', :user_id, :organization_id)
       ON CONFLICT (id) DO NOTHING`,
      { id: LOCAL_WORKSPACE_ID, user_id: LOCAL_USER_ID, organization_id: LOCAL_ORGANIZATION_ID },
    );
  });
}

async function seedPublicationBinding(): Promise<void> {
  const catalogStorageKey = `catalogs/${catalogManifestSha256}.json`;
  const catalogMetadata = await writeLocalObject(
    LOCAL_ARTIFACT_BUCKET,
    catalogStorageKey,
    catalogBody,
    "application/json",
  );
  const releaseManifestSha256 = sha256(`dev-assets-publication/v3\0${catalogMetadata.checksumSha256Hex}`);
  const producerJobId = `artifact-postprocess:editor-assets:${releaseManifestSha256.slice(0, 32)}`;
  await withTransaction(async (tx) => {
    await tx.execute(
      `INSERT INTO simforge.artifact_postprocess_jobs (
         id, workspace_id, postprocess_kind, state, phase, progress, attempt_count,
         idempotency_key, request_payload, result_payload, started_at, completed_at
       ) VALUES (
         :id, :workspace_id, 'editor_asset_release', 'succeeded', 'finalized', 1, 1,
         :idempotency_key, CAST(:request_payload AS jsonb), CAST(:result_payload AS jsonb), NOW(), NOW()
       ) ON CONFLICT (id) DO NOTHING`,
      {
        id: producerJobId,
        workspace_id: LOCAL_WORKSPACE_ID,
        idempotency_key: `editor_asset_release:${releaseManifestSha256}`,
        request_payload: {
          contractVersion: "simforge.editor-assets-release/v1",
          releaseId: editorReleaseId,
          manifestSha256: releaseManifestSha256,
        },
        result_payload: {
          artifactId: catalogArtifactId,
          storageBucket: LOCAL_ARTIFACT_BUCKET,
          storageKey: catalogStorageKey,
          sha256: catalogMetadata.checksumSha256Hex,
          sizeBytes: catalogMetadata.sizeBytes,
        },
      },
    );
    await tx.execute(
      `INSERT INTO simforge.artifacts (
         id, workspace_id, artifact_kind, media_type, storage_bucket, storage_key,
         sha256, byte_length, artifact_state, created_by_user_id, verified_at,
         verification_method, verification_sha256, producer_job_family, producer_job_id, provenance
       ) VALUES (
         :id, :workspace_id, 'asset-catalog-manifest-v1', 'application/json', :bucket, :key,
         :sha256, :byte_length, 'available', :user_id, NOW(),
         'stream_sha256', :sha256, 'artifact_postprocess', :producer_id, CAST(:provenance AS jsonb)
       ) ON CONFLICT (id) DO NOTHING`,
      {
        id: catalogArtifactId,
        workspace_id: LOCAL_WORKSPACE_ID,
        bucket: LOCAL_ARTIFACT_BUCKET,
        key: catalogStorageKey,
        sha256: catalogMetadata.checksumSha256Hex,
        byte_length: catalogMetadata.sizeBytes,
        user_id: LOCAL_USER_ID,
        producer_id: producerJobId,
        provenance: {
          contract: "uniscenario.artifact-provenance/v1",
          producerJobFamily: "artifact_postprocess",
          producerJobId,
        },
      },
    );
    await tx.execute(
      `INSERT INTO simforge.asset_catalog_versions (
         id, workspace_id, manifest_artifact_id, manifest_sha256, source_inventory_sha256,
         pipeline_version, toolchain, provenance, status
       ) VALUES (
         :id, :workspace_id, :artifact_id, :sha256, :source_inventory_sha256,
         'dev-assets-publication/v3', CAST(:toolchain AS jsonb), CAST(:provenance AS jsonb), 'active'
       ) ON CONFLICT (id) DO NOTHING`,
      {
        id: catalogVersionId,
        workspace_id: LOCAL_WORKSPACE_ID,
        artifact_id: catalogArtifactId,
        sha256: catalogMetadata.checksumSha256Hex,
        source_inventory_sha256: catalogSourceSha256,
        toolchain: { source: "@simforge-oss/asset-catalog" },
        provenance: { source: "bundled-catalog", entryCount: CATALOG.length },
      },
    );
    await tx.execute(
      `INSERT INTO simforge.editor_asset_releases (
         id, workspace_id, manifest_sha256, source_inventory_sha256,
         asset_catalog_version_id, source_environment, manifest, release_state, activated_at
       ) VALUES (
         :id, :workspace_id, :manifest_sha256, :source_inventory_sha256,
         :catalog_version_id, 'dev', CAST(:manifest AS jsonb), 'available', NULL
       ) ON CONFLICT (id) DO NOTHING`,
      {
        id: editorReleaseId,
        workspace_id: LOCAL_WORKSPACE_ID,
        manifest_sha256: releaseManifestSha256,
        source_inventory_sha256: catalogSourceSha256,
        catalog_version_id: catalogVersionId,
        manifest: {
          contractVersion: "simforge.editor-assets-release/v1",
          manifestSha256: releaseManifestSha256,
          source: "bundled-catalog",
          assetCatalogVersionId: catalogVersionId,
          assetCatalogManifestSha256: catalogManifestSha256,
        },
      },
    );
    // Bootstrap releases supersede only earlier bootstrap releases. A user's
    // independently activated release remains the workspace's active pointer.
    await tx.execute(
      `UPDATE simforge.editor_asset_releases SET release_state = 'retired'
        WHERE workspace_id = :workspace_id AND id <> :id
          AND id LIKE 'editor_release_local_dev_assets_%' AND release_state = 'active'`,
      { workspace_id: LOCAL_WORKSPACE_ID, id: editorReleaseId },
    );
    await tx.execute(
      `UPDATE simforge.editor_asset_releases
          SET release_state = 'active', activated_at = COALESCE(activated_at, NOW())
        WHERE id = :id AND workspace_id = :workspace_id
          AND NOT EXISTS (
            SELECT 1 FROM simforge.editor_asset_releases
             WHERE workspace_id = :workspace_id AND release_state = 'active' AND id <> :id
          )`,
      { workspace_id: LOCAL_WORKSPACE_ID, id: editorReleaseId },
    );
  });
}

async function seedSumoRuntime(assetsRoot: string): Promise<void> {
  const runtimeRoot = resolve(assetsRoot, "sumo-runtime");
  const runtimeFiles = [
    ["sumo.mjs", "text/javascript"],
    ["sumo.wasm", "application/wasm"],
    ["runtime-manifest.json", "application/json"],
    ["THIRD_PARTY_NOTICES.md", "text/markdown"],
  ] as const;
  if (!runtimeFiles.every(([fileName]) => existsSync(resolve(runtimeRoot, fileName)))) {
    console.log("SUMO browser runtime unavailable; Studio will use native deterministic traffic");
    return;
  }
  for (const [fileName, contentType] of runtimeFiles) {
    await registerLocalFile(
      LOCAL_ARTIFACT_BUCKET,
      `uniscenario/sumo-runtime/${SUMO_RUNTIME_VERSION}/${fileName}`,
      resolve(runtimeRoot, fileName),
      contentType,
    );
  }
  console.log(`registered SUMO browser runtime ${SUMO_RUNTIME_VERSION}`);
}

export async function seed(): Promise<void> {
  const installedMaps = await discoverRegistryMaps();
  if (installedMaps.length === 0) {
    await ensureStarterMapAssets(starterAssetsRoot);
    console.log(
      `no complete installed registry maps were found at ${mapsCacheRoot}; generated the bundled Starter Road`,
    );
  }
  await migrate();
  await seedIdentity();
  await seedPublicationBinding();
  await seedSumoRuntime(
    installedMaps.length > 0 ? semanticProfilesRoot : starterAssetsRoot,
  );
  let skipped = 0;
  const publications = installedMaps.length > 0
    ? installedMaps
    : [{ map: STARTER_MAP, assetsRoot: starterAssetsRoot }];
  for (const publication of publications) {
    try {
      const result = await publishDevAssetMap({
        map: publication.map,
        ...("installation" in publication
          ? { installation: publication.installation }
          : { assetsRoot: publication.assetsRoot }),
        assetCatalogVersionId: catalogVersionId,
        activeReleaseId: editorReleaseId,
      });
      console.log(
        `published ${publication.map[0]}: ${result.objectCount} browser members, `
        + `${result.byteLength} bytes, SUMO ${result.sumoNetworkSha256 ? "ready" : "unavailable"}, `
        + `thumbnail ${result.thumbnailBytes} bytes`,
      );
    } catch (error) {
      skipped += 1;
      console.warn(`skipped ${publication.map[0]}: ${
        error instanceof Error ? error.message : String(error)
      }`);
    }
  }
  if (skipped > 0) {
    console.warn(`${skipped}/${publications.length} installed maps skipped`);
  }
  const maps = await queryRows<{ id: string; label: string }>(
    "SELECT id, label FROM simforge.map_versions WHERE retired_at IS NULL ORDER BY label",
  );
  console.log(`seed complete: ${maps.length} map_versions`);
  for (const map of maps) console.log(`  ${map.id} ${map.label}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await seed();
}
