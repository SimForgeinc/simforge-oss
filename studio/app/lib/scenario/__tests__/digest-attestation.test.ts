import assert from "node:assert/strict";
import { test } from "node:test";

import { MAP_GRAPH_SIDECARS, requiresDigestAttestation } from "../contracts";

test("every member the client pins is streamed with its digest attested", () => {
  for (const member of MAP_GRAPH_SIDECARS) assert.equal(requiresDigestAttestation(member), true, member);
  // playback's map runtime checks x-content-sha256 against descriptor.ground.sha256 (engine 0.11 contact)
  assert.equal(requiresDigestAttestation("derived/ground/ground-mesh.bin"), true);
});

test("everything else is redirected to the object store", () => {
  for (const member of ["3d/manifest.json", "images/abc.ktx2", "derived/ground/ground-report.json", "derived/sumo/map.net.xml"]) {
    assert.equal(requiresDigestAttestation(member), false, member);
  }
});
