import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { MODEL_CATALOG, MODEL_FAMILIES, quantOffer, rigPresetForCameras } from "./catalog";
import { LockHasher, checkpointDigestFromLock, expectedDigest, verifyFile } from "./integrity";
import { ModelLockSchema, installFiles, loadModelLock, type ModelLockFile } from "./lock";

const scratch = mkdtempSync(join(tmpdir(), "simforge-model-store-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function blobId(bytes: Buffer): string {
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

describe("the committed model lock", () => {
  it("validates and agrees with the catalog for every family", async () => {
    const lock = await loadModelLock();
    for (const family of MODEL_FAMILIES) {
      const entry = lock.models[family]!;
      expect(entry.weights.repo).toBe(MODEL_CATALOG[family].weightsRepo);
      expect(entry.weights.revision).toBe(MODEL_CATALOG[family].weightsRevision);
    }
  });

  it("pins each family's checkpoint digest to its own weight shards", async () => {
    const lock = await loadModelLock();
    for (const family of MODEL_FAMILIES) {
      const entry = lock.models[family]!;
      expect(checkpointDigestFromLock(entry.weights.files), family).toBe(entry.weights.checkpointDigest);
    }
  });

  it("rejects a lock whose revision drifts from the catalog", async () => {
    const lock = structuredClone(await loadModelLock());
    const family = MODEL_FAMILIES[0]!;
    lock.models[family]!.weights.revision = "0".repeat(40);
    const parsed = ModelLockSchema.safeParse(lock);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.message).join("\n")).toContain(`${family}: lock revision`);
  });

  it("never attaches a credential to a weight download and namespaces sidecars by repo", async () => {
    const lock = await loadModelLock();
    for (const family of MODEL_FAMILIES) {
      const files = installFiles(lock.models[family]!);
      for (const file of files) {
        if (file.role === "weights") {
          expect(file.gated).toBe(false);
          expect(file.destination.startsWith("weights")).toBe(true);
        } else {
          expect(file.destination.startsWith(join("sidecars", file.repo.replace("/", "--")))).toBe(true);
        }
      }
    }
  });
});

describe("integrity verification", () => {
  const content = Buffer.from("tokenizer config\n");
  const blobRecord: ModelLockFile = {
    path: "config.json",
    digestSource: "git-blob-sha1",
    sha256: null,
    blobId: blobId(content),
    sizeBytes: content.byteLength,
  };
  const lfsRecord: ModelLockFile = {
    path: "model-00001.safetensors",
    digestSource: "hf-lfs",
    sha256: createHash("sha256").update(content).digest("hex"),
    blobId: null,
    sizeBytes: content.byteLength,
  };

  it("reproduces the upstream git blob id and the LFS sha256 while streaming", () => {
    for (const record of [blobRecord, lfsRecord]) {
      const hasher = new LockHasher(record);
      hasher.update(content.subarray(0, 5));
      hasher.update(content.subarray(5));
      expect(hasher.finish()).toEqual({ digest: expectedDigest(record), bytes: content.byteLength });
    }
  });

  it("verifies a good file and names a missing, short or altered one", async () => {
    const good = join(scratch, "good.json");
    writeFileSync(good, content);
    expect(await verifyFile(good, blobRecord)).toMatchObject({ present: true, sizeOk: true, digestOk: true });

    expect(await verifyFile(join(scratch, "absent.json"), blobRecord)).toMatchObject({ present: false, reason: "missing" });

    const short = join(scratch, "short.json");
    writeFileSync(short, content.subarray(1));
    expect(await verifyFile(short, blobRecord)).toMatchObject({ sizeOk: false, digestOk: false });

    const altered = join(scratch, "altered.json");
    writeFileSync(altered, Buffer.from(content.toString().toUpperCase()));
    expect(await verifyFile(altered, lfsRecord)).toMatchObject({ sizeOk: true, digestOk: false, reason: "digest mismatch" });
  });
});

describe("catalog lookups", () => {
  it("matches rig presets exactly, never by nearest camera set", () => {
    expect(rigPresetForCameras([6, 1])).toBe("alpamayo-2cam");
    expect(rigPresetForCameras([1])).toBeNull();
  });

  it("answers undefined for an unknown family or quant instead of a fallback", () => {
    expect(quantOffer("alpamayo-9", "bf16")).toBeUndefined();
    expect(quantOffer("alpamayo-2-super", "fp8")).toBeUndefined();
  });
});
