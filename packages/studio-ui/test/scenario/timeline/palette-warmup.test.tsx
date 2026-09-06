/** The action palette exposes the same zero-based window as the timeline rail. */

import type { Interaction, ScenarioTemplateV2 } from "@simforge-oss/scenario";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ActionPalette } from "../../../src/scenario/editor/timeline/ActionPalette";
import type { EditorDocument } from "@simforge-oss/editor";

type Role = EditorDocument["data"]["roles"][number];

const role = {
  id: "challenger",
  kind: "on_reference",
  actor: { class: "car", catalogId: "sedan.generic", sensors: [] },
} as unknown as Role;

function fakeDocument(over: { warmupSeconds?: number; clipSeconds?: number } = {}) {
  const addInteraction = vi.fn();
  const data = {
    roles: [role],
    choreography: {
      clipSeconds: over.clipSeconds ?? 20,
      warmupSeconds: over.warmupSeconds ?? 5,
      interactions: [] as Interaction[],
    },
  } as unknown as ScenarioTemplateV2;
  return { addInteraction, document: { data, addInteraction } as unknown as EditorDocument };
}

function render(time: number, over?: { warmupSeconds?: number; clipSeconds?: number }) {
  const { document } = fakeDocument(over);
  return renderToStaticMarkup(
    <ActionPalette
      document={document}
      role={role}
      otherRole={null}
      interactions={[]}
      time={time}
      onTimeChange={() => {}}
    />,
  );
}

describe("ActionPalette time input", () => {
  it("starts at the recorded origin", () => {
    expect(render(1)).toMatch(/min="0"/);
  });

  it("ends at the visible clip boundary", () => {
    expect(render(1)).toMatch(/max="20"/);
  });

  it("describes the single visible range", () => {
    expect(render(1)).toMatch(/Choose a time from 0 to 20 seconds/);
  });

  it("uses clip length independently of any legacy warm-up value", () => {
    expect(render(1, { warmupSeconds: 5, clipSeconds: 12 })).toMatch(/0 to 12 seconds/);
  });

  it("points aria-describedby at an element that exists", () => {
    // A dangling `aria-describedby` is its own defect: assistive tech announces nothing and no error
    // is raised anywhere.
    const markup = render(1);
    const described = /aria-describedby="([^"]+)"/.exec(markup);
    expect(described).not.toBeNull();
    const id = described?.[1];
    expect(id).toBeTruthy();
    expect(markup).toContain(`id="${id}"`);
  });

  it("does not advertise warm-up authoring", () => {
    expect(render(1)).not.toMatch(/warm-up|warmup/i);
  });
});
