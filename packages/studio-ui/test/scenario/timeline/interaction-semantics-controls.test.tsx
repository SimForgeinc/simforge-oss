/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Interaction } from "@simforge-oss/scenario";
import {
  drivingStyleForInteraction,
  InteractionSemanticsControls,
  withDrivingStylePreset,
  withNumericActionSemantic,
} from "../../../src/scenario/editor/timeline/InteractionSemanticsControls";
import type { EditorDocument } from "@simforge-oss/editor";

afterEach(cleanup);

function renderControls(interaction: Interaction) {
  const replaceInteraction = vi.fn();
  render(
    <InteractionSemanticsControls
      document={{
        data: { roles: [{ id: "ego" }, { id: "aggressor" }] },
        replaceInteraction,
      } as unknown as EditorDocument}
      interaction={interaction}
    />,
  );
  return replaceInteraction;
}

describe("InteractionSemanticsControls", () => {
  it("visibly configures an absolute speed and a plain-language driving style", () => {
    const interaction = {
      id: "speed-1",
      actor: "ego",
      trigger: { kind: "at", t: 0 },
      verb: "speed",
      target: { mode: "absolute", valueKph: 48 },
      dynamics: { shape: "linear", constraint: "time", value: 1 },
      until: { kind: "at", t: 1 },
    } as Interaction;
    const replace = renderControls(interaction);
    fireEvent.change(screen.getByLabelText("Target speed (kph)"), { target: { value: "12" } });
    expect(replace).toHaveBeenLastCalledWith("speed-1", expect.objectContaining({
      target: { mode: "absolute", valueKph: 12 },
    }));
    expect(screen.getByRole("radio", { name: /normal.*balanced everyday driving/i }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: /cautious.*slower and smoother/i }));
    expect(replace).toHaveBeenLastCalledWith("speed-1", expect.objectContaining({
      dynamics: { shape: "cubic", constraint: "time", value: 2.5 },
      until: { kind: "at", t: 2.5 },
    }));
    expect(screen.queryByLabelText(/dynamics duration/i)).toBeNull();
  });

  it("maps aggressive lane changes to canonical assertive intent and keeps timing coupled", () => {
    const interaction = {
      id: "lane-1",
      actor: "aggressor",
      trigger: { kind: "at", t: 4 },
      verb: "changeLane",
      target: { mode: "relative", dk: -1 },
      dynamics: { shape: "sinusoidal", constraint: "time", value: 2 },
      maneuverDurationS: 2,
    } as Interaction;
    const replace = renderControls(interaction);
    fireEvent.click(screen.getByRole("radio", { name: /aggressive.*quick and decisive/i }));
    expect(replace).toHaveBeenLastCalledWith("lane-1", expect.objectContaining({
      dynamics: { shape: "linear", constraint: "time", value: 1 },
      maneuverDurationS: 1,
      maneuverStyle: "assertive",
    }));
  });

  it("recognizes canonical lane style intent and normal default dynamics", () => {
    const normalSpeed = {
      id: "speed-1",
      actor: "ego",
      trigger: { kind: "at", t: 0 },
      verb: "speed",
      target: { mode: "absolute", valueKph: 48 },
      dynamics: { shape: "linear", constraint: "time", value: 1 },
    } as Interaction;
    expect(drivingStyleForInteraction(normalSpeed)).toBe("normal");

    const assertiveLane = {
      ...normalSpeed,
      verb: "changeLane",
      target: { mode: "relative", dk: 1 },
      maneuverStyle: "assertive",
    } as Interaction;
    expect(drivingStyleForInteraction(assertiveLane)).toBe("aggressive");
  });

  it("applies presets to legacy actions without time-based dynamics", () => {
    const interaction = {
      id: "speed-1",
      actor: "ego",
      trigger: { kind: "at", t: 3 },
      verb: "speed",
      target: { mode: "absolute", valueKph: 48 },
      dynamics: { shape: "linear", constraint: "rate", value: 2 },
    } as Interaction;
    expect(withDrivingStylePreset(interaction, "normal")).toEqual(expect.objectContaining({
      target: { mode: "absolute", valueKph: 48 },
      dynamics: { shape: "linear", constraint: "time", value: 1 },
    }));
  });

  it("rejects empty, non-finite, out-of-range, fractional lane, and sub-grid duration values", () => {
    const speed = {
      id: "speed-1",
      actor: "ego",
      trigger: { kind: "at", t: 0 },
      verb: "speed",
      target: { mode: "absolute", valueKph: 48 },
      dynamics: { shape: "linear", constraint: "time", value: 1 },
    } as Interaction;
    expect(withNumericActionSemantic(speed, "targetSpeedKph", Number.NaN)).toBeNull();
    expect(withNumericActionSemantic(speed, "targetSpeedKph", -1)).toBeNull();
    expect(withNumericActionSemantic(speed, "targetSpeedKph", 131)).toBeNull();
    expect(withNumericActionSemantic(speed, "durationS", 0)).toBeNull();
    expect(withNumericActionSemantic(speed, "durationS", 0.01)).toBeNull();

    const lane = {
      ...speed,
      verb: "changeLane",
      target: { mode: "relative", dk: -1 },
    } as Interaction;
    expect(withNumericActionSemantic(lane, "laneDelta", 1.5)).toBeNull();
    expect(withNumericActionSemantic(lane, "laneDelta", 0)).toBeNull();
    expect(withNumericActionSemantic(lane, "laneDelta", 5)).toBeNull();
  });

  it("normalizes duration once and applies the same value to every coupled field", () => {
    const lane = {
      id: "lane-1",
      actor: "aggressor",
      trigger: { kind: "at", t: 4 },
      until: { kind: "at", t: 6 },
      verb: "changeLane",
      target: { mode: "relative", dk: -1 },
      dynamics: { shape: "sinusoidal", constraint: "time", value: 2 },
      maneuverDurationS: 2,
    } as Interaction;
    const normalized = withNumericActionSemantic(lane, "durationS", 0.12345);
    expect(normalized).toEqual(expect.objectContaining({
      dynamics: expect.objectContaining({ value: 0.123 }),
      maneuverDurationS: 0.123,
      until: { kind: "at", t: 4.123 },
    }));
    expect(normalized && normalized.until?.kind === "at" && typeof normalized.until.t === "number"
      ? normalized.until.t - 4
      : Number.NaN).toBeCloseTo(0.123, 12);
  });

  it("surfaces invalid empty input without persisting it", () => {
    const interaction = {
      id: "speed-1",
      actor: "ego",
      trigger: { kind: "at", t: 0 },
      verb: "speed",
      target: { mode: "absolute", valueKph: 48 },
      dynamics: { shape: "linear", constraint: "time", value: 1 },
    } as Interaction;
    const replace = renderControls(interaction);
    fireEvent.change(screen.getByLabelText("Target speed (kph)"), { target: { value: "" } });
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/outside the supported authoring range/i);
  });
});
