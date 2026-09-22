import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideOnboardingGate } from "../onboarding-gate";
import type { StudioSetup } from "@/app/lib/host/setup";

const pending: StudioSetup = { completedAt: null, mode: null, quality: null };
describe("local first-run completion", () => {
  it("does not complete setup merely because GPU auto-selection chose Medium", () => {
    assert.deepEqual(decideOnboardingGate({ setup: pending, browserSetupCompleted: false, quality: "medium" }), { kind: "onboard" });
  });
  it("records an installation migrated from a pre-change stored preference without re-onboarding", () => {
    assert.deepEqual(decideOnboardingGate({ setup: pending, browserSetupCompleted: true, quality: "low" }), { kind: "adopt", quality: "low" });
  });
  it("allows host-completed setup even in a new browser without a completion marker", () => {
    assert.deepEqual(decideOnboardingGate({ setup: { ...pending, completedAt: "2026-09-21T00:00:00.000Z" }, browserSetupCompleted: false, quality: "medium" }), { kind: "allow" });
  });
});
