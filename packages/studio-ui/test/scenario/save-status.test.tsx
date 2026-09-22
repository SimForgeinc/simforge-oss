// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SaveStatus } from "../../src/scenario/editor/SaveStatus";

afterEach(cleanup);

it("keeps save failures inline and offers a retry until the save succeeds", () => {
  const retry = vi.fn();
  const view = render(<SaveStatus label="Simulation" error="Publish unavailable" onRetry={retry} />);
  expect(screen.getByRole("status").textContent).toContain("Could not save");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(retry).toHaveBeenCalledOnce();
  view.rerender(<SaveStatus label="Simulation" status="saving" onRetry={retry} />);
  expect(screen.getByRole("status").textContent).toContain("Saving…");
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  view.rerender(<SaveStatus label="Simulation" status="saved" onRetry={retry} />);
  expect(screen.getByRole("status").textContent).toContain("Saved");
});
