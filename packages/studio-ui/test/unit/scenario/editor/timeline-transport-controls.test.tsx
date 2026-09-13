// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TimelineTransportControls } from "../../../../src/scenario/editor/timeline/TimelineTransportControls";

afterEach(cleanup);

describe("timeline transport controls", () => {
  it("keeps the playback toggle and reset in one compact row", () => {
    const onPlay = vi.fn();
    const onStop = vi.fn();
    const onReset = vi.fn();

    render(
      <TimelineTransportControls
        playback={{
          sessionId: "preview-1",
          playing: false,
          inspecting: false,
          time: 0,
          onPlay,
          onStop,
          onReset,
          onPlayPause: vi.fn(),
          onSeek: vi.fn(),
          onExitInspection: vi.fn(),
        }}
      />,
    );

    expect(screen.getByTestId("timeline-transport-controls")).not.toBeNull();
    expect(screen.queryByTestId("simulation-issues-button")).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop scenario" })).toBeNull();
    const playButton = screen.getByRole("button", { name: "Play scenario" });
    const resetButton = screen.getByRole("button", { name: "Reset scenario" });
    // One row: both controls are siblings directly under the transport strip,
    // never split across a wrapper or nested in per-button chrome.
    const row = screen.getByTestId("timeline-transport-controls");
    expect([...row.children]).toEqual([playButton, resetButton]);
    fireEvent.click(playButton);
    fireEvent.click(resetButton);
    expect(onPlay).toHaveBeenCalledOnce();
    expect(onReset).toHaveBeenCalledOnce();
    expect(onStop).not.toHaveBeenCalled();

  });

  it("flips the playback button to stop while running and disables it while preparing", () => {
    const onStop = vi.fn();
    const { rerender } = render(
      <TimelineTransportControls playback={null} />,
    );

    expect((screen.getByRole("button", { name: "Play scenario" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Reset scenario" }) as HTMLButtonElement).disabled).toBe(true);

    rerender(
      <TimelineTransportControls
        playback={{
          sessionId: "preview-1",
          playing: true,
          inspecting: true,
          time: 1,
          onPlay: vi.fn(),
          onStop,
          onReset: vi.fn(),
          onPlayPause: vi.fn(),
          onSeek: vi.fn(),
          onExitInspection: vi.fn(),
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Stop scenario" }));
    expect(onStop).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Play scenario" })).toBeNull();
  });

  it("disables Play while route points are being edited", () => {
    const onPlay = vi.fn();
    render(
      <TimelineTransportControls
        playDisabled
        playback={{
          sessionId: "preview-1",
          playing: false,
          inspecting: false,
          time: 0,
          onPlay,
          onStop: vi.fn(),
          onReset: vi.fn(),
          onPlayPause: vi.fn(),
          onSeek: vi.fn(),
          onExitInspection: vi.fn(),
        }}
      />,
    );

    const playButton = screen.getByRole("button", { name: "Play scenario" }) as HTMLButtonElement;
    expect(playButton.disabled).toBe(true);
    fireEvent.click(playButton);
    expect(onPlay).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Reset scenario" }) as HTMLButtonElement).disabled).toBe(false);
  });

});
