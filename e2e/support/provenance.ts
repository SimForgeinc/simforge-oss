import { writeEvidence, type EvidenceTarget } from "./evidence";

export const DEPLOYMENT_E2E_EVIDENCE_SCHEMA = "simforge.deployment-e2e-evidence/v2" as const;

export type DeploymentE2eEvidence = {
  schema: typeof DEPLOYMENT_E2E_EVIDENCE_SCHEMA;
  deployment: {
    release: string;
    sourceRevision: string;
    cloudOrigin: string;
    artifact: {
      path: string;
      sha256: string;
      sizeBytes: number;
      stageManifestSha256?: string;
    };
  };
  platform: { os: string; arch: string; launchMode: string };
  map?: {
    mapId: string;
    mapVersionId?: string;
    releaseDigest?: string;
    canonicalDigest?: string;
    browserClosureSha256?: string;
    semantic?: Record<string, string>;
    native?: Record<string, string>;
  };
  scenario?: {
    documentId: string;
    datasetId?: string;
    revisionId?: string;
    contentSha256: string;
  };
  renderer?: {
    engine: string;
    profile?: string;
    tick?: number;
    frameSha256?: string;
    artifactSha256?: string;
    artifactBytes?: number;
  };
  model?: {
    family: string;
    quant?: string;
    checkpointDigest: string;
    jobId?: string;
    scored?: boolean;
  };
  restart?: { datasetPersisted: boolean; scenarioPersisted: boolean; artifactsReplayed?: boolean };
  claims: { verified: string[]; blocked: Array<{ claim: string; prerequisite: string }> };
};

const HEX64 = /^[a-f0-9]{64}$/i;

function requireText(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`Deployment evidence ${path} must be non-empty`);
}

function requireDigest(value: unknown, path: string): void {
  requireText(value, path);
  if (!HEX64.test(value)) throw new Error(`Deployment evidence ${path} must be a SHA-256 digest`);
}

export function validateDeploymentEvidence(value: DeploymentE2eEvidence): DeploymentE2eEvidence {
  if (value.schema !== DEPLOYMENT_E2E_EVIDENCE_SCHEMA) throw new Error(`Unsupported deployment evidence schema: ${String(value.schema)}`);
  requireText(value.deployment.release, "deployment.release");
  requireText(value.deployment.sourceRevision, "deployment.sourceRevision");
  requireText(value.deployment.cloudOrigin, "deployment.cloudOrigin");
  requireText(value.deployment.artifact.path, "deployment.artifact.path");
  requireDigest(value.deployment.artifact.sha256, "deployment.artifact.sha256");
  if (!Number.isSafeInteger(value.deployment.artifact.sizeBytes) || value.deployment.artifact.sizeBytes <= 0) {
    throw new Error("Deployment evidence deployment.artifact.sizeBytes must be a positive integer");
  }
  requireText(value.platform.os, "platform.os");
  requireText(value.platform.arch, "platform.arch");
  requireText(value.platform.launchMode, "platform.launchMode");
  if (value.map) {
    requireText(value.map.mapId, "map.mapId");
    for (const [key, digest] of Object.entries({
      releaseDigest: value.map.releaseDigest,
      canonicalDigest: value.map.canonicalDigest,
      browserClosureSha256: value.map.browserClosureSha256,
      ...(value.map.semantic ?? {}),
      ...(value.map.native ?? {}),
    })) if (digest !== undefined) requireDigest(digest, `map.${key}`);
  }
  if (value.scenario) {
    requireText(value.scenario.documentId, "scenario.documentId");
    requireDigest(value.scenario.contentSha256, "scenario.contentSha256");
  }
  if (value.renderer) {
    requireText(value.renderer.engine, "renderer.engine");
    if (value.renderer.frameSha256) requireDigest(value.renderer.frameSha256, "renderer.frameSha256");
    if (value.renderer.artifactSha256) requireDigest(value.renderer.artifactSha256, "renderer.artifactSha256");
    if (value.renderer.artifactBytes !== undefined && (!Number.isSafeInteger(value.renderer.artifactBytes) || value.renderer.artifactBytes <= 0)) {
      throw new Error("Deployment evidence renderer.artifactBytes must be a positive integer");
    }
  }
  if (value.model) {
    requireText(value.model.family, "model.family");
    requireDigest(value.model.checkpointDigest, "model.checkpointDigest");
  }
  return value;
}

export async function writeDeploymentEvidence(
  target: EvidenceTarget,
  name: string,
  value: DeploymentE2eEvidence,
): Promise<string> {
  return writeEvidence(target, name, validateDeploymentEvidence(value));
}
