import assert from "node:assert/strict";
import { test } from "node:test";

import { groundDescriptor } from "../ground-descriptor";

const mesh = "a".repeat(64);

test("records status, flags and warnings of the manifest for its own mesh", () => {
  const manifest = JSON.stringify({ status: "flagged", flags: ["surface-holes"], warnings: ["holes at x 8.2, y 358.7"], mesh: { sha256: mesh } });
  assert.deepEqual(groundDescriptor(manifest, mesh), { sha256: mesh, status: "flagged", flags: ["surface-holes"], warnings: ["holes at x 8.2, y 358.7"] });
});

test("refuses a manifest describing another mesh, or an unknown status", () => {
  assert.throws(() => groundDescriptor(JSON.stringify({ status: "ok", mesh: { sha256: "b".repeat(64) } }), mesh), /ground_derivative_mismatch/);
  assert.throws(() => groundDescriptor(JSON.stringify({ status: "xodr-disagrees", mesh: { sha256: mesh } }), mesh), /ground_derivative_status/);
});
