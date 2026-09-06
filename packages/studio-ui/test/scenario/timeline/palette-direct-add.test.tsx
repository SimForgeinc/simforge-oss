/**
 * @vitest-environment jsdom
 *
 * The palette's `addDirect` path builds a `gap` or `exist` interaction inline rather than through
 * `interactionForAction`, so it independently enforces the zero-based recording window.
 */

import type { Interaction, ScenarioTemplateV2 } from "@simforge-oss/scenario";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ActionPalette } from "../../../src/scenario/editor/timeline/ActionPalette";
import type { EditorDocument } from "@simforge-oss/editor";

type Role = EditorDocument["data"]["roles"][number];

const asRole = (id: string) =>
  ({
    id,
    kind: "on_reference",
    actor: { class: "car", catalogId: "sedan.generic", sensors: [] },
  }) as unknown as Role;

/**
 * Render the palette at `time` and return the interactions its buttons produce.
 *
 * `cleanup()` first because several tests render more than once: without it each render stacks into the
 * same container and every `getByRole` finds N copies, which fails as "multiple elements" rather than as
 * anything to do with the behaviour under test.
 */
function paletteAt(time: number) {
  cleanup();
  const addInteraction = vi.fn();
  const data = {
    roles: [asRole("challenger"), asRole("lead")],
    choreography: { clipSeconds: 20, warmupSeconds: 5, interactions: [] as Interaction[] },
  } as unknown as ScenarioTemplateV2;
  const document = { data, addInteraction } as unknown as EditorDocument;

  render(
    <ActionPalette
      document={document}
      role={asRole("challenger")}
      otherRole={asRole("lead")}
      interactions={[]}
      time={time}
      onTimeChange={() => {}}
    />,
  );
  return addInteraction;
}

/** The literal seconds of an `at` trigger, or a loud failure. */
function atSeconds(trigger: unknown): number {
  const candidate = trigger as { kind?: string; t?: unknown } | undefined;
  if (candidate?.kind !== "at" || typeof candidate.t !== "number") {
    throw new Error(`expected a literal \`at\` trigger, got ${JSON.stringify(trigger)}`);
  }
  return candidate.t;
}

function clickAndRead(label: RegExp, time: number): Interaction {
  const addInteraction = paletteAt(time);
  screen.getByRole("button", { name: label }).click();
  expect(addInteraction).toHaveBeenCalledTimes(1);
  return addInteraction.mock.calls[0]?.[0] as Interaction;
}

describe("addDirect", () => {
  it("clamps legacy negative input to zero", () => {
    expect(atSeconds(clickAndRead(/follow gap/i, -3).trigger)).toBe(0);
  });

  it("keeps the authored duration after clamping", () => {
    const built = clickAndRead(/follow gap/i, -3);
    expect(atSeconds(built.until)).toBe(1);
    expect(atSeconds(built.until) - atSeconds(built.trigger)).toBe(1);
  });

  it("holds the duration constant on the recorded timeline", () => {
    for (const time of [0, 0.5, 5.5]) {
      const built = clickAndRead(/follow gap/i, time);
      expect(atSeconds(built.until) - atSeconds(built.trigger)).toBeCloseTo(1, 6);
      expect(atSeconds(built.trigger)).toBeCloseTo(time, 6);
    }
  });

  it("applies the same rule to `exist`", () => {
    const built = clickAndRead(/become absent/i, -2.5);
    expect(atSeconds(built.trigger)).toBe(0);
    expect(atSeconds(built.until)).toBe(1);
  });

  it("snaps an off-grid time onto the authoring grid", () => {
    expect(atSeconds(clickAndRead(/follow gap/i, 2.44).trigger)).toBe(2.4);
  });
});

describe("exact target speed quick action", () => {
  it("retains the generic default and lets the author set this occurrence before adding it", () => {
    const addInteraction = paletteAt(3);
    const input = screen.getByTestId("action-palette-target-speed") as HTMLInputElement;
    expect(input.value).toBe("48");
    fireEvent.change(input, { target: { value: "21" } });
    screen.getByTestId("action-palette-accelerate").click();

    expect(addInteraction).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: { kind: "at", t: 3 },
        target: { mode: "absolute", valueKph: 21 },
      }),
    );
  });
});

describe("canonical interaction composer", () => {
  it("is reachable from the visible sidebar palette", () => {
    paletteAt(3);
    expect(screen.getByTestId("action-palette-canonical-composer")).not.toBeNull();
    expect(screen.getByTestId("action-palette-canonical-target")).not.toBeNull();
    expect(screen.getByTestId("action-palette-canonical-trigger")).not.toBeNull();
    expect(screen.getByTestId("action-palette-canonical-dynamics")).not.toBeNull();
  });
});
