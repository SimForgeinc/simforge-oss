// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AmbientEditor } from "../../../../src/scenario/editor/authoring/AmbientEditor";
import {
  ACCELERATED_SIGNAL_CYCLES_EXTENSION_KEY,
  AMBIENT_TRAFFIC_EXTENSION_KEY,
} from "@simforge-oss/playback/traffic";
import { AMBIENT_TRAFFIC_PROVIDER_EXTENSION_KEY } from "@simforge-oss/playback/traffic";

afterEach(cleanup);

function editorDocument(extensions: Readonly<Record<string, unknown>> = {}, simulation?: unknown) {
  return {
    data: { extensions, ...(simulation ? { simulation } : {}) },
    setAmbientTrafficExtension: vi.fn(),
    setAmbientTrafficExtensions: vi.fn(),
  };
}

describe("AmbientEditor", () => {
  it("keeps a scenario without a saved provider disabled by default", () => {
    const document = editorDocument();
    render(<AmbientEditor document={document as never} sumoAvailable />);

    expect((screen.getByTestId("ambient-traffic-provider") as HTMLSelectElement).value).toBe("off");
    expect(screen.getByTestId("ambient-traffic-off-status")).not.toBeNull();
    expect(screen.queryByTestId("ambient-traffic-accelerated-signal-cycles")).toBeNull();
    expect(document.setAmbientTrafficExtension).not.toHaveBeenCalled();
    expect(document.setAmbientTrafficExtensions).not.toHaveBeenCalled();
  });

  it("gives SUMO a City density in the same edit when a new document has none", () => {
    const document = editorDocument({}, { seed: "doc", dtS: 0.02 });
    render(<AmbientEditor document={document as never} sumoAvailable />);
    expect((screen.getByTestId("ambient-traffic-preset") as HTMLSelectElement).value).toBe("off");

    fireEvent.change(screen.getByTestId("ambient-traffic-provider"), { target: { value: "sumo" } });
    expect(document.setAmbientTrafficExtensions).toHaveBeenCalledTimes(1);
    expect(document.setAmbientTrafficExtensions).toHaveBeenCalledWith({
      [AMBIENT_TRAFFIC_PROVIDER_EXTENSION_KEY]: "sumo",
      [AMBIENT_TRAFFIC_EXTENSION_KEY]: expect.objectContaining({ preset: "city", seed: "ambient-1" }),
    });
  });

  it("writes SimForge's canonical provider, profile, and signal-cycle extensions", () => {
    const document = editorDocument({
      [AMBIENT_TRAFFIC_PROVIDER_EXTENSION_KEY]: "sumo",
    });
    render(<AmbientEditor document={document as never} sumoAvailable />);

    fireEvent.change(screen.getByTestId("ambient-traffic-provider"), {
      target: { value: "native" },
    });
    // A pre-pinning document already runs City traffic: only the source changes.
    expect(document.setAmbientTrafficExtensions).toHaveBeenCalledWith({
      [AMBIENT_TRAFFIC_PROVIDER_EXTENSION_KEY]: "native",
    });

    fireEvent.change(screen.getByTestId("ambient-traffic-preset"), {
      target: { value: "heavy" },
    });
    expect(document.setAmbientTrafficExtension).toHaveBeenCalledWith(
      AMBIENT_TRAFFIC_EXTENSION_KEY,
      expect.objectContaining({ preset: "heavy" }),
    );

    fireEvent.click(screen.getByTestId("ambient-traffic-accelerated-signal-cycles"));
    expect(document.setAmbientTrafficExtension).toHaveBeenCalledWith(
      ACCELERATED_SIGNAL_CYCLES_EXTENSION_KEY,
      true,
    );
  });

  it("shows live SUMO status and disables SUMO for maps without a network", () => {
    const document = editorDocument({
      [AMBIENT_TRAFFIC_PROVIDER_EXTENSION_KEY]: "sumo",
    });
    render(
      <AmbientEditor
        document={document as never}
        sumoAvailable={false}
        sumoStatus={{ phase: "fallback", actorCount: 0, reason: "network unavailable" }}
      />,
    );

    const option = screen
      .getAllByRole("option")
      .find((candidate) => candidate.getAttribute("value") === "sumo") as HTMLOptionElement;
    expect(option.disabled).toBe(true);
    expect(screen.getByTestId("sumo-unavailable").textContent).toContain("no immutable SUMO network");
    expect(screen.getByTestId("sumo-traffic-status").textContent).toContain("network unavailable");
  });
});
