import { describe, expect, it } from "vitest";
import { remapUploadedCamera } from "./params";

describe("uploaded camera reassignment", () => {
  it("can correct arbitrary file order when all seven slots are occupied", () => {
    const cameras = [0, 1, 2, 3, 5, 6, 4].map((cameraId, inputIndex) => ({
      cameraId,
      inputIndex,
      offsetSeconds: 0,
    }));
    const first = remapUploadedCamera(cameras, 1, 4, 4);
    const corrected = remapUploadedCamera(first.cameras, first.primaryCameraId, 5, 5);
    expect(corrected.cameras.map((camera) => camera.cameraId)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("keeps the selected recording primary when its camera slot is reassigned", () => {
    const cameras = [
      { cameraId: 1, inputIndex: 0, offsetSeconds: 0 },
      { cameraId: 4, inputIndex: 1, offsetSeconds: 0.2 },
    ];
    const reassigned = remapUploadedCamera(cameras, 1, 1, 1);
    expect(reassigned.cameras.find((camera) => camera.cameraId === 1)?.inputIndex).toBe(1);
    expect(reassigned.cameras.find((camera) => camera.cameraId === reassigned.primaryCameraId)?.inputIndex).toBe(0);
  });
});
