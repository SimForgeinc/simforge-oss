// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TrafficActorDetailsPanel } from "../../../../src/scenario/editor/inspector/TrafficActorDetailsPanel";
import { trafficActorSelection } from "../../../../src/scenario/editor/traffic-selection";
import { continuesPlayback } from "../../../../src/lib/scenario/playback/usePlayback";

afterEach(cleanup);

const actor = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind: "car",
  static: false,
  tags: [] as string[],
  catalogId: "vehicle.sedan",
  modelBasis: "kind-default",
  dims: { l: 4.5, w: 1.8, h: 1.5 },
  initial: { x: 0, z: 0, headingRad: 0 },
  ...extra,
});

const bundle = {
  actors: [
    actor("ego", { origin: "authored", tags: ["catalog:vehicle.sedan"] }),
    actor("ambient:3", { origin: "native-ambient", tags: ["ambient"] }),
    actor("sumo-0a1b2c3d", { origin: "sumo", tags: ["ambient", "catalog:vehicle.sedan", "sumo"], modelBasis: "input-tag" }),
    actor("ambient-world-seed", { kind: "static_object", static: true, tags: ["ambient:internal-clock"] }),
  ],
} as never;

describe("picking background traffic", () => {
  it("labels a replayed worker SUMO vehicle as SUMO traffic, with its playhead speed", () => {
    expect(trafficActorSelection("sumo-0a1b2c3d", bundle, [{ id: "sumo-0a1b2c3d", speedMps: 10, present: true }])).toEqual({
      id: "sumo-0a1b2c3d", source: "sumo-trace", kind: "car", catalogId: "vehicle.sedan", speedMps: 10,
    });
  });

  it("labels the live preview's SUMO vehicles and City-sim cars", () => {
    expect(trafficActorSelection("sumo:0a1b2c3d", null)?.source).toBe("sumo-preview");
    expect(trafficActorSelection("ambient:3", bundle)?.source).toBe("native");
  });

  it("leaves authored actors and the blank world's clock to the normal path", () => {
    expect(trafficActorSelection("ego", bundle)).toBeNull();
    expect(trafficActorSelection("ambient-world-seed", bundle)).toBeNull();
    expect(trafficActorSelection("unknown", bundle)).toBeNull();
  });

  it("renders a read-only card that says it is traffic", () => {
    const onClose = vi.fn();
    render(
      <TrafficActorDetailsPanel
        actor={{ id: "sumo-0a1b2c3d", source: "sumo-trace", kind: "car", catalogId: "vehicle.sedan", speedMps: 10 }}
        onClose={onClose}
      />,
    );
    expect(screen.getByTestId("traffic-actor-source").textContent).toBe("SUMO traffic");
    expect(screen.getByTestId("traffic-actor-read-only").textContent).toContain("Read-only traffic");
    expect(screen.getByText("36 km/h")).not.toBeNull();
    // No delete/edit affordances: the only control is Close.
    expect(screen.getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["Close details"]);
  });
});

describe("swapping in the authoritative trace", () => {
  const local = { instance: { manifest: { inputHash: "same" } } } as never;
  const authoritative = { instance: { manifest: { inputHash: "same" } } } as never;
  const edited = { instance: { manifest: { inputHash: "different" } } } as never;

  it("continues the playhead when a new bundle replays the same input", () => {
    expect(continuesPlayback({ bundle: local, inputHash: "same" }, authoritative)).toBe(true);
  });

  it("restarts for an edit, and never for a rebuild of the same bundle", () => {
    expect(continuesPlayback({ bundle: local, inputHash: "same" }, edited)).toBe(false);
    expect(continuesPlayback({ bundle: local, inputHash: "same" }, local)).toBe(false);
  });
});
