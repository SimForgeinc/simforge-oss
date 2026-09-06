// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActorRecord } from "@simforge-oss/editor";
import { ActorReactionEditor } from "../../../../src/scenario/editor/inspector/ActorReactionEditor";

vi.mock("../../../../src/scenario/editor/timeline/ActionPalette", () => ({
  ActionPalette: ({ role, interactions }: { role: { id: string } | null; interactions: unknown[] }) => <div data-testid="reaction-action-palette" data-role-id={role?.id} data-interaction-count={interactions.length} />,
}));
vi.mock("../../../../src/scenario/editor/timeline/InteractionList", () => ({
  InteractionList: ({ interactions }: { interactions: Array<{ actor: string }> }) => <div data-testid="reaction-interaction-list">{interactions.map((item) => item.actor).join(",")}</div>,
}));

afterEach(cleanup);

describe("ActorReactionEditor", () => {
  it("edits only the selected actor timeline interactions", () => {
    const actor = { id: "ego", kind: "vehicle" } as ActorRecord;
    const document = {
      data: {
        roles: [{ id: "ego", actor: {} }, { id: "peer", actor: {} }],
        choreography: {
          interactions: [
            { id: "ego-speed", actor: "ego" },
            { id: "peer-speed", actor: "peer" },
            { id: "ego-lane", actor: "ego" },
          ],
        },
      },
    };
    render(<ActorReactionEditor actor={actor} document={document as never} />);

    expect(screen.getByTestId("actor-reaction-editor").getAttribute("data-actor-id")).toBe("ego");
    expect(screen.queryByTestId("route-editor")).toBeNull();
    expect(screen.getByTestId("reaction-action-palette").getAttribute("data-role-id")).toBe("ego");
    expect(screen.getByTestId("reaction-action-palette").getAttribute("data-interaction-count")).toBe("2");
    expect(screen.getByTestId("reaction-interaction-list").textContent).toBe("ego,ego");
    expect(screen.queryByTestId("ambient-editor")).toBeNull();
  });
});
