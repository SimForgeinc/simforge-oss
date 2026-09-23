import assert from "node:assert/strict";
import { test } from "node:test";

import { boundGeometryLod, geometryLodExtraMembers } from "../map-geometry-lod";

const D = (c: string) => c.repeat(64);
const ready = (members: unknown[], manifestSha256 = D("a")) => ({ state: "ready", schema: "simforge.map-geometry-lod.v1", buildKey: D("b"), manifestSha256, members });
const manifest = { relativePath: "derived/geometry-lod/manifest.json", sha256: D("a"), byteLength: 10 };
const lodBin = { relativePath: "derived/geometry-lod/lod.bin", sha256: D("c"), byteLength: 20 };
const image = { relativePath: "derived/geometry-lod/images/abc.ktx2", sha256: D("d"), byteLength: 30 };

test("a ready geometry-lod descriptor binds its members, sorted by path", () => {
  const binding = boundGeometryLod(ready([manifest, lodBin, image]));
  assert.ok(binding);
  assert.deepEqual(binding.members.map((member) => member.relativePath), [
    "derived/geometry-lod/images/abc.ktx2", "derived/geometry-lod/lod.bin", "derived/geometry-lod/manifest.json",
  ]);
});

test("no binding unless ready", () => {
  assert.equal(boundGeometryLod(undefined), null);
  assert.equal(boundGeometryLod(null), null);
  assert.equal(boundGeometryLod({ state: "failed", reason: "x" }), null);
  assert.equal(boundGeometryLod({ state: "building" }), null);
});

test("a ready descriptor that is malformed is refused, never half-used", () => {
  for (const bad of [
    ready([lodBin]), // no manifest
    ready([manifest, lodBin], D("e")), // manifest digest mismatch
    ready([manifest, { ...lodBin, relativePath: "master.gltf" }]), // outside the derivative directory
    ready([manifest, { ...lodBin, relativePath: "derived/geometry-lod/../../master.gltf" }]),
    ready([manifest, { ...lodBin, sha256: "nope" }]),
    ready([manifest, { ...lodBin, byteLength: -1 }]),
    ready([manifest, manifest]), // duplicate path
    { ...ready([manifest]), schema: "simforge.map-geometry-lod.v0" },
  ]) {
    assert.throws(() => boundGeometryLod(bad), /geometry_lod_descriptor_invalid/);
  }
});

test("closure members win over descriptor members of the same path", () => {
  const binding = boundGeometryLod(ready([manifest, lodBin]));
  assert.deepEqual(geometryLodExtraMembers(binding, new Set(["derived/geometry-lod/lod.bin"])).map((member) => member.relativePath), ["derived/geometry-lod/manifest.json"]);
  assert.deepEqual(geometryLodExtraMembers(null, new Set()), []);
});
