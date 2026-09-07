import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { posix, resolve, sep } from "node:path";
import { NATIVE_MAP_RELEASE_RECEIPT, type RegisteredNativeMapMember } from "../app/lib/map-ingest/native-map-source";
import { nativeMasterResources } from "../app/lib/map-ingest/native-master-resources";

const SHA256 = /^[a-f0-9]{64}$/u;

export type NativeReadyPayload = {
  relativePath: string;
  path: string;
  sha256: string;
  sizeBytes: number;
};

export type NativeReadyMap = {
  /** The immutable map identity a preview's provenance records; today the registry release digest. */
  mapDigest: string;
  releaseDigest: string;
  directory: string;
  masterPath: string;
  payloads: NativeReadyPayload[];
};


/** A failure with a stable API/worker error code. */
export class HifiPreviewFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

function safeMemberPath(relativePath: string): boolean {
  return relativePath.length > 0
    && !/[\\:%?#\u0000-\u001f]/u.test(relativePath)
    && relativePath.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function isDeclaration(value: RegisteredNativeMapMember): boolean {
  return typeof value.relativePath === "string" && safeMemberPath(value.relativePath)
    && value.relativePath !== NATIVE_MAP_RELEASE_RECEIPT
    && typeof value.sha256 === "string" && SHA256.test(value.sha256)
    && Number.isSafeInteger(value.sizeBytes) && value.sizeBytes >= 0;
}

async function digestFile(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

/** Validate active runtime resources, not unused archival raster fallbacks. */
async function validateMasterClosure(masterPath: string, declared: ReadonlySet<string>): Promise<void> {
  let document: unknown;
  try {
    document = JSON.parse(await readFile(masterPath, "utf8"));
  } catch (error) {
    throw new HifiPreviewFailure("native_payload_master_invalid", "native master.gltf is not valid JSON", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  if (!document || typeof document !== "object" || Array.isArray(document)
    || !("asset" in document)
    || !document.asset || typeof document.asset !== "object" || Array.isArray(document.asset)
    || !("version" in document.asset) || document.asset.version !== "2.0") {
    throw new HifiPreviewFailure("native_payload_master_invalid", "native master.gltf is not glTF 2.0");
  }
  let resources: string[];
  try {
    resources = nativeMasterResources(document);
  } catch (error) {
    throw new HifiPreviewFailure("native_payload_master_invalid", "native master.gltf declares invalid resources", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  for (const uri of resources) {
    const memberPath = posix.normalize(uri);
    if (!safeMemberPath(memberPath) || !declared.has(memberPath)) {
      throw new HifiPreviewFailure(
        "native_payload_resource_missing",
        `master.gltf references undeclared native member: ${uri}`,
        { relativePath: uri },
      );
    }
  }
}

/**
 * Resolve a map version's registered native closure against the directory
 * `ensureLocalMap(mapVersionId, 'semantic')` materialized for it. The
 * declarations come from the map's registered native asset set; every
 * declared member must be present at its relative path with exactly the
 * registered bytes, and master.gltf may reference only declared members.
 * Nothing about the directory is trusted on its own: no receipt is read and
 * no undeclared file is ever handed to the renderer.
 */
export async function resolveNativeReadyMap(input: {
  directory: string;
  mapId: string;
  releaseDigest: string;
  members: readonly RegisteredNativeMapMember[];
}): Promise<NativeReadyMap> {
  if (typeof input.mapId !== "string" || input.mapId.length === 0 || !SHA256.test(input.releaseDigest)) {
    throw new HifiPreviewFailure("native_payload_identity_invalid", "native map identity is invalid", {
      mapId: input.mapId,
      releaseDigest: input.releaseDigest,
    });
  }
  const identity = { mapId: input.mapId, releaseDigest: input.releaseDigest };
  const declarations = [...input.members].sort((left, right) =>
    left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0);
  const declared = new Set<string>();
  for (const member of declarations) {
    if (!isDeclaration(member) || declared.has(member.relativePath)) {
      throw new HifiPreviewFailure("native_payload_member_invalid", `native member declaration is unsafe: ${member.relativePath}`, {
        ...identity,
        relativePath: member.relativePath,
      });
    }
    declared.add(member.relativePath);
  }
  if (!declared.has("master.gltf")) {
    throw new HifiPreviewFailure("native_payload_master_missing", `native closure declares no master.gltf for ${input.mapId}`, identity);
  }

  const directory = resolve(input.directory);
  try {
    if (!(await stat(directory)).isDirectory()) throw new Error("not a directory");
  } catch (error) {
    throw new HifiPreviewFailure("native_payload_unavailable", `native map directory is unavailable for ${input.mapId}`, {
      ...identity,
      directory,
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  const payloads: NativeReadyPayload[] = [];
  for (const expected of declarations) {
    const { relativePath } = expected;
    const path = resolve(directory, ...relativePath.split("/"));
    if (!path.startsWith(`${directory}${sep}`)) {
      throw new HifiPreviewFailure("native_payload_member_invalid", `native member path is unsafe: ${relativePath}`, {
        ...identity,
        relativePath,
      });
    }
    let sizeBytes: number;
    let actualSha256: string;
    try {
      const metadata = await stat(path);
      if (!metadata.isFile()) throw new Error("not a regular file");
      sizeBytes = metadata.size;
      actualSha256 = await digestFile(path);
    } catch (error) {
      throw new HifiPreviewFailure("native_payload_member_missing", `native member is unavailable: ${relativePath}`, {
        ...identity,
        relativePath,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    if (sizeBytes !== expected.sizeBytes || actualSha256 !== expected.sha256) {
      throw new HifiPreviewFailure("native_payload_member_mismatch", `native member does not match its registration: ${relativePath}`, {
        ...identity,
        relativePath,
        expectedSha256: expected.sha256,
        actualSha256,
        expectedSizeBytes: expected.sizeBytes,
        actualSizeBytes: sizeBytes,
      });
    }
    payloads.push({ relativePath, path, sha256: expected.sha256, sizeBytes });
  }
  const master = payloads.find((payload) => payload.relativePath === "master.gltf")!;
  await validateMasterClosure(master.path, declared);
  return {
    mapDigest: input.releaseDigest,
    releaseDigest: input.releaseDigest,
    directory,
    masterPath: master.path,
    payloads,
  };
}
