// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Environment } from "@simforge-oss/scenario";
import {
  WEATHER_APPEARANCE_EXTENSION_KEY,
  editorWeatherControlSignature,
  resolveEditorWeatherControls,
  withEditorWeatherControls,
} from "../../src/scenario/editor/weather-controls";
import { AddWeatherPanel } from "../../src/scenario/editor/regions/AddWeatherPanel";
import {
  SCENE_TIME_EXTENSION_KEY,
  sunAnglesForSceneMinutes,
} from "../../src/scenario/editor/scene-time";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Add weather panel", () => {
  it("changes weather through simple presets without exposing simulator tuning", () => {
    const data: { environment: Environment } = {
      environment: {
        weather: "clear",
        timeOfDay: "noon",
        frictionScale: 0.9,
        surfacePatches: [],
      },
    };
    const setEnvironment = vi.fn((next: Environment) => {
      data.environment = next;
    });
    const document = { data, setEnvironment };
    const view = render(<AddWeatherPanel document={document as never} />);

    expect(screen.getByTestId("add-weather-panel")).toBeTruthy();
    expect(screen.queryByText(/friction/i)).toBeNull();

    fireEvent.click(screen.getByTestId("weather-light_rain"));
    expect(setEnvironment).toHaveBeenCalledWith({
      weather: "light_rain",
      timeOfDay: "noon",
      frictionScale: 0.9,
      surfacePatches: [],
    });

    view.rerender(<AddWeatherPanel document={document as never} />);
    expect(screen.getByTestId("weather-light_rain").getAttribute("aria-pressed")).toBe("true");
  });

  it("offers every canonical weather choice and keeps the panel accessible", () => {
    const data: { environment: Environment } = {
      environment: { weather: "clear", timeOfDay: "noon", surfacePatches: [] },
    };
    const document = { data, setEnvironment: vi.fn() };
    render(<AddWeatherPanel document={document as never} />);


    expect(screen.getByTestId("weather-section-weather")).toBeTruthy();
    for (const label of [
      "clear",
      "cloudy",
      "overcast",
      "light_rain",
      "heavy_rain",
      "wet_road",
      "fog_light",
      "fog_dense",
      "snow",
      "sleet",
    ]) {
      expect(screen.getByTestId(`weather-${label}`)).toBeTruthy();
    }
    expect(screen.getByRole("slider", { name: "Scene time" })).toBeTruthy();
    expect(screen.queryByTestId("weather-section-wind")).toBeNull();
    expect(screen.queryByTestId("weather-section-snow")).toBeNull();
  });

  it("sets a precise scene time from the slider and offers the local computer time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 10, 11, 23));
    const data: { environment: Environment } = {
      environment: { weather: "clear", timeOfDay: "noon", surfacePatches: [] },
    };
    const setEnvironment = vi.fn((next: Environment) => {
      data.environment = next;
    });
    const document = { data, setEnvironment };
    const view = render(<AddWeatherPanel document={document as never} />);

    fireEvent.change(screen.getByRole("slider", { name: "Scene time" }), {
      target: { value: String(16 * 60 + 30) },
    });
    const sun = sunAnglesForSceneMinutes(16 * 60 + 30);

    expect(setEnvironment).toHaveBeenLastCalledWith(expect.objectContaining({
      timeOfDay: "afternoon",
      sunAzimuthDeg: sun.azimuthDeg,
      sunElevationDeg: sun.elevationDeg,
      extensions: {
        [SCENE_TIME_EXTENSION_KEY]: { minutes: 16 * 60 + 30 },
      },
    }));

    view.rerender(<AddWeatherPanel document={document as never} />);
    expect(screen.getByText("4:30 PM")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Now" }));
    expect(setEnvironment).toHaveBeenLastCalledWith(expect.objectContaining({
      timeOfDay: "noon",
      sunAzimuthDeg: 170.75,
      sunElevationDeg: 64.15,
      extensions: {
        [SCENE_TIME_EXTENSION_KEY]: { minutes: 11 * 60 + 23 },
      },
    }));
  });



  it("shows only the weather details that apply and persists visual choices", () => {
    const data: { environment: Environment } = {
      environment: {
        weather: "snow",
        timeOfDay: "night_lit",
        frictionScale: 0.8,
        surfacePatches: [],
      },
    };
    const setEnvironment = vi.fn((next: Environment) => {
      data.environment = next;
    });
    const document = { data, setEnvironment };
    const view = render(<AddWeatherPanel document={document as never} />);

    expect(screen.getByTestId("weather-wind-breezy").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("weather-snow-covered").getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByTestId("weather-wind-strong"));
    expect(setEnvironment).toHaveBeenLastCalledWith({
      weather: "snow",
      timeOfDay: "night_lit",
      frictionScale: 0.8,
      surfacePatches: [],
      extensions: {
        [WEATHER_APPEARANCE_EXTENSION_KEY]: { wind: "strong", snowCover: "covered" },
      },
    });

    view.rerender(<AddWeatherPanel document={document as never} />);
    fireEvent.click(screen.getByTestId("weather-snow-deep"));
    expect(setEnvironment).toHaveBeenLastCalledWith({
      weather: "snow",
      timeOfDay: "night_lit",
      frictionScale: 0.8,
      surfacePatches: [],
      extensions: {
        [WEATHER_APPEARANCE_EXTENSION_KEY]: { wind: "strong", snowCover: "deep" },
      },
    });
  });

  it("uses safe defaults for invalid values and retains unrelated fields and extensions", () => {
    const environment = {
      weather: "sleet",
      timeOfDay: "dusk",
      frictionScale: 0.7,
      surfacePatches: [],
      extensions: {
        "org.example.other": { keep: true },
        [WEATHER_APPEARANCE_EXTENSION_KEY]: { wind: "gale", snowCover: "deep", future: true },
      },
    } as Environment;

    expect(resolveEditorWeatherControls(environment)).toEqual({ wind: "breezy", snowCover: "deep" });
    expect(editorWeatherControlSignature(environment)).toBe("breezy:deep");
    expect(withEditorWeatherControls(environment, { wind: "calm" })).toEqual({
      weather: "sleet",
      timeOfDay: "dusk",
      frictionScale: 0.7,
      surfacePatches: [],
      extensions: {
        "org.example.other": { keep: true },
        [WEATHER_APPEARANCE_EXTENSION_KEY]: {
          wind: "calm",
          snowCover: "deep",
          future: true,
        },
      },
    });

    expect(resolveEditorWeatherControls({
      weather: "snow",
      timeOfDay: "noon",
      surfacePatches: [],
      extensions: { [WEATHER_APPEARANCE_EXTENSION_KEY]: "not an object" },
    })).toEqual({ wind: "breezy", snowCover: "covered" });
  });
});
