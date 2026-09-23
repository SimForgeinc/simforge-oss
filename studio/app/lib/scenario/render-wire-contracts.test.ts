import assert from "node:assert/strict";
import { test } from "node:test";

import { CAMERA_PROFILE_NOT_DECLARED_STATUS } from "@simforge-oss/render";
import { createRenderEngine } from "@simforge-oss/render/native";

import {
  CompleteRenderJobV2Schema,
  ScenarioRendererCapabilitySchema,
} from "./render-wire-contracts";

test("Studio accepts checkpoint-1 native capabilities and completion evidence", () => {
  const nativeCapabilities = createRenderEngine({ binary: "/bin/true" }).capabilities;
  assert.deepEqual(ScenarioRendererCapabilitySchema.parse(nativeCapabilities), nativeCapabilities);
  assert.deepEqual(nativeCapabilities.features?.["full-mount-rotation"], {
    support: "supported",
    evidenceTier: "integrated",
    note: "GPU rendered-horizon proof pending",
  });

  const completion = CompleteRenderJobV2Schema.parse({
    schema: "simforge.render-worker-control/v2",
    type: "job.complete",
    leaseId: "lease-1",
    fenceToken: "f".repeat(32),
    intentSha256: "a".repeat(64),
    manifest: {
      artifacts: [{
        artifactId: "artifact-1",
        identity: { role: "manifest", actorId: null, sensorId: null, modality: null },
        sha256: "b".repeat(64),
        sizeBytes: 1,
        mediaType: "application/json",
      }],
      effectiveConfiguration: {
        cameraProfiles: [{
          actorId: "ego",
          sensorId: "camera",
          outputName: "camera-rgb",
          profileSource: "default",
          status: CAMERA_PROFILE_NOT_DECLARED_STATUS,
        }],
      },
      warnings: [{
        code: "camera_profile_not_declared_by_engine",
        message: `${CAMERA_PROFILE_NOT_DECLARED_STATUS}: ego/camera`,
      }],
    },
  });
  assert.equal(
    completion.manifest.effectiveConfiguration?.cameraProfiles[0]?.status,
    CAMERA_PROFILE_NOT_DECLARED_STATUS,
  );
});
