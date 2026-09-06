// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InteractionSchema, type Interaction } from "@simforge-oss/scenario";
import { InteractionTargetControls } from "../../../src/scenario/editor/timeline/InteractionTargetControls";
import type { EditorDocument } from "@simforge-oss/editor";

afterEach(cleanup);

function renderTarget(interaction: Interaction) {
  const replaceInteraction = vi.fn();
  render(
    <InteractionTargetControls
      document={{
        data: {
          roles: [
            { id: "ego", label: "Ego" },
            { id: "challenger", label: "Challenger" },
          ],
          choreography: {
            clipSeconds: 10,
            warmupSeconds: 0,
            interactions: [interaction],
          },
        },
        replaceInteraction,
        removeInteraction: vi.fn(),
        addInteraction: vi.fn(),
      } as unknown as EditorDocument}
      interaction={interaction}
    />,
  );
  return replaceInteraction;
}

describe("InteractionTargetControls", () => {
  it("makes one quick-action target speed exact without changing its timeline semantics", () => {
    const interaction: Interaction = {
      id: "target_speed_ego_1",
      actor: "ego",
      trigger: { kind: "at", t: 3 },
      until: { kind: "at", t: 4 },
      verb: "speed",
      target: { mode: "absolute", valueKph: 48 },
      dynamics: { shape: "linear", constraint: "time", value: 1 },
    };
    const replace = renderTarget(interaction);

    fireEvent.change(screen.getByLabelText("Target speed (kph)"), {
      target: { value: "17.5" },
    });

    expect(replace).toHaveBeenCalledWith(
      interaction.id,
      expect.objectContaining({
        id: interaction.id,
        trigger: interaction.trigger,
        until: interaction.until,
        dynamics: interaction.dynamics,
        target: { mode: "absolute", valueKph: 17.5 },
      }),
    );
  });

  it("edits a typed set value with the registry-backed enum choices", () => {
    const interaction: Interaction = {
      id: "signal_red",
      actor: "@world",
      trigger: { kind: "at", t: 8 },
      verb: "set",
      target: { key: "signal:yale-main.phase", value: "red" },
    };
    const replace = renderTarget(interaction);

    fireEvent.pointerDown(screen.getByLabelText("Target value"), { button: 0 });
    fireEvent.click(screen.getByRole("menuitemradio", { name: "green" }));
    expect(replace).toHaveBeenCalledWith(
      interaction.id,
      expect.objectContaining({
        target: { key: "signal:yale-main.phase", value: "green" },
      }),
    );
  });

  it("switches through every canonical speed and lane target mode", () => {
    const speedModes = [
      ["absolute", "Absolute"],
      ["delta", "Delta"],
      ["factor", "Factor"],
      ["match", "Match"],
      ["stop", "Stop"],
      ["resume", "Resume"],
    ] as const;
    for (const [mode, label] of speedModes) {
      const speed: Interaction = {
        id: `speed_${mode}`,
        actor: "ego",
        trigger: { kind: "at", t: 1 },
        verb: "speed",
        target: mode === "absolute"
          ? { mode: "stop" }
          : { mode: "absolute", valueKph: 30 },
        dynamics: { shape: "linear", constraint: "time", value: 1 },
      };
      const replace = renderTarget(speed);
      fireEvent.pointerDown(screen.getByLabelText("Speed target mode"), { button: 0 });
      fireEvent.click(screen.getByRole("menuitemradio", { name: label }));
      const replacement = replace.mock.calls.at(-1)?.[1];
      expect(replacement).toEqual(expect.objectContaining({
        target: expect.objectContaining({ mode }),
      }));
      expect(InteractionSchema.safeParse(replacement).success).toBe(true);
      cleanup();
    }

    const laneModes = [
      ["relative", "Relative"],
      ["absolute", "Absolute"],
      ["toRole", "To Role"],
    ] as const;
    for (const [mode, label] of laneModes) {
      const lane: Interaction = {
        id: `lane_${mode}`,
        actor: "ego",
        trigger: { kind: "at", t: 1 },
        verb: "changeLane",
        target: mode === "relative"
          ? { mode: "absolute", k: 0 }
          : { mode: "relative", dk: 1 },
        dynamics: { shape: "sinusoidal", constraint: "time", value: 2 },
      };
      const replace = renderTarget(lane);
      fireEvent.pointerDown(screen.getByLabelText("Lane target mode"), { button: 0 });
      fireEvent.click(screen.getByRole("menuitemradio", { name: label }));
      const replacement = replace.mock.calls.at(-1)?.[1];
      expect(replacement).toEqual(expect.objectContaining({
        target: expect.objectContaining({ mode }),
      }));
      expect(InteractionSchema.safeParse(replacement).success).toBe(true);
      cleanup();
    }
  });

  it("authors gap, lane-offset, and existence semantics", () => {
    const gap: Interaction = {
      id: "gap_1",
      actor: "ego",
      trigger: { kind: "at", t: 1 },
      verb: "gap",
      target: { role: "challenger", value: 2, unit: "time" },
      dynamics: { shape: "linear", constraint: "time", value: 1 },
    };
    const replaceGap = renderTarget(gap);
    fireEvent.pointerDown(screen.getByLabelText("Gap unit"), { button: 0 });
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Distance (metres)" }));
    expect(replaceGap).toHaveBeenCalledWith(
      gap.id,
      expect.objectContaining({ target: { role: "challenger", value: 2, unit: "distance" } }),
    );
    cleanup();

    const offset: Interaction = {
      id: "offset_1",
      actor: "ego",
      trigger: { kind: "at", t: 1 },
      verb: "laneOffset",
      target: { tFrac: 0.25, reference: "lane_center" },
      dynamics: { shape: "linear", constraint: "time", value: 1 },
    };
    const replaceOffset = renderTarget(offset);
    fireEvent.pointerDown(screen.getByLabelText("Offset reference"), { button: 0 });
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Right lane edge" }));
    expect(replaceOffset).toHaveBeenCalledWith(
      offset.id,
      expect.objectContaining({ target: { tFrac: 0.25, reference: "lane_edge_right" } }),
    );
    cleanup();

    const existence: Interaction = {
      id: "exist_1",
      actor: "challenger",
      trigger: { kind: "at", t: 1 },
      verb: "exist",
      target: { state: "absent" },
    };
    const replaceExistence = renderTarget(existence);
    fireEvent.pointerDown(screen.getByLabelText("Existence state"), { button: 0 });
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Present" }));
    expect(replaceExistence).toHaveBeenCalledWith(
      existence.id,
      expect.objectContaining({ target: { state: "present" } }),
    );
  });

  it("switches among every schema-backed route target", () => {
    const routeModes = [
      ["turn", "Turn"],
      ["nextJunction", "Next Junction"],
      ["toFeature", "To Feature"],
      ["crossing", "Crossing"],
      ["polyline", "Polyline"],
      ["customRoute", "Custom Route"],
      ["customTimedRoute", "Custom Timed Route"],
      ["lanePath", "Lane Path"],
      ["acquire", "Acquire"],
      ["nearMiss", "Near Miss"],
    ] as const;
    for (const [mode, label] of routeModes) {
      const interaction: Interaction = {
        id: `route_${mode}`,
        actor: "ego",
        trigger: { kind: "at", t: 1 },
        verb: "route",
        target: mode === "nextJunction"
          ? { mode: "toFeature", feature: "starting_feature" }
          : { mode: "nextJunction", turn: "straight" },
      };
      const replace = renderTarget(interaction);
      fireEvent.pointerDown(screen.getByLabelText("Route target mode"), { button: 0 });
      fireEvent.click(screen.getByRole("menuitemradio", { name: label }));
      const replacement = replace.mock.calls.at(-1)?.[1];
      expect(replacement).toEqual(expect.objectContaining({
        target: expect.objectContaining({ mode }),
      }));
      expect(InteractionSchema.safeParse(replacement).success).toBe(true);
      cleanup();
    }
  });

  it("makes a custom timed route full-width when switching modes", () => {
    const interaction: Interaction = {
      id: "partial_route",
      actor: "ego",
      trigger: { kind: "at", t: 4 },
      until: { kind: "at", t: 7 },
      verb: "route",
      target: { mode: "customRoute", points: [{ x: 1, z: 2 }] },
    };
    const replace = renderTarget(interaction);

    fireEvent.pointerDown(screen.getByLabelText("Route target mode"), { button: 0 });
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Custom Timed Route" }));

    expect(replace).toHaveBeenCalledWith(interaction.id, expect.objectContaining({
      trigger: { kind: "at", t: 0 },
      until: { kind: "at", t: 10 },
      target: {
        mode: "customTimedRoute",
        points: [{ timeS: 0, x: 0, z: 0 }],
      },
    }));
  });

  it("renders a stale timed-route target with missing points without crashing", () => {
    const staleInteraction = {
      id: "stale_timed_route",
      actor: "ego",
      trigger: { kind: "at", t: 0 },
      until: { kind: "at", t: 10 },
      verb: "route",
      target: { mode: "customTimedRoute" },
    } as unknown as Interaction;

    expect(() => renderTarget(staleInteraction)).not.toThrow();
    expect(screen.getByRole("button", { name: "Add one-second point" })).not.toBeNull();
  });

  describe("a timed route's first point", () => {
    const timedRoute: Interaction = {
      id: "route_timed_ego",
      actor: "ego",
      trigger: { kind: "at", t: 0 },
      until: { kind: "at", t: 10 },
      verb: "route",
      target: {
        mode: "customTimedRoute",
        points: [
          { timeS: 0, x: 1, z: 2 },
          { timeS: 5, x: 20, z: 2 },
          { timeS: 10, x: 40, z: 2 },
        ],
      },
    };

    it("shows its coordinates read-only, because they are the actor's position", () => {
      renderTarget(timedRoute);

      // Visible, since reading where a route starts is useful; not editable, since the
      // simulation starts the actor from this point and the actor's pose owns it.
      for (const axis of ["x", "z"]) {
        const field = screen.getByTestId(`interaction-target-timed-${axis}-0-${timedRoute.id}`);
        expect(field.hasAttribute("readonly")).toBe(true);
      }
      expect(screen.getByText(/first point is the actor's position/i)).not.toBeNull();
    });

    it("cannot be removed, while later points still can be", () => {
      renderTarget(timedRoute);

      // Removing it would hand the start to a point that is not the actor, which is the
      // same reason the map tool refuses to drag it.
      expect(screen.queryByRole("button", { name: "Remove point 1" })).toBeNull();
      expect(screen.getByRole("button", { name: "Remove point 2" })).not.toBeNull();
    });

    it("leaves its own time editable, and later coordinates editable", () => {
      const replace = renderTarget(timedRoute);

      fireEvent.change(screen.getByTestId(`interaction-target-timed-x-1-${timedRoute.id}`), {
        target: { value: "25" },
      });

      expect(replace.mock.calls.at(-1)?.[1]).toEqual(expect.objectContaining({
        target: expect.objectContaining({
          points: [
            { timeS: 0, x: 1, z: 2 },
            { timeS: 5, x: 25, z: 2 },
            { timeS: 10, x: 40, z: 2 },
          ],
        }),
      }));
    });

    it("keeps an untimed custom route's first point editable", () => {
      const replace = renderTarget({
        id: "route_custom_ego",
        actor: "ego",
        trigger: { kind: "at", t: 0 },
        verb: "route",
        target: { mode: "customRoute", points: [{ x: 1, z: 2 }, { x: 20, z: 2 }] },
      } as Interaction);

      fireEvent.change(screen.getByTestId("interaction-target-custom-x-0-route_custom_ego"), {
        target: { value: "7" },
      });

      expect(replace.mock.calls.at(-1)?.[1]).toEqual(expect.objectContaining({
        target: expect.objectContaining({ points: [{ x: 7, z: 2 }, { x: 20, z: 2 }] }),
      }));
    });
  });
});
