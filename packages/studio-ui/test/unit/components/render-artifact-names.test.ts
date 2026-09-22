import { describe, expect, it } from "vitest";
import type { ScenarioRenderArtifactDto } from "@simforge-oss/studio-host";
import { artifactDisplayName, groupArtifacts } from "../../../src/scenario/editor/render/render-view-model";

function artifact(actorId: string, sensorId: string, role = "video", modality = "rgb", sensorLabel: string | null = "Front Center"): ScenarioRenderArtifactDto {
  return { id: `${actorId}-${sensorId}-${role}`, artifactKind: role, mediaType: role === "video" ? "video/mp4" : "application/zip", byteLength: 1024, sha256: "a".repeat(64), artifactState: "available", relationship: "render_output", renderAttemptId: "attempt", identity: { actorId, sensorId, role, modality }, sensorLabel, durationSeconds: 10, createdAt: "2026-09-22T00:00:00Z", verifiedAt: null };
}

describe("render artifact names", () => {
  it("names camera position and output, without leaking generated identifiers", () => {
    expect(artifactDisplayName(artifact("vehicle-opaque", "sensor-opaque"))).toBe("Front Center camera · RGB video");
    expect(artifactDisplayName(artifact("vehicle-opaque", "sensor-opaque", "sensorArchive", "lidar", "Roof LiDAR"))).toBe("Roof LiDAR · point archive");
    expect(artifactDisplayName(artifact("vehicle-opaque", "sensor-opaque", "video", "radar", null))).toBe("Radar · Video");
    expect(artifactDisplayName(artifact("vehicle-opaque", "sensor-opaque", "video", "rgb", "sensor-opaque"))).toBe("Camera · RGB video");
  });

  it("groups video and archive by physical sensor, not coincident display names", () => {
    const video = artifact("ego", "lidar", "video", "lidar", "Roof LiDAR");
    const archive = artifact("ego", "lidar", "sensorArchive", "lidar", "Roof LiDAR");
    const otherActor = artifact("other", "lidar", "video", "lidar", "Roof LiDAR");
    const groups = groupArtifacts([archive, otherActor, video]);
    expect(groups.map(group => group.items.map(item => item.id))).toEqual([[video.id, archive.id], [otherActor.id]]);
  });
});
