// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { TimelineCarlaCompatibilityMarker } from "../../../../src/scenario/editor/timeline/TimelineCarlaCompatibilityMarker";
import type { CarlaCompatibility } from "../../../../src/lib/scenario/carla-compatibility";

const native: CarlaCompatibility = {
  status: "native",
  blueprintId: "vehicle.tesla.model3",
  dimensionalAgreement: "exact",
};
const generatedPack: CarlaCompatibility = {
  status: "generated-pack",
  reason: "needs a generated asset pack",
};
const browserOnly: CarlaCompatibility = {
  status: "browser-only",
  reason: "no CARLA runtime blueprint",
};

afterEach(cleanup);

describe("TimelineCarlaCompatibilityMarker", () => {
  it("marks a CARLA-ready actor with the CARLA logo", () => {
    render(<TimelineCarlaCompatibilityMarker actorLabel="Camera car" compatibility={native} />);

    const logo = screen.getByTestId("timeline-carla-ready-logo");
    expect(logo.tagName).toBe("IMG");
    // Not `/editor/...`: proxy.ts claims that prefix, so it 404s as a static file.
    expect(logo.getAttribute("src")).toBe("/scenario-editor/carla-mark.png");
    // The logo carries the meaning, so the wrapper holds the accessible name.
    expect(screen.getByRole("img", { name: "Camera car: CARLA ready" })).toBeTruthy();
    expect(logo.getAttribute("aria-hidden")).toBe("true");
  });

  it("exposes the blueprint that makes the actor CARLA ready", () => {
    render(<TimelineCarlaCompatibilityMarker actorLabel="Camera car" compatibility={native} />);

    expect(screen.getByRole("img", { name: "Camera car: CARLA ready" }).getAttribute("title"))
      .toBe("CARLA ready: vehicle.tesla.model3");
  });

  it.each([
    ["generated-pack", generatedPack, "CARLA pack required"],
    ["browser-only", browserOnly, "Browser only"],
  ] as const)("shows no logo for a %s actor", (status, compatibility, label) => {
    const { container } = render(
      <TimelineCarlaCompatibilityMarker actorLabel="Bus" compatibility={compatibility} />,
    );

    expect(screen.queryByTestId("timeline-carla-ready-logo")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    const marker = screen.getByRole("img", { name: `Bus: ${label}` });
    expect(marker.getAttribute("data-carla-compatibility")).toBe(status);
  });
});
