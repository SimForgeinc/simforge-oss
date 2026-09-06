/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  DYNAMICS_DEFAULTS,
  INTERACTION_PALETTE,
  TRIGGER_DEFAULTS,
  requiresDynamics,
  type EditorDocument,
  type SetTargetVariant,
} from "@simforge-oss/editor";
import {
  InteractionSchema,
  type ActorClass,
  type Interaction,
} from "@simforge-oss/scenario";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CanonicalInteractionComposer,
  canonicalPaletteInteraction,
  canonicalPaletteUnavailableReason,
  canonicalVariantsForRole,
} from "../../../src/scenario/editor/timeline/CanonicalInteractionComposer";

type Role = EditorDocument["data"]["roles"][number];

function role(id: string, actorClass: ActorClass): Role {
  return {
    id,
    kind: "on_reference",
    actor: { class: actorClass, catalogId: "vehicle.sedan", sensors: [] },
  } as unknown as Role;
}

const ego = role("ego", "car");
const peer = role("peer", "car");
const priorInteraction: Interaction = {
  id: "interaction_0",
  actor: "peer",
  trigger: { kind: "at", t: 0 },
  verb: "exist",
  target: { state: "present" },
};

afterEach(cleanup);

function roleForVariant(variant: (typeof INTERACTION_PALETTE)[number]): Role {
  const appliesTo = variant.verb === "set"
    ? (variant as SetTargetVariant).declaration.appliesTo
    : "vehicle";
  return role(appliesTo === "vru" ? "walker" : "ego", appliesTo === "vru" ? "pedestrian" : "car");
}

describe("canonical interaction catalog reachability", () => {
  it("builds every target × trigger × required-dynamics combination as a schema-valid interaction", () => {
    const built = new Set<string>();

    for (const variant of INTERACTION_PALETTE) {
      const triggerKinds = Object.keys(TRIGGER_DEFAULTS) as Array<keyof typeof TRIGGER_DEFAULTS>;
      const dynamics = requiresDynamics(variant.verb)
        ? DYNAMICS_DEFAULTS
        : [DYNAMICS_DEFAULTS[0]!];
      for (const triggerKind of triggerKinds) {
        for (const dynamic of dynamics) {
          const interaction = canonicalPaletteInteraction({
            variant,
            role: roleForVariant(variant),
            otherRole: peer,
            interactions: triggerKind === "after" ? [priorInteraction] : [],
            time: 3.24,
            triggerKind,
            dynamics: dynamic,
          });
          const result = InteractionSchema.safeParse(interaction);
          expect(result.success, `${variant.id}/${triggerKind}/${dynamic.shape}/${dynamic.constraint}`).toBe(true);
          built.add(`${variant.id}/${triggerKind}/${requiresDynamics(variant.verb) ? `${dynamic.shape}/${dynamic.constraint}` : "discrete"}`);
        }
      }
    }

    const expected = INTERACTION_PALETTE.reduce(
      (count, variant) => count + Object.keys(TRIGGER_DEFAULTS).length * (
        requiresDynamics(variant.verb) ? DYNAMICS_DEFAULTS.length : 1
      ),
      0,
    );
    expect(built.size).toBe(expected);
    expect(new Set(
      INTERACTION_PALETTE
        .filter((variant) => variant.verb === "set")
        .map((variant) => variant.target.key),
    ).size).toBe(INTERACTION_PALETTE.filter((variant) => variant.verb === "set").length);
  });

  it("fails closed instead of turning missing peer and event references into self references", () => {
    const gap = INTERACTION_PALETTE.find((variant) => variant.id === "gap.time")!;
    expect(canonicalPaletteUnavailableReason({
      variant: gap,
      triggerKind: "at",
      otherRole: null,
      interactions: [],
    })).toMatch(/another actor/i);
    expect(canonicalPaletteUnavailableReason({
      variant: INTERACTION_PALETTE[0]!,
      triggerKind: "after",
      otherRole: peer,
      interactions: [],
    })).toMatch(/earlier interaction/i);
    expect(() => canonicalPaletteInteraction({
      variant: gap,
      role: ego,
      otherRole: null,
      interactions: [],
      time: 1,
      triggerKind: "at",
      dynamics: DYNAMICS_DEFAULTS[0]!,
    })).toThrow(/another actor/i);
  });

  it("keeps every world key visible while filtering actor-only keys by actor class", () => {
    const car = canonicalVariantsForRole("car");
    const pedestrian = canonicalVariantsForRole("pedestrian");
    const worldKeys = INTERACTION_PALETTE.filter(
      (variant) => variant.verb === "set" && (variant as SetTargetVariant).actor === "@world",
    );

    for (const variant of worldKeys) {
      expect(car).toContain(variant);
      expect(pedestrian).toContain(variant);
    }
    expect(car.some((variant) => variant.verb === "set" && variant.target.key === "lights.headlights")).toBe(true);
    expect(pedestrian.some((variant) => variant.verb === "set" && variant.target.key === "lights.headlights")).toBe(false);
    expect(pedestrian.some((variant) => variant.verb === "set" && variant.target.key === "pose.gesture")).toBe(true);
  });
});

describe("CanonicalInteractionComposer", () => {
  function renderComposer() {
    const addInteraction = vi.fn();
    const document = { addInteraction } as unknown as EditorDocument;
    render(
      <CanonicalInteractionComposer
        document={document}
        interactions={[]}
        otherRole={peer}
        role={ego}
        time={4.26}
      />,
    );
    return addInteraction;
  }

  it("renders the package catalogs rather than a copied quick-action subset", () => {
    renderComposer();
    expect(screen.getByLabelText("Canonical interaction target").querySelectorAll("option")).toHaveLength(
      canonicalVariantsForRole("car").length,
    );
    expect(screen.getByLabelText("Canonical interaction trigger").querySelectorAll("option")).toHaveLength(
      Object.keys(TRIGGER_DEFAULTS).length,
    );
    expect(screen.getByLabelText("Canonical interaction dynamics").querySelectorAll("option")).toHaveLength(
      DYNAMICS_DEFAULTS.length,
    );
  });

  it("authors a selected target, trigger, and dynamics tuple", () => {
    const addInteraction = renderComposer();
    fireEvent.change(screen.getByLabelText("Canonical interaction target"), {
      target: { value: "speed.factor" },
    });
    fireEvent.change(screen.getByLabelText("Canonical interaction trigger"), {
      target: { value: "arrival" },
    });
    fireEvent.change(screen.getByLabelText("Canonical interaction dynamics"), {
      target: { value: String(DYNAMICS_DEFAULTS.length - 1) },
    });
    fireEvent.click(screen.getByTestId("canonical-interaction-add"));

    expect(addInteraction).toHaveBeenCalledWith(expect.objectContaining({
      actor: "ego",
      verb: "speed",
      target: { mode: "factor", factor: 1.1 },
      trigger: expect.objectContaining({ kind: "arrival", of: "ego", syncWith: "peer" }),
      dynamics: DYNAMICS_DEFAULTS.at(-1),
    }));
  });

  it("routes world set keys to the world lane with their canonical concrete key", () => {
    const addInteraction = renderComposer();
    const weather = INTERACTION_PALETTE.find(
      (variant) => variant.verb === "set" && variant.target.key === "env.weather",
    );
    expect(weather).toBeDefined();
    fireEvent.change(screen.getByLabelText("Canonical interaction target"), {
      target: { value: weather!.id },
    });
    fireEvent.click(screen.getByTestId("canonical-interaction-add"));

    expect(addInteraction).toHaveBeenCalledWith(expect.objectContaining({
      actor: "@world",
      verb: "set",
      target: expect.objectContaining({ key: "env.weather" }),
    }));
  });

  it("disables incomplete peer- and event-dependent drafts with an actionable prerequisite", () => {
    const addInteraction = vi.fn();
    render(
      <CanonicalInteractionComposer
        document={{ addInteraction } as unknown as EditorDocument}
        interactions={[]}
        otherRole={null}
        role={ego}
        time={2}
      />,
    );
    fireEvent.change(screen.getByLabelText("Canonical interaction target"), {
      target: { value: "gap.time" },
    });
    const add = screen.getByTestId("canonical-interaction-add") as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(screen.getByText(/add another actor/i)).not.toBeNull();
    fireEvent.click(add);
    expect(addInteraction).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Canonical interaction target"), {
      target: { value: "speed.absolute" },
    });
    fireEvent.change(screen.getByLabelText("Canonical interaction trigger"), {
      target: { value: "after" },
    });
    expect(add.disabled).toBe(true);
    expect(screen.getByText(/add an earlier interaction/i)).not.toBeNull();
  });
});
