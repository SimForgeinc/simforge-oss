// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AtTriggerSchema } from "@simforge-oss/scenario";
import { ActionPalette } from "../../src/scenario/editor/timeline/ActionPalette";
import type { EditorDocument } from "@simforge-oss/editor";

afterEach(cleanup);

const ROLE = {
  id: "role_ego",
  actor: { class: "car", dims: { length: 4.7, width: 1.82, height: 1.45 }, sensors: [] },
};
const OTHER = {
  id: "role_npc",
  actor: { class: "car", dims: { length: 4.7, width: 1.82, height: 1.45 }, sensors: [] },
};

function makeDocument() {
  const addInteraction = vi.fn();
  const document = {
    data: { roles: [ROLE, OTHER], choreography: { clipSeconds: 20, warmupSeconds: 0, interactions: [] } },
    addInteraction,
  } as unknown as EditorDocument;
  return { document, addInteraction };
}

function renderPalette(time: number) {
  const { document, addInteraction } = makeDocument();
  const onTimeChange = vi.fn();
  render(
    <ActionPalette
      document={document}
      role={ROLE as never}
      otherRole={OTHER as never}
      interactions={[]}
      time={time}
      onTimeChange={onTimeChange}
    />,
  );
  return { addInteraction, onTimeChange };
}

describe("recorded timeline authoring", () => {
  it("floors legacy negative input to the visible t=0 origin", () => {
    const { addInteraction } = renderPalette(-1.5);

    fireEvent.click(screen.getByRole("button", { name: "Become absent" }));

    expect(addInteraction).toHaveBeenCalledTimes(1);
    const created = addInteraction.mock.calls[0]?.[0] as {
      trigger: { kind: string; t: number };
      until: { kind: string; t: number };
    };
    expect(created.trigger).toEqual({ kind: "at", t: 0 });
    expect(created.until.t).toBe(1);
  });

  it("produces schema-valid triggers after clamping legacy input", () => {
    const { addInteraction } = renderPalette(-3);
    fireEvent.click(screen.getByRole("button", { name: "Follow gap" }));

    const created = addInteraction.mock.calls[0]?.[0] as {
      trigger: unknown;
      until: unknown;
    };
    expect(AtTriggerSchema.safeParse(created.trigger).success).toBe(true);
    expect(AtTriggerSchema.safeParse(created.until).success).toBe(true);
  });

  it("constrains the time field to the visible clip", () => {
    renderPalette(0);
    const field = screen.getByLabelText("Add action at time") as HTMLInputElement;
    expect(field.min).toBe("0");
    expect(field.max).toBe("20");
  });

  it("still places a positive time unchanged", () => {
    const { addInteraction } = renderPalette(4);
    fireEvent.click(screen.getByRole("button", { name: "Become absent" }));

    const created = addInteraction.mock.calls[0]?.[0] as {
      trigger: { t: number };
      until: { t: number };
    };
    expect(created.trigger.t).toBe(4);
    expect(created.until.t).toBe(5);
  });
});
