import { afterEach, describe, expect, it, vi } from "vitest";

import { observeViewTransitionCompletion } from "../../../src/lib/browser/view-transition";

describe("observeViewTransitionCompletion", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("silences the expected AbortError from a superseded transition", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = Object.assign(new Error("Transition was skipped"), {
      name: "AbortError",
    });

    observeViewTransitionCompletion(
      { finished: Promise.reject(error) },
      "Dataset",
    );
    await Promise.resolve();

    expect(consoleError).not.toHaveBeenCalled();
  });

  it("reports unexpected transition failures with context", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = new Error("render failed");

    observeViewTransitionCompletion(
      { finished: Promise.reject(error) },
      "Dataset",
    );
    await Promise.resolve();

    expect(consoleError).toHaveBeenCalledWith(
      "Dataset view transition failed",
      error,
    );
  });

  it("accepts browsers that omit the finished promise", () => {
    expect(() => observeViewTransitionCompletion({}, "Dataset")).not.toThrow();
  });
});
