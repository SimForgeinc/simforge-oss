import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { CAMERA_PROFILE_NOT_DECLARED_STATUS } from "@simforge-oss/render";
import { NativeRenderManifestSchema, createRenderEngine } from "@simforge-oss/render/native";
import { canonicalize } from "@simforge-oss/scenario";

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

test("Studio accepts mandatory native camera evidence in render manifest v2", () => {
  const profile = {
    schemaVersion: "simforge.camera-profile/v1" as const,
    profileId: "generic-rgb@1",
    fidelity: "generic-uncalibrated" as const,
    projection: { model: "pinhole" as const },
    detector: { noise: "none" as const },
    acquisition: { shutter: "global" as const },
    outputStage: "linear" as const,
    encoding: { transfer: "srgb" as const, bitDepth: 8 },
  };
  const configHash = createHash("sha256").update(JSON.stringify(canonicalize(profile))).digest("hex");
  const parsed = NativeRenderManifestSchema.parse({
    schema: "simforge.native-render-manifest/v2",
    intentSha256: "a".repeat(64),
    executionPackageControlSha256: "b".repeat(64),
    sourceXoscSha256: "c".repeat(64),
    loweringSha256: "d".repeat(64),
    actorAssetsSha256: "e".repeat(64),
    frameCount: 1,
    look: { profile: "sensor", lighting: {}, profileConfig: {}, autoMeter: false, provenance: {} },
    cameraProfileEvidence: "camera-profile-evidence: present (v2)",
    fidelityMode: "dataset",
    cameraProfiles: [{
      actorId: "ego", sensorId: "camera", outputName: "camera-rgb", profileSource: "default",
      profileVersion: 1, configHash, requested: profile, effective: profile, approximations: [], differences: [],
    }],
    warnings: [],
    videos: [{
      actorId: "ego", sensorId: "camera", relativePath: "video/camera-rgb.mp4",
      width: 320, height: 180, framesPerSecond: 24, frameCount: 1,
      sha256: "f".repeat(64), sizeBytes: 1,
    }],
  });

  assert.equal(parsed.schema, "simforge.native-render-manifest/v2");
  assert.equal(parsed.cameraProfileEvidence, "camera-profile-evidence: present (v2)");
});
