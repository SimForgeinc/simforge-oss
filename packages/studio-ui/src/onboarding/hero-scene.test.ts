import { describe, expect, it } from "vitest";
import { shouldRenderHeroScene } from "./hero-scene";

const SUPPORTED = { reducedMotion: false, online: true, webgl: true };

describe("onboarding hero scene", () => {
  it("runs the scenes where they can render", () => {
    expect(shouldRenderHeroScene(SUPPORTED)).toBe(true);
  });

  it("does not download the SDK without WebGL", () => {
    expect(shouldRenderHeroScene({ ...SUPPORTED, webgl: false })).toBe(false);
  });

  it("does not download the SDK on an offline installation", () => {
    expect(shouldRenderHeroScene({ ...SUPPORTED, online: false })).toBe(false);
  });

  it("honours a reduced-motion preference", () => {
    expect(shouldRenderHeroScene({ ...SUPPORTED, reducedMotion: true })).toBe(false);
  });
});
