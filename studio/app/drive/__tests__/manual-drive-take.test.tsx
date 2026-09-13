// @vitest-environment jsdom
import { act, useEffect, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ManualDriveTakeBoundary } from "@simforge-oss/studio-ui/scenario/editor/manual-drive/take-handoff";
import { useManualDriveTakeSession } from "@simforge-oss/studio-ui/scenario/editor/manual-drive/take-handoff";

function render(ui: ReactElement): { rerender: (next: ReactElement) => void } {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(ui));
  return { rerender: (next) => act(() => root.render(next)) };
}
function request(id: string): void {
  localStorage.setItem(`simforge.manualDrive.take.${id}.request`, JSON.stringify({ takeId: id, datasetId: "ds", documentId: "doc", mapVersionId: "map-1", actorRoleId: "ego", interactionId: "interaction", returnHref: "/editor", content: { choreography: { clipSeconds: 1 } } }));
}
function Harness({ id, onValue }: { id: string | null; onValue: (value: ManualDriveTakeBoundary) => void }): null {
  const value = useManualDriveTakeSession(id);
  useEffect(() => onValue(value), [onValue, value]);
  return null;
}
async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve(); });
}
beforeEach(() => localStorage.clear());
afterEach(() => document.body.replaceChildren());

describe("manual drive take deep-link boundary", () => {
  it("shows loading first, then ready for the token request", async () => {
    request("take-1");
    let value: ManualDriveTakeBoundary | null = null;
    render(<Harness id="take-1" onValue={(next) => { value = next; }} />);
    await settle();
    expect(value?.state).toBe("ready");
    expect(value && value.state === "ready" ? value.session : null).toMatchObject({ takeId: "take-1", documentId: "doc", actorRoleId: "ego" });
  });

  it("renders unavailable for an unknown or stale token", async () => {
    let value: ManualDriveTakeBoundary | null = null;
    render(<Harness id="stale-token" onValue={(next) => { value = next; }} />);
    await settle();
    expect(value).toMatchObject({ state: "unavailable", takeId: "stale-token", reason: "expired", returnHref: null });
  });

  it("does not let the previous token resolution overwrite a changed token", async () => {
    request("first");
    let value: ManualDriveTakeBoundary | null = null;
    const view = render(<Harness id="first" onValue={(next) => { value = next; }} />);
    view.rerender(<Harness id="second" onValue={(next) => { value = next; }} />);
    await settle();
    expect(value).toMatchObject({ state: "unavailable", takeId: "second", reason: "expired" });
  });
});
