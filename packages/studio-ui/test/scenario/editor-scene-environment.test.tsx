// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { DirectionalLight, Scene } from "three";
import type { CityViewer, CityWeatherAppearance } from "@simforge-oss/viewer";
import type { EditorDocument } from "@simforge-oss/editor";
import type { ActorRenderer } from "@simforge-oss/viewer";
import {
  TIME_OF_DAY_PRESETS,
  WEATHER_PRESETS,
  type Environment,
} from "@simforge-oss/scenario";
import { EditorSceneEnvironmentBridge } from "../../src/scenario/editor/EditorSceneEnvironmentBridge";
import {
  applyEditorSceneEnvironment,
  resolveEditorSceneEnvironment,
} from "../../src/scenario/editor/scene-environment";
import {
  withEditorWeatherControls,
} from "../../src/scenario/editor/weather-controls";
import { withSceneMinutes } from "../../src/scenario/editor/scene-time";

afterEach(cleanup);

describe("SimForge editor Three.js environment", () => {
  it("resolves every canonical weather and time preset into renderer-owned effects", () => {
    for (const weather of WEATHER_PRESETS) {
      const appearance = resolveEditorSceneEnvironment(environment(weather, "noon"));
      expect(appearance.exposureScale).toBeGreaterThan(0);
      expect(appearance.sunIntensityScale).toBeGreaterThan(0);
      expect(appearance.surface.wetness).toBeGreaterThanOrEqual(0);
      if (weather !== "clear") expect(appearance.clouds).not.toBeNull();
    }
    for (const timeOfDay of TIME_OF_DAY_PRESETS) {
      const appearance = resolveEditorSceneEnvironment(environment("clear", timeOfDay));
      expect(appearance.environmentIntensityScale).toBeGreaterThan(0);
    }
  });

  it("interpolates lighting continuously for an exact clock time", () => {
    const noon = resolveEditorSceneEnvironment(
      withSceneMinutes(environment("clear", "noon"), 12 * 60),
    );
    const halfPast = resolveEditorSceneEnvironment(
      withSceneMinutes(environment("clear", "noon"), 12 * 60 + 30),
    );
    const afternoon = resolveEditorSceneEnvironment(
      withSceneMinutes(environment("clear", "noon"), 15 * 60),
    );

    expect(halfPast.sunIntensityScale).toBeLessThan(noon.sunIntensityScale);
    expect(halfPast.sunIntensityScale).toBeGreaterThan(afternoon.sunIntensityScale);
    expect(halfPast.sunColor).not.toBe(noon.sunColor);
  });

  it("rotates the Three.js sun with scene time and restores it on cleanup", () => {
    const scene = new Scene();
    const sun = new DirectionalLight();
    sun.name = "sun";
    sun.position.set(10, 20, 30);
    scene.add(sun, sun.target);
    const original = sun.position.clone();
    const setWeatherAppearance = vi.fn();
    const viewer = { scene, setWeatherAppearance } as unknown as CityViewer;

    const restore = applyEditorSceneEnvironment(
      viewer,
      withSceneMinutes(environment("clear", "noon"), 12 * 60),
      { quality: "high" },
    );

    expect(sun.position.y).toBeGreaterThan(sun.target.position.y);
    expect(sun.position.z).toBeLessThan(sun.target.position.z);
    restore();
    expect(sun.position.toArray()).toEqual(original.toArray());
  });

  it("maps weather presets to cloud cover, density, motion and weather tint", () => {
    expect(resolveEditorSceneEnvironment(environment("clear", "noon")).clouds).toBeNull();
    expect(resolveEditorSceneEnvironment(environment("cloudy", "noon")).clouds)
      .toMatchObject({ coverage: 0.65, opacity: 0.38, wind: 0.12, color: 0x8a99a5 });
    expect(resolveEditorSceneEnvironment(environment("heavy_rain", "noon")).clouds)
      .toMatchObject({ coverage: 0.96, opacity: 0.78, wind: 0.55, color: 0x4d5e6b });
    expect(resolveEditorSceneEnvironment(environment("snow", "noon")).clouds)
      .toMatchObject({ coverage: 0.87, opacity: 0.58, wind: -0.18, color: 0xb5c0c8 });
  });

  it("preserves physical rain and authored snow surfaces", () => {
    expect(resolveEditorSceneEnvironment(environment("heavy_rain", "noon")).surface.wetness)
      .toBeGreaterThan(0.9);

    const deepSnow = withEditorWeatherControls(environment("snow", "noon"), {
      snowCover: "deep",
      wind: "strong",
    });
    expect(resolveEditorSceneEnvironment(deepSnow)).toMatchObject({
      precipitation: { kind: "snow", wind: 0.9 },
      surface: { snowCoverage: 0.94, snowDepthM: 0.18, snowCompaction: 0.55 },
    });
  });

  it("maps every snow-cover preset to physical depth while keeping sleet shallow and compacted", () => {
    const expectedDepthM = {
      none: 0,
      dusting: 0.015,
      covered: 0.075,
      deep: 0.18,
    } as const;

    for (const [snowCover, snowDepthM] of Object.entries(expectedDepthM)) {
      const snowy = withEditorWeatherControls(environment("snow", "noon"), {
        snowCover: snowCover as keyof typeof expectedDepthM,
      });
      expect(resolveEditorSceneEnvironment(snowy).surface).toMatchObject({
        snowDepthM,
      });
    }

    expect(resolveEditorSceneEnvironment(environment("sleet", "noon")).surface)
      .toMatchObject({
        snowCoverage: 0.18,
        snowDepthM: 0.015,
        snowCompaction: 0.85,
      });
  });

  it("updates the live renderer only for relevant environment changes and restores it", () => {
    const document = new FakeEditorDocument(environment("light_rain", "noon"));
    const { viewer, setWeatherAppearance } = fakeViewer();
    const view = render(
      <EditorSceneEnvironmentBridge
        active
        document={document as unknown as EditorDocument}
        quality="high"
        viewer={viewer}
        actorRenderer={null}
      />,
    );

    expect(setWeatherAppearance).toHaveBeenCalledTimes(1);
    expect(setWeatherAppearance).toHaveBeenLastCalledWith(expect.objectContaining({
      precipitation: expect.objectContaining({ budget: "high", kind: "rain" }),
      surface: expect.objectContaining({ wetness: 0.62 }),
    }));

    act(() => document.setEnvironment({
      ...environment("light_rain", "noon"),
      frictionScale: 0.8,
    }));
    expect(setWeatherAppearance).toHaveBeenCalledTimes(1);

    act(() => document.setEnvironment(withEditorWeatherControls(
      document.data.environment,
      { wind: "strong" },
    )));
    expect(setWeatherAppearance).toHaveBeenCalledWith(null);
    expect(setWeatherAppearance).toHaveBeenLastCalledWith(expect.objectContaining({
      precipitation: expect.objectContaining({ wind: 0.9 }),
    }));

    act(() => document.setEnvironment(environment("clear", "noon")));
    expect(setWeatherAppearance).toHaveBeenLastCalledWith(expect.objectContaining({
      precipitation: null,
      surface: {
        snowCoverage: 0,
        snowDepthM: 0,
        snowCompaction: 0,
        wetness: 0,
      },
    }));

    view.unmount();
    expect(setWeatherAppearance).toHaveBeenLastCalledWith(null);
  });

  it("applies and restores practical map and vehicle lighting together", () => {
    const document = new FakeEditorDocument(environment("clear", "night_lit"));
    const { viewer, setStreetLightsEnabled } = fakeViewer();
    const setHeadlightsEnabled = vi.fn<(enabled: boolean) => void>();
    const actorRenderer = { setHeadlightsEnabled } as unknown as ActorRenderer;
    const view = render(
      <EditorSceneEnvironmentBridge
        active
        actorRenderer={actorRenderer}
        document={document as unknown as EditorDocument}
        quality="high"
        viewer={viewer}
      />,
    );

    expect(setStreetLightsEnabled).toHaveBeenCalledWith(true);
    expect(setHeadlightsEnabled).toHaveBeenCalledWith(true);
    view.unmount();
    expect(setStreetLightsEnabled).toHaveBeenLastCalledWith(false);
    expect(setHeadlightsEnabled).toHaveBeenLastCalledWith(false);
  });


  it("keeps precipitation out of low graphics previews", () => {
    const document = new FakeEditorDocument(environment("snow", "dusk"));
    const low = fakeViewer();
    const view = render(
      <EditorSceneEnvironmentBridge
        active
        document={document as unknown as EditorDocument}
        quality="ultra-low-3d"
        viewer={low.viewer}
        actorRenderer={null}
      />,
    );
    expect(low.setWeatherAppearance).toHaveBeenCalledWith(expect.objectContaining({
      clouds: expect.objectContaining({ budget: "off" }),
      precipitation: expect.objectContaining({ budget: "off" }),
    }));
    view.unmount();
  });

  it("retains physical snow surface values when reduced motion disables particles", () => {
    const { viewer, setWeatherAppearance } = fakeViewer();

    const restore = applyEditorSceneEnvironment(
      viewer,
      withEditorWeatherControls(environment("snow", "dusk"), { snowCover: "covered" }),
      { quality: "high", reducedMotion: true },
    );

    expect(setWeatherAppearance).toHaveBeenCalledWith(expect.objectContaining({
      clouds: expect.objectContaining({ budget: "off" }),
      precipitation: expect.objectContaining({ budget: "off" }),
      surface: expect.objectContaining({
        snowDepthM: 0.075,
        snowCompaction: 0.4,
      }),
    }));
    restore();
  });
});

class FakeEditorDocument {
  readonly listeners = new Set<() => void>();
  data: { environment: Environment };
  revision = 0;

  constructor(initialEnvironment: Environment) {
    this.data = { environment: initialEnvironment };
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setEnvironment(next: Environment) {
    this.data.environment = next;
    this.revision += 1;
    for (const listener of this.listeners) listener();
  }
}

function environment(
  weather: Environment["weather"],
  timeOfDay: Environment["timeOfDay"],
): Environment {
  return { weather, timeOfDay } as Environment;
}

function fakeViewer(): {
  viewer: CityViewer;
  setStreetLightsEnabled: Mock<(enabled: boolean) => void>;
  setWeatherAppearance: Mock<(appearance: CityWeatherAppearance | null) => void>;
  setWeatherTimeSeconds: Mock<(timeSeconds: number | null) => void>;
} {
  const setStreetLightsEnabled = vi.fn<(enabled: boolean) => void>();
  const setWeatherAppearance = vi.fn<(appearance: CityWeatherAppearance | null) => void>();
  const setWeatherTimeSeconds = vi.fn<(timeSeconds: number | null) => void>();
  return {
    viewer: {
      setStreetLightsEnabled,
      setWeatherAppearance,
      setWeatherTimeSeconds,
    } as unknown as CityViewer,
    setStreetLightsEnabled,
    setWeatherAppearance,
    setWeatherTimeSeconds,
  };
}
