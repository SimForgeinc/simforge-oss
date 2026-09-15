import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SCENARIO_RENDER_JOB_MODES } from "@simforge-oss/studio-host";
import { galleryScope } from "../gallery-scope";

describe("gallery scope", () => {
  /**
   * Every render mode the product has, written out rather than derived.
   *
   * This list is deliberately an independent witness. Iterating
   * `SCENARIO_RENDER_JOB_MODES` to check that each of its members is accepted
   * proves nothing — the accepting code reads the same array, so dropping a
   * mode from the vocabulary merely shortens the loop and the test still
   * passes. That is the exact hole the original defect fell through. Spelling
   * the modes here means losing one fails the assertion, and adding a real new
   * mode is a contract change that should have to be acknowledged in a test.
   */
  const EVERY_MODE = ["interaction_2d", "full_render", "browser_render", "cosmos_augment", "vlm_annotate"];

  it("declares exactly the render job modes the product has", () => {
    assert.deepEqual([...SCENARIO_RENDER_JOB_MODES].sort(), [...EVERY_MODE].sort());
  });

  /**
   * The regression that matters. The route used to carry its own hand-spelled
   * mode list which omitted `browser_render`, so that filter was silently
   * dropped and the answer widened from "this mode's renders" to "every render
   * in the workspace" — a wrong result set, not an error.
   */
  it("keeps every render job mode as a filter rather than degrading it", () => {
    for (const mode of EVERY_MODE) {
      assert.deepEqual(
        galleryScope(new URLSearchParams(`jobMode=${mode}`)),
        { kind: "workspace", jobMode: mode },
        `${mode} must survive as a filter, not degrade to an unfiltered gallery`,
      );
    }
  });

  it("degrades an unknown mode to no filter rather than failing the read", () => {
    assert.deepEqual(galleryScope(new URLSearchParams("jobMode=teleportation")), { kind: "workspace", jobMode: null });
    assert.deepEqual(galleryScope(new URLSearchParams("")), { kind: "workspace", jobMode: null });
  });

  it("narrows to a revision over a document when both are supplied", () => {
    assert.deepEqual(galleryScope(new URLSearchParams("revisionId=usrv_1&documentId=uscn_1")), {
      kind: "revision",
      revisionId: "usrv_1",
    });
    assert.deepEqual(galleryScope(new URLSearchParams("documentId=uscn_1")), { kind: "document", documentId: "uscn_1" });
  });

  it("ignores a mode filter once the scope is narrowed, so a tab cannot half-filter", () => {
    assert.deepEqual(galleryScope(new URLSearchParams("documentId=uscn_1&jobMode=full_render")), {
      kind: "document",
      documentId: "uscn_1",
    });
  });
});
