// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ScenarioReviewQueue } from "../../../src/scenario/review/ScenarioReviewQueue";
import { TopBarSlotProvider, useTopBarSlotContext } from "../../../src/components/TopBarSlot";

function Header() { return <div>{useTopBarSlotContext()?.header?.actions}</div>; }
const item = { documentId: "doc-1", title: "Crossing", datasetId: "set-1", datasetName: "Road tests", mapLabel: null, createdAt: "2026-08-01T00:00:00Z", description: null, archetype: null, contentTags: [], ratingCount: 0, reviewState: "pending", viewerScore: null, revisionId: null, renderJobId: null, renderState: null, previewArtifactId: null };
const page = () => new Response(JSON.stringify({ items: [item], nextCursor: null }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("distinguishes an initial fetch failure from an empty queue and retries", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: "Queue unavailable" }), { status: 503 })).mockResolvedValueOnce(page());
  vi.stubGlobal("fetch", fetcher);
  render(<TopBarSlotProvider><Header /><ScenarioReviewQueue /></TopBarSlotProvider>);
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.queryByText("Nothing left to review")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("heading", { name: "Crossing" })).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("keeps review cards usable while a refresh is pending", async () => {
  let finish!: (response: Response) => void;
  const fetcher = vi.fn().mockResolvedValueOnce(page()).mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
  vi.stubGlobal("fetch", fetcher);
  render(<TopBarSlotProvider><Header /><ScenarioReviewQueue /></TopBarSlotProvider>);
  await screen.findByRole("heading", { name: "Crossing" });
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(screen.getByRole("heading", { name: "Crossing" })).toBeTruthy();
  expect(screen.queryByTestId("cloud-loading-surface")).toBeNull();
  await act(async () => finish(page()));
});
