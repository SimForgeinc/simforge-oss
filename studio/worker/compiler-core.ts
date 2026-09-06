import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

import type { DerivedTopology, LocationCatalog } from "@simforge-oss/maps";
import {
  compileExecutionPackage,
  createMapBundle,
  type ExecutionAmbientProvenance,
  type ExecutionArtifact,
  type ExecutionPackage,
  type MapBundle,
} from "@simforge-oss/compiler/node";

export const COMPILER_VERSION = "uniscenario-compiler@2.0.0";
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;

export type CompilerArtifactKind = "xosc" | "capability-report" | "compiler-provenance" | "execution-manifest";
export type CompilerArtifact = ExecutionArtifact & { kind: CompilerArtifactKind };
type MapArtifactKind = "map-xodr" | "map-topology" | "map-derived-topology" | "map-locations" | "map-signals" | "asset-catalog";
export type CompilerClaim = {
  contract: "uniscenario.compiler-claim/v1";
  exportId: string; attemptId: string; fenceToken: string; leaseExpiresAt: string; compilerVersion: string;
  revision: { id: string; contentSha256: string; canonicalContent: unknown; mapVersionId: string };
  map: {
    id: string; sourceMapId: string; runtimeMapName: string; coordinateSystemId: string; coordinateSystemSha256: string;
    assetCatalogVersionId: string; assetCatalogManifestSha256: string; sumoNetworkSha256: string | null;
    artifacts: Array<{ id: string; kind: MapArtifactKind; mediaType: string; sha256: string; sizeBytes: number; downloadUrl: string }>;
  };
  ambient: ExecutionAmbientProvenance;
};
export type CompileResult = ExecutionPackage & { artifacts: CompilerArtifact[] };

type LoadedMapClosure = { bundle: MapBundle; xodr: string; artifactDigests: Readonly<Record<string, string>> };

async function download(url: string, expectedSize: number, expectedSha256: string, signal: AbortSignal): Promise<Uint8Array> {
  if (expectedSize > MAX_ARTIFACT_BYTES) throw new Error("map_artifact_too_large");
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]) });
  if (!response.ok || !response.body) throw new Error(`map_artifact_download_failed:${response.status}`);
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  for (;;) {
    const part = await reader.read(); if (part.done) break; total += part.value.byteLength;
    if (total > expectedSize || total > MAX_ARTIFACT_BYTES) { await reader.cancel(); throw new Error("map_artifact_too_large"); }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  if (bytes.byteLength !== expectedSize) throw new Error("map_artifact_size_mismatch");
  if (createHash("sha256").update(bytes).digest("hex") !== expectedSha256) throw new Error("map_artifact_digest_mismatch");
  return bytes;
}
function decodeJson<T>(bytes: Uint8Array): T {
  const plain = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
  return JSON.parse(Buffer.from(plain).toString("utf8")) as T;
}

async function loadMapClosure(claim: CompilerClaim, signal: AbortSignal): Promise<LoadedMapClosure> {
  const entries = await Promise.all(claim.map.artifacts.map(async (item) => [item.kind, await download(item.downloadUrl, item.sizeBytes, item.sha256, signal)] as const));
  const byKind = new Map(entries);
  const required = (kind: MapArtifactKind) => { const value = byKind.get(kind); if (!value) throw new Error(`map_closure_missing:${kind}`); return value; };
  const xodr = Buffer.from(required("map-xodr")).toString("utf8");
  const derived = decodeJson<DerivedTopology>(required("map-derived-topology"));
  const locations = decodeJson<LocationCatalog>(required("map-locations"));
  // The native bundle derives the signal catalog, map speed limits and matcher index from these sources.
  const bundle = createMapBundle({ mapId: claim.map.sourceMapId, topology: required("map-topology"), derived, locations, xodr, signalsGeojson: decodeJson<unknown>(required("map-signals")) });
  return { bundle, xodr, artifactDigests: Object.fromEntries(claim.map.artifacts.map((item) => [item.kind, item.sha256])) };
}

/**
 * Local's execution package is the canonical one: authored, native-resolved
 * input exported as-is. Local's renderer is Native, so no consumer projection
 * is bound; the digest is the raw resolved input, exactly as the browser's
 * native trace header hashed it (`manifest.inputHash`).
 */
export async function compileClaim(claim: CompilerClaim, xsdPath: string, signal: AbortSignal): Promise<CompileResult> {
  if (claim.compilerVersion !== COMPILER_VERSION) throw new Error("compiler_version_mismatch");
  const loaded = await loadMapClosure(claim, signal);
  const xodrArtifact = claim.map.artifacts.find((item) => item.kind === "map-xodr")!;
  const result = await compileExecutionPackage({
    revisionId: claim.revision.id,
    expectedContentSha256: claim.revision.contentSha256,
    canonicalContent: claim.revision.canonicalContent,
    mapVersionId: claim.revision.mapVersionId,
    mapAssetId: claim.map.sourceMapId,
    runtimeMapName: claim.map.runtimeMapName,
    map: loaded.bundle,
    xodr: loaded.xodr,
    xodrSha256: xodrArtifact.sha256,
    mapArtifactDigests: loaded.artifactDigests,
    coordinateSystemId: claim.map.coordinateSystemId,
    coordinateSystemSha256: claim.map.coordinateSystemSha256,
    assetCatalogVersionId: claim.map.assetCatalogVersionId,
    assetCatalogManifestSha256: claim.map.assetCatalogManifestSha256,
    ambient: claim.ambient,
    compilerVersion: COMPILER_VERSION,
    xsdPath,
  });
  return result as CompileResult;
}
