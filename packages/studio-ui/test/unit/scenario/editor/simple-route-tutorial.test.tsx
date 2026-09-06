// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SimpleRouteTutorialPanel } from "../../../../src/scenario/editor/tutorial/SimpleRouteTutorialPanel";
import {
  markSimpleRouteTutorialSeen,
  shouldShowSimpleRouteTutorial,
} from "../../../../src/scenario/editor/tutorial/simple-route-tutorial";

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

describe("simple route tutorial", () => {
  it("explains the point timing and early-stop behavior", () => {
    const onStart = vi.fn();
    render(<SimpleRouteTutorialPanel onClose={vi.fn()} onStart={onStart} />);

    const timingCopy = screen.getByText(/Each click appends the next point/i).textContent;
    expect(timingCopy).toContain("one second");
    expect(timingCopy).toContain("Ctrl+Z or Cmd+Z");
    expect(screen.getByText(/If you end the path early/i).textContent).toContain(
      "stops at the last point",
    );

    fireEvent.click(screen.getByRole("button", { name: "Draw route" }));
    expect(onStart).toHaveBeenCalledOnce();
  });

  it("is shown only until it has been acknowledged", () => {
    expect(shouldShowSimpleRouteTutorial(window.localStorage)).toBe(true);
    markSimpleRouteTutorialSeen(window.localStorage);
    expect(shouldShowSimpleRouteTutorial(window.localStorage)).toBe(false);
  });
});
