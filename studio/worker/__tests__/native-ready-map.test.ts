import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { RegisteredNativeMapMember } from "../../app/lib/map-ingest/native-map-source";
import { HifiPreviewFailure, resolveNativeReadyMap } from "../native-ready-map";

const MAP_ID = "map_registered_source";
const RELEASE_DIGEST = "a".repeat(64);
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

const MASTER = JSON.stringify({
  asset: { version: "2.0" },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0 }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
  accessors: [{ min: [0, 0, 0], max: [1, 1, 1] }],
  buffers: [{ uri: "buffers/geometry.bin", byteLength: 4 }],
});
const GEOMETRY = Buffer.from([1, 2, 3, 4]);

const DECLARED: RegisteredNativeMapMember[] = [
  { relativePath: "master.gltf", sha256: digest(MASTER), sizeBytes: Buffer.byteLength(MASTER) },
  { relativePath: "buffers/geometry.bin", sha256: digest(GEOMETRY), sizeBytes: GEOMETRY.byteLength },
];

/** A materialized semantic profile: members at their relative paths, no receipt. */
async function preparedProfile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "simforge-native-ready-"));
  await mkdir(join(directory, "buffers"), { recursive: true });
  await writeFile(join(directory, "master.gltf"), MASTER);
  await writeFile(join(directory, "buffers", "geometry.bin"), GEOMETRY);
  return directory;
}

function resolveWith(directory: string, members: readonly RegisteredNativeMapMember[] = DECLARED) {
  return resolveNativeReadyMap({ directory, mapId: MAP_ID, releaseDigest: RELEASE_DIGEST, members });
}

async function rejectsWithCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof HifiPreviewFailure);
    assert.equal(error.code, code);
    return true;
  });
}

describe("native-ready map resolution", () => {
  it("returns the complete checksum-verified closure of a prepared profile without a receipt", async () => {
    const directory = await preparedProfile();
    try {
      // Declaration order is irrelevant; payloads are reported in path order.
      const resolved = await resolveWith(directory, [...DECLARED].reverse());
      assert.equal(resolved.directory, directory);
      assert.equal(resolved.masterPath, join(directory, "master.gltf"));
      assert.equal(resolved.mapDigest, RELEASE_DIGEST);
      assert.equal(resolved.releaseDigest, RELEASE_DIGEST);
      assert.deepEqual(resolved.payloads.map(({ relativePath, sha256, sizeBytes }) => ({ relativePath, sha256, sizeBytes })), [
        { relativePath: "buffers/geometry.bin", sha256: digest(GEOMETRY), sizeBytes: GEOMETRY.byteLength },
        { relativePath: "master.gltf", sha256: digest(MASTER), sizeBytes: Buffer.byteLength(MASTER) },
      ]);
      assert.equal(resolved.payloads[0]!.path, join(directory, "buffers", "geometry.bin"));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a directory that was never materialized", async () => {
    const root = await mkdtemp(join(tmpdir(), "simforge-native-absent-"));
    try {
      await rejectsWithCode(resolveWith(join(root, "missing")), "native_payload_unavailable");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a declared member that is missing on disk", async () => {
    const directory = await preparedProfile();
    try {
      await rm(join(directory, "buffers", "geometry.bin"));
      await rejectsWithCode(resolveWith(directory), "native_payload_member_missing");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a member whose bytes differ from its registration", async () => {
    const directory = await preparedProfile();
    try {
      await writeFile(join(directory, "buffers", "geometry.bin"), Buffer.from([1, 2, 3, 5]));
      await rejectsWithCode(resolveWith(directory), "native_payload_member_mismatch");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a master that references a resource the registration does not declare", async () => {
    const directory = await preparedProfile();
    try {
      await rejectsWithCode(resolveWith(directory, [DECLARED[0]!]), "native_payload_resource_missing");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a closure that declares no master.gltf", async () => {
    const directory = await preparedProfile();
    try {
      await rejectsWithCode(resolveWith(directory, [DECLARED[1]!]), "native_payload_master_missing");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects unsafe declarations before touching the directory", async () => {
    const unsafe: RegisteredNativeMapMember[][] = [
      [...DECLARED, { relativePath: "../escape.bin", sha256: digest(GEOMETRY), sizeBytes: 4 }],
      [...DECLARED, { relativePath: ".map-release.json", sha256: digest("{}"), sizeBytes: 2 }],
      [...DECLARED, { relativePath: "extra.bin", sha256: "not-a-digest", sizeBytes: 4 }],
      [...DECLARED, { relativePath: "extra.bin", sha256: digest(GEOMETRY), sizeBytes: -1 }],
      [...DECLARED, DECLARED[1]!],
    ];
    for (const members of unsafe) {
      await rejectsWithCode(resolveWith(join(tmpdir(), "never-read"), members), "native_payload_member_invalid");
    }
  });

  it("rejects an invalid release identity", async () => {
    await rejectsWithCode(
      resolveNativeReadyMap({ directory: tmpdir(), mapId: MAP_ID, releaseDigest: "abc", members: DECLARED }),
      "native_payload_identity_invalid",
    );
  });
});
