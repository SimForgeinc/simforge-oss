// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ScenarioPreviewTimeline } from "../../../../src/scenario/scene/ScenarioPreviewTimeline";

afterEach(cleanup);

describe("ScenarioPreviewTimeline", () => {
  it("renders one compact scrub bar and delegates playback controls", () => {
    const onPlayPause = vi.fn();
    const onSeek = vi.fn();
    render(
      <ScenarioPreviewTimeline
        playback={{
          playing: false,
          time: 4,
          startTime: 0,
          endTime: 20,
          onPlayPause,
          onSeek,
        }}
      />,
    );

    const timeline = screen.getByTestId("scenario-preview-timeline");
    expect(timeline.className).toContain("w-full");
    expect(timeline.className).toContain("bg-black/15");
    expect(timeline.className).toContain("backdrop-blur-[72px]");
    expect(timeline.style.borderRadius).toBe("20px");
    expect(timeline.style.backdropFilter).toContain("blur(72px)");
    expect(screen.getByTestId("scenario-preview-timeline-glass")).toBeTruthy();
    expect(timeline.textContent).toContain("0:04 / 0:20");
    expect(screen.queryByText("Timeline")).toBeNull();

    const playButton = screen.getByRole("button", { name: "Play scenario preview" });
    expect(playButton.className).toContain("border-0");
    expect(playButton.className).toContain("bg-transparent");
    expect(playButton.className).toContain("shadow-none");
    expect(playButton.className).toContain("text-white/85");
    expect(playButton.className).not.toContain("bg-[#E8E044]");
    fireEvent.click(playButton);
    expect(onPlayPause).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByRole("slider", { name: "Scenario preview time" }), {
      target: { value: "12.5" },
    });
    expect(onSeek).toHaveBeenCalledWith(12.5);
  });
});
