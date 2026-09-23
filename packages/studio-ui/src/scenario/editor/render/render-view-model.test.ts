import { describe, expect, it } from "vitest";

import { jobFailureMessage } from "./render-view-model";

describe("jobFailureMessage", () => {
  it("names a no-silent-fallbacks refusal by what is degraded, without the render. namespace", () => {
    expect(jobFailureMessage({ jobState: "failed", failureCode: "render.carla_actors_dropped" })).toBe("Carla actors dropped");
    expect(jobFailureMessage({ jobState: "failed", failureCode: "render.native_parity_missing" })).toBe("Native parity missing");
  });

  it("keeps plain-English copy and the humanized fallback for other codes", () => {
    expect(jobFailureMessage({ jobState: "failed", failureCode: "lease_expired" })).toBe("The render worker stopped reporting and its lease expired.");
    expect(jobFailureMessage({ jobState: "failed", failureCode: "render.execution_failed" })).toBe("Render.execution failed");
    expect(jobFailureMessage({ jobState: "succeeded", failureCode: "render.carla_actors_dropped" })).toBeNull();
  });
});
