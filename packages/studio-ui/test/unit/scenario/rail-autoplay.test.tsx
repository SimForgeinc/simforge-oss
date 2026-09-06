// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RAIL_AUTOPLAY_DWELL_MS,
  useScenarioRailAutoplay,
} from "../../../src/scenario/rail/useScenarioRailAutoplay";

describe("useScenarioRailAutoplay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("starts stopped", () => {
    const { result } = renderHook(() =>
      useScenarioRailAutoplay({ canAdvance: true, onAdvance: vi.fn() }),
    );
    expect(result.current.playing).toBe(false);
    expect(result.current.progress).toBe(0);
  });

  it("advances once per dwell while playing", () => {
    const onAdvance = vi.fn();
    const { result } = renderHook(() =>
      useScenarioRailAutoplay({ canAdvance: true, onAdvance, dwellMs: 1_000 }),
    );
    act(() => {
      result.current.toggle();
    });
    expect(result.current.playing).toBe(true);
    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(onAdvance).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onAdvance).toHaveBeenCalledTimes(1);
  });

  it("reports progress through the dwell", () => {
    const onAdvance = vi.fn();
    const { result } = renderHook(() =>
      useScenarioRailAutoplay({ canAdvance: true, onAdvance, dwellMs: 1_000 }),
    );
    act(() => {
      result.current.toggle();
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current.progress).toBeGreaterThan(0.4);
    expect(result.current.progress).toBeLessThanOrEqual(0.6);
  });

  it("refuses to start at the end of the dataset", () => {
    const { result } = renderHook(() =>
      useScenarioRailAutoplay({ canAdvance: false, onAdvance: vi.fn() }),
    );
    act(() => {
      result.current.toggle();
    });
    expect(result.current.playing).toBe(false);
  });

  it("stops at the end rather than wrapping", () => {
    // A loop that silently restarts makes a reviewer lose their place in a long dataset.
    const { result, rerender } = renderHook(
      ({ canAdvance }: { canAdvance: boolean }) =>
        useScenarioRailAutoplay({ canAdvance, onAdvance: vi.fn(), dwellMs: 1_000 }),
      { initialProps: { canAdvance: true } },
    );
    act(() => {
      result.current.toggle();
    });
    expect(result.current.playing).toBe(true);
    rerender({ canAdvance: false });
    expect(result.current.playing).toBe(false);
    expect(result.current.progress).toBe(0);
  });

  it("holds the dwell while the selected document is still loading", () => {
    const onAdvance = vi.fn();
    const { result, rerender } = renderHook(
      ({ waiting }: { waiting: boolean }) =>
        useScenarioRailAutoplay({
          canAdvance: true,
          onAdvance,
          dwellMs: 1_000,
          waiting,
        }),
      { initialProps: { waiting: true } },
    );
    act(() => {
      result.current.toggle();
    });
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(onAdvance).not.toHaveBeenCalled();
    rerender({ waiting: false });
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(onAdvance).toHaveBeenCalledTimes(1);
  });

  it("stops cleanly and cancels the pending advance", () => {
    const onAdvance = vi.fn();
    const { result } = renderHook(() =>
      useScenarioRailAutoplay({ canAdvance: true, onAdvance, dwellMs: 1_000 }),
    );
    act(() => {
      result.current.toggle();
    });
    act(() => {
      result.current.stop();
    });
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(onAdvance).not.toHaveBeenCalled();
    expect(result.current.playing).toBe(false);
  });

  it("toggles back off", () => {
    const { result } = renderHook(() =>
      useScenarioRailAutoplay({ canAdvance: true, onAdvance: vi.fn() }),
    );
    act(() => {
      result.current.toggle();
    });
    act(() => {
      result.current.toggle();
    });
    expect(result.current.playing).toBe(false);
  });

  it("does not advance after unmount", () => {
    const onAdvance = vi.fn();
    const { result, unmount } = renderHook(() =>
      useScenarioRailAutoplay({ canAdvance: true, onAdvance, dwellMs: 1_000 }),
    );
    act(() => {
      result.current.toggle();
    });
    unmount();
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(onAdvance).not.toHaveBeenCalled();
  });

  it("uses a six-second dwell by default", () => {
    expect(RAIL_AUTOPLAY_DWELL_MS).toBe(6_000);
  });
});
