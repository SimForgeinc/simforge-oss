import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { boundMapDerivatives, mapDerivativeExtraMembers, mapDerivativesDigest } from "../map-derivatives";

const D = (c: string) => c.repeat(64);
const ready = (schema: string, members: unknown[], manifestSha256 = D("a")) => ({ state: "ready", schema, buildKey: D("b"), manifestSha256, members });
const lod = (members: unknown[], manifestSha256?: string) => ready("simforge.map-geometry-lod.v1", members, manifestSha256);
const manifest = { relativePath: "derived/geometry-lod/manifest.json", sha256: D("a"), byteLength: 10 };
const lodBin = { relativePath: "derived/geometry-lod/lod.bin", sha256: D("c"), byteLength: 20 };
const image = { relativePath: "derived/geometry-lod/images/abc.ktx2", sha256: D("d"), byteLength: 30 };
const bc7Manifest = { relativePath: "derived/textures-full-bc7/manifest.json", sha256: D("e"), byteLength: 40 };
const bc7Object = { relativePath: `derived/textures-full-bc7/objects/${D("f")}.ktx2`, sha256: D("f"), byteLength: 50 };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

test("ready bindings of every kind bind their members, sorted by path", () => {
  const bindings = boundMapDerivatives({ geometryLod: lod([manifest, lodBin, image]), texturesFullBc7: ready("simforge.map-texture-variant.v1", [bc7Object, bc7Manifest], D("e")) });
  assert.deepEqual(bindings.map((binding) => binding.kind.key), ["geometryLod", "texturesFullBc7"]);
  assert.deepEqual(mapDerivativeExtraMembers(bindings, new Set()).map((member) => member.relativePath), [
    "derived/geometry-lod/images/abc.ktx2", "derived/geometry-lod/lod.bin", "derived/geometry-lod/manifest.json",
    "derived/textures-full-bc7/manifest.json", bc7Object.relativePath,
  ]);
  // A JSON string (the Data API's jsonb rendering) parses the same way.
  assert.equal(boundMapDerivatives(JSON.stringify({ geometryLod: lod([manifest]) })).length, 1);
});

test("no binding unless ready", () => {
  assert.deepEqual(boundMapDerivatives(undefined), []);
  assert.deepEqual(boundMapDerivatives(null), []);
  assert.deepEqual(boundMapDerivatives({ geometryLod: { state: "failed", reason: "x" }, texturesFullBc7: { state: "building" } }), []);
});

test("a ready binding that is malformed is refused, never half-used", () => {
  for (const bad of [
    lod([lodBin]), // no manifest
    lod([manifest, lodBin], D("e")), // manifest digest mismatch
    lod([manifest, { ...lodBin, relativePath: "master.gltf" }]), // outside the derivative directory
    lod([manifest, { ...lodBin, relativePath: "derived/textures-full-bc7/objects/x.ktx2" }]), // another kind's directory
    lod([manifest, { ...lodBin, relativePath: "derived/geometry-lod/../../master.gltf" }]),
    lod([manifest, { ...lodBin, sha256: "nope" }]),
    lod([manifest, { ...lodBin, byteLength: -1 }]),
    lod([manifest, manifest]), // duplicate path
    { ...lod([manifest]), schema: "simforge.map-geometry-lod.v0" },
  ]) {
    assert.throws(() => boundMapDerivatives({ geometryLod: bad }), /map_derivative_descriptor_invalid:geometryLod/);
  }
  assert.throws(() => boundMapDerivatives({ texturesFullBc7: ready("simforge.map-geometry-lod.v1", [bc7Manifest], D("e")) }), /texturesFullBc7/);
});

test("closure members win over descriptor members of the same path", () => {
  const bindings = boundMapDerivatives({ geometryLod: lod([manifest, lodBin]) });
  assert.deepEqual(mapDerivativeExtraMembers(bindings, new Set(["derived/geometry-lod/lod.bin"])).map((member) => member.relativePath), ["derived/geometry-lod/manifest.json"]);
  assert.deepEqual(mapDerivativeExtraMembers([], new Set()), []);
});

test("the derivatives digest changes with any binding and is absent without one", () => {
  assert.equal(mapDerivativesDigest([], hash), undefined);
  const one = mapDerivativesDigest(boundMapDerivatives({ geometryLod: lod([manifest]) }), hash);
  const two = mapDerivativesDigest(boundMapDerivatives({ geometryLod: lod([manifest]), texturesFullBc7: ready("simforge.map-texture-variant.v1", [bc7Manifest], D("e")) }), hash);
  assert.match(one!, /^[a-f0-9]{64}$/);
  assert.notEqual(one, two);
});
