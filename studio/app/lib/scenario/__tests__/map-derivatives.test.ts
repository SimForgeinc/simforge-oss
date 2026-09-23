import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { boundMapDerivatives, derivativeMembers, mapDerivativeExtraMembers, mapDerivativesDigest } from "../map-derivatives";

const D = (c: string) => c.repeat(64);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const lod = (extra: Record<string, unknown> = {}) => ({ state: "ready", schema: "simforge.map-geometry-lod.v1", buildKey: D("b"), manifestSha256: D("a"), assetSetId: "usnset_lod_1", objectCount: 2, ...extra });
const bc7 = (extra: Record<string, unknown> = {}) => ({ state: "ready", schema: "simforge.map-texture-variant.v1", buildKey: D("c"), manifestSha256: D("e"), assetSetId: "usnset_bc7_1", objectCount: 2, ...extra });
const rows = [
  { set_id: "usnset_lod_1", relative_path: "derived/geometry-lod/manifest.json", sha256: D("a"), byte_length: 10 },
  { set_id: "usnset_lod_1", relative_path: "derived/geometry-lod/lod.bin", sha256: D("d"), byte_length: "20" },
  { set_id: "usnset_bc7_1", relative_path: "derived/textures-full-bc7/manifest.json", sha256: D("e"), byte_length: 30 },
  { set_id: "usnset_bc7_1", relative_path: `derived/textures-full-bc7/objects/${D("f")}.ktx2`, sha256: D("f"), byte_length: 40 },
];

test("ready summaries of every kind bind their derivative sets", () => {
  const bindings = boundMapDerivatives({ geometryLod: lod(), texturesFullBc7: bc7() });
  assert.deepEqual(bindings.map((binding) => [binding.kind.key, binding.assetSetId]), [["geometryLod", "usnset_lod_1"], ["texturesFullBc7", "usnset_bc7_1"]]);
  assert.deepEqual(derivativeMembers(bindings, rows).map((member) => member.relativePath), [
    "derived/geometry-lod/lod.bin", "derived/geometry-lod/manifest.json",
    "derived/textures-full-bc7/manifest.json", `derived/textures-full-bc7/objects/${D("f")}.ktx2`,
  ]);
  assert.equal(derivativeMembers(bindings, rows)[0]!.byteLength, 20);
  // A JSON string (the Data API's jsonb rendering) parses the same way.
  assert.equal(boundMapDerivatives(JSON.stringify({ geometryLod: lod() })).length, 1);
});

test("no binding unless ready", () => {
  assert.deepEqual(boundMapDerivatives(undefined), []);
  assert.deepEqual(boundMapDerivatives(null), []);
  assert.deepEqual(boundMapDerivatives({ geometryLod: { state: "failed", reason: "x" }, texturesFullBc7: { state: "building" } }), []);
});

test("a ready summary that is malformed is refused", () => {
  for (const bad of [lod({ assetSetId: undefined }), lod({ assetSetId: "x; DROP" }), lod({ objectCount: 0 }), lod({ manifestSha256: "nope" }), lod({ schema: "simforge.map-texture-variant.v1" })]) {
    assert.throws(() => boundMapDerivatives({ geometryLod: bad }), /map_derivative_descriptor_invalid:geometryLod/);
  }
});

test("an incomplete or foreign derivative set is refused, never half-used", () => {
  const bindings = boundMapDerivatives({ geometryLod: lod() });
  assert.throws(() => derivativeMembers(bindings, rows.slice(1)), /map_derivative_member_unavailable:geometryLod/); // no manifest
  assert.throws(() => derivativeMembers(bindings, [rows[0]!]), /unavailable/); // count mismatch
  assert.throws(() => derivativeMembers(boundMapDerivatives({ geometryLod: lod({ manifestSha256: D("9") }) }), rows), /unavailable/);
  assert.throws(() => derivativeMembers(bindings, [rows[0]!, { ...rows[1]!, relative_path: "master.gltf" }]), /unavailable/);
});

test("closure members win over derivative members of the same path", () => {
  const members = derivativeMembers(boundMapDerivatives({ geometryLod: lod() }), rows);
  assert.deepEqual(mapDerivativeExtraMembers(members, new Set(["derived/geometry-lod/lod.bin"])).map((member) => member.relativePath), ["derived/geometry-lod/manifest.json"]);
});

test("the derivatives digest changes with any binding and is absent without one", () => {
  assert.equal(mapDerivativesDigest([], hash), undefined);
  const one = mapDerivativesDigest(boundMapDerivatives({ geometryLod: lod() }), hash);
  const two = mapDerivativesDigest(boundMapDerivatives({ geometryLod: lod(), texturesFullBc7: bc7() }), hash);
  assert.match(one!, /^[a-f0-9]{64}$/);
  assert.notEqual(one, two);
});
