import { homedir } from "node:os";
import { join } from "node:path";
import { LOCAL_ARTIFACT_BUCKET } from "@/app/lib/s3/s3-config";

export const LOCAL_CLOUD_ROOT =
  process.env.SIMFORGE_CLOUD_ROOT?.trim() || join(homedir(), ".simforge", "cloud");
export const LOCAL_DATABASE_DIR = join(LOCAL_CLOUD_ROOT, "db");
/** Single-owner lock beside the PGlite directory (see data-dir-lock.ts). */
export const LOCAL_DATABASE_LOCK = join(LOCAL_CLOUD_ROOT, "db.lock");
export const LOCAL_ARTIFACTS_DIR = join(LOCAL_CLOUD_ROOT, "artifacts");
export { LOCAL_ARTIFACT_BUCKET };

export type DataApiConfig = {
  region: string;
  clusterArn: string;
  secretArn: string;
  database: string;
};

/** Retained for copied callers that inspect the legacy Data API config shape. */
export function getDataApiConfig(): DataApiConfig {
  return {
    region: "local",
    clusterArn: process.env.DATABASE_URL?.trim() ?? `file://${LOCAL_DATABASE_DIR}`,
    secretArn: "local",
    database: "simcloud",
  };
}

export function isDataApiConfigured(): boolean {
  return true;
}
