import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideOnboardingGate } from "../onboarding-gate";
import type { StudioSetup } from "../setup";

const PENDING: StudioSetup = { completedAt: null, mode: null, quality: null };
const DONE: StudioSetup = { completedAt: "2026-09-11T00:00:00.000Z", mode: "local", quality: "high" };

function decide(input: Partial<Parameters<typeof decideOnboardingGate>[0]>) {
  return decideOnboardingGate({
    setup: PENDING,
    preference: null,
    requestedQuality: null,
    fallbackQuality: "minimal",
    ...input,
  });
}

describe("first-run gate decision", () => {
  it("onboards an installation with neither a setup row nor a stored preference", () => {
    assert.deepEqual(decide({}), { kind: "onboard" });
  });

  it("lets a completed installation through untouched", () => {
    assert.deepEqual(decide({ setup: DONE, preference: "minimal" }), { kind: "allow" });
  });

  it("adopts the recorded level in a browser profile that has no preference", () => {
    assert.deepEqual(decide({ setup: DONE }), {
      kind: "adopt",
      quality: "high",
      savePreference: true,
      recordSetup: false,
    });
  });

  it("falls back to the default level when a completed setup recorded none", () => {
    assert.deepEqual(decide({ setup: { completedAt: DONE.completedAt, mode: "cloud", quality: null } }), {
      kind: "adopt",
      quality: "minimal",
      savePreference: true,
      recordSetup: false,
    });
  });

  it("treats an installation that predates onboarding as already set up", () => {
    assert.deepEqual(decide({ preference: "ultra-low-3d" }), {
      kind: "adopt",
      quality: "ultra-low-3d",
      savePreference: false,
      recordSetup: true,
    });
  });

  it("honours a level named by the incoming link instead of onboarding", () => {
    assert.deepEqual(decide({ requestedQuality: "roads-only" }), {
      kind: "adopt",
      quality: "roads-only",
      savePreference: true,
      recordSetup: true,
    });
  });

  it("prefers the stored preference over the link when both are present", () => {
    assert.deepEqual(decide({ preference: "high", requestedQuality: "roads-only" }), {
      kind: "adopt",
      quality: "high",
      savePreference: false,
      recordSetup: true,
    });
  });
});
