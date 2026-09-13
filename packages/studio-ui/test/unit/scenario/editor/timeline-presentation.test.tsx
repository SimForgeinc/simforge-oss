// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Interaction, ReasoningTraceSegment, ScenarioTemplateV2 } from "@simforge-oss/scenario";

import { InteractionTrack } from "../../../../src/scenario/editor/timeline/InteractionTrack";
import { TimelineRuler } from "../../../../src/scenario/editor/timeline/TimelineRuler";
import { TrafficLightDetailsPanel } from "../../../../src/scenario/editor/inspector/TrafficLightDetailsPanel";

vi.mock("../../../../src/scenario/editor/timeline/TriggerControls", () => ({
  TriggerControls: ({ label }: { label: string }) => <div>{label}</div>,
}));
vi.mock("../../../../src/scenario/editor/timeline/InteractionTargetControls", () => ({
  InteractionTargetControls: () => <div>Target</div>,
}));

const { ScenarioTimelineDock } = await import("../../../../src/scenario/editor/ScenarioTimelineDock");
const {
  clampTimelineHeightPx,
  clampTimelineIdentityWidthPx,
  fittedTimelineIdentityWidthPx,
  timelineContentHeightPx,
  timelineDefaultHeightPx,
} = await import("../../../../src/scenario/editor/timeline/V1TimelineRail");

const exact: Interaction = {
  id: "exact-speed",
  actor: "camera-car",
  label: "Accelerate",
  trigger: { kind: "at", t: 1 },
  until: { kind: "at", t: 3 },
  verb: "speed",
  target: { mode: "delta", deltaKph: 10 },
  dynamics: { shape: "linear", constraint: "time", value: 1 },
};

const conditional: Interaction = {
  id: "conditional-brake",
  actor: "camera-car",
  label: "Conditional brake",
  trigger: {
    kind: "when",
    condition: { kind: "speed", of: "camera-car", op: ">=", valueKph: 30 },
    byLatest: 8,
    ifNever: "skip",
  },
  until: { kind: "at", t: 10 },
  verb: "speed",
  target: { mode: "stop" },
  dynamics: { shape: "linear", constraint: "rate", value: 3 },
};

const worldSignal: Interaction = {
  id: "world-signal",
  actor: "@world",
  label: "Signal green",
  trigger: { kind: "at", t: 2 },
  until: { kind: "at", t: 2.5 },
  verb: "set",
  target: { key: "signal:test-head.phase", value: "green" },
};

const worldEnvironment: Interaction = {
  id: "world-weather",
  actor: "@world",
  label: "Add rain",
  trigger: { kind: "at", t: 4 },
  until: { kind: "at", t: 5 },
  verb: "set",
  target: { key: "env.rainIntensity", value: 0.5 },
};

const simpleRoute: Interaction = {
  id: "simple-route-camera-car",
  actor: "camera-car",
  label: "Simple timed route",
  trigger: { kind: "at", t: 0 },
  until: { kind: "at", t: 20 },
  verb: "route",
  target: {
    mode: "customTimedRoute",
    points: [
      { timeS: 0, x: 0, z: 0 },
      { timeS: 10, x: 10, z: 0 },
      { timeS: 20, x: 20, z: 0 },
    ],
  },
};

const unconfiguredSimpleRoute: Interaction = {
  ...simpleRoute,
  id: "simple-route-unconfigured",
  target: {
    mode: "customTimedRoute",
    points: [
      { timeS: 0, x: 4, z: 8 },
      { timeS: 10, x: 4, z: 8 },
      { timeS: 20, x: 4, z: 8 },
    ],
  },
};

function fixture(interactions: readonly Interaction[] = [exact, conditional]) {
  const data = {
    scenarioVersion: 2,
    meta: {
      name: "timeline fixture",
      createdAt: "2026-08-05T00:00:00.000Z",
      modifiedAt: "2026-08-05T00:00:00.000Z",
      appVersion: "test",
    },
    params: { declarations: [] },
    anchor: { features: [] },
    roles: [
      {
        id: "camera-car",
        label: "Camera car",
        actor: { class: "car", catalogId: "vehicle.sedan", static: false, sensors: [{ type: "dash_camera" }] },
        kind: "scene_absolute",
        pose: { position: { x: 0, y: 0, z: 0 }, headingRad: 0 },
        initialRoute: { mode: "lanePath", lanes: ["1:0:-1"] },
      },
      {
        id: "npc",
        label: "NPC car",
        actor: { class: "car", catalogId: "vehicle.sedan", static: false, sensors: [] },
        kind: "scene_absolute",
        pose: { position: { x: 4, y: 0, z: 0 }, headingRad: 0 },
      },
      {
        id: "cone",
        label: "Road cone",
        actor: { class: "static_object", catalogId: "construction.traffic_cone", static: true, sensors: [] },
        kind: "scene_absolute",
        pose: { position: { x: 2, y: 0, z: 0 }, headingRad: 0 },
      },
    ],
    choreography: { warmupSeconds: 3, clipSeconds: 20, interactions: [...interactions] },
    reasoningTrace: [],
    invariants: [],
    variants: [],
  } as unknown as ScenarioTemplateV2;
  return {
    data,
    addInteraction: vi.fn(),
    replaceInteraction: vi.fn(),
    removeInteraction: vi.fn(),
    setMetricSubject: vi.fn(),
    setPresentationExtension: vi.fn(),
    addReasoningTraceSegment: vi.fn(),
    replaceReasoningTraceSegment: vi.fn(),
    removeReasoningTraceSegment: vi.fn(),
    remove: vi.fn(),
  };
}

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440, writable: true });
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("floating timeline presentation", () => {
  it("keeps the full timeline and manages a configured simple route across the entire clip", () => {
    const onPlay = vi.fn();
    const onSeek = vi.fn();
    const onFocusActor = vi.fn();
    const onSelectInteraction = vi.fn();
    const simpleDocument = fixture([simpleRoute]);
    render(
      <ScenarioTimelineDock
        document={simpleDocument as never}
        experience="simple"
        onFocusActor={onFocusActor}
        onSelectInteraction={onSelectInteraction}
        playback={{
          sessionId: "simple-playback",
          playing: false,
          inspecting: true,
          time: 5,
          onPlay,
          onStop: vi.fn(),
          onReset: vi.fn(),
          onPlayPause: vi.fn(),
          onSeek,
          onExitInspection: vi.fn(),
        }}
        state={{ selection: ["camera-car"] } as never}
      />,
    );

    const dock = screen.getByTestId("scenario-timeline-dock");
    expect(dock.getAttribute("data-presentation")).toBe("floating");
    expect(dock.getAttribute("data-interaction-authoring")).toBe("disabled");
    expect(dock.getAttribute("aria-readonly")).toBe("false");
    expect(dock.style.borderRadius).toBe("24px 24px 0 0");
    expect(dock.style.clipPath).toBe("inset(0 round 24px 24px 0 0)");
    expect(screen.queryByTestId("simple-actor-grid")).toBeNull();
    expect(screen.getByTestId("semantic-timeline")).not.toBeNull();
    expect(screen.getByTestId("timeline-actor-lane-camera-car")).not.toBeNull();
    expect(screen.getByTestId("interaction-row-simple-route-camera-car")).not.toBeNull();
    const routeClip = screen.getByTestId("timeline-interaction-clip-simple-route-camera-car");
    expect(routeClip.textContent).toContain("Edit route");
    expect(routeClip.style.left).toBe("0%");
    expect(routeClip.style.width).toBe("100%");
    expect(routeClip.getAttribute("data-editable")).toBe("false");
    expect(routeClip.getAttribute("data-locked")).toBe("true");
    expect(routeClip.getAttribute("data-route-status")).toBe("configured");
    expect(routeClip.querySelector(".lucide-lock")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Focus actor Sedan 1" }));
    expect(onFocusActor).toHaveBeenCalledWith("camera-car");
    fireEvent.click(screen.getByRole("button", { name: "Edit route" }));
    expect(onSelectInteraction).toHaveBeenCalledWith("simple-route-camera-car", "camera-car");
    expect(screen.queryByTestId("timeline-resize-start-simple-route-camera-car")).toBeNull();
    expect(screen.queryByTestId("timeline-resize-end-simple-route-camera-car")).toBeNull();
    fireEvent.contextMenu(screen.getByTestId("interaction-row-simple-route-camera-car"));
    fireEvent.contextMenu(screen.getByTestId("timeline-interaction-gap-npc"));
    expect(screen.queryByRole("button", { name: /Add interaction for/i })).toBeNull();
    expect(simpleDocument.addInteraction).not.toHaveBeenCalled();
    expect(screen.getByTestId("timeline-topbar")).not.toBeNull();
    expect(screen.getByTestId("timeline-ruler")).not.toBeNull();
    expect(screen.getByTestId("timeline-playhead")).not.toBeNull();
    expect(screen.getByRole("slider", { name: "Drag timeline playhead" }).getAttribute("aria-valuenow"))
      .toBe("5");
    fireEvent.click(screen.getByRole("button", { name: "Play scenario" }));
    expect(onPlay).toHaveBeenCalledOnce();
  });

  it("blinks red when a simple route still needs to be drawn", () => {
    render(
      <ScenarioTimelineDock
        document={fixture([unconfiguredSimpleRoute]) as never}
        experience="simple"
        state={{ selection: ["camera-car"] } as never}
      />,
    );

    const routeClip = screen.getByTestId("timeline-interaction-clip-simple-route-unconfigured");
    expect(routeClip.getAttribute("data-route-status")).toBe("needs-setup");
    expect(routeClip.textContent).toContain("Click to configure route");
    expect(routeClip.querySelector(".lucide-lock")).toBeNull();
    expect(screen.getByRole("button", { name: "Configure route; setup required" })).not.toBeNull();
  });

  it("renders from document data before the 3D editor state is ready", () => {
    render(<ScenarioTimelineDock document={fixture() as never} state={null} />);

    expect(screen.getByTestId("scenario-timeline-dock")).not.toBeNull();
    expect(screen.getByTestId("timeline-actor-lane-camera-car")).not.toBeNull();
  });

  it("grows from its empty height until the shell's current maximum takes over", () => {
    expect(timelineContentHeightPx(0)).toBe(168);
    expect(timelineContentHeightPx(1)).toBe(168);
    expect(timelineContentHeightPx(4)).toBe(208);
    expect(timelineContentHeightPx(8)).toBe(368);
    expect(timelineDefaultHeightPx(0)).toBe(168);
    expect(timelineDefaultHeightPx(4)).toBe(208);
    expect(timelineDefaultHeightPx(8)).toBe(300);
    expect(clampTimelineHeightPx(600, 800)).toBe(520);
  });

  // The dock's horizontal edges are user-draggable so the timeline can be
  // pulled clear of side panels. The wrapper measures the shell's container
  // rather than owning a width of its own, so a container is supplied here.
  function renderDockInContainer(width: number, document = fixture([])) {
    const container = window.document.createElement("div");
    Object.defineProperty(container, "getBoundingClientRect", {
      value: () => ({ width, height: 300, top: 0, left: 0, right: width, bottom: 300, x: 0, y: 0, toJSON: () => ({}) }),
    });
    window.document.body.appendChild(container);
    const view = render(
      <ScenarioTimelineDock document={document as never} state={{ selection: [] } as never} />,
      { container },
    );
    return { ...view, dock: screen.getByTestId("resizable-timeline-dock") };
  }

  it("drags either edge inward, clamps so the timeline never drops below 360px, and persists the result", () => {
    const { dock, unmount } = renderDockInContainer(920);
    const left = screen.getByRole("separator", { name: "Resize timeline from left edge" });
    const right = screen.getByRole("separator", { name: "Resize timeline from right edge" });
    expect(dock.style.getPropertyValue("--timeline-dock-left-inset")).toBe("0px");

    fireEvent.pointerDown(left, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(left, { clientX: 220, pointerId: 1 });
    fireEvent.pointerUp(left, { clientX: 220, pointerId: 1 });
    expect(dock.style.getPropertyValue("--timeline-dock-left-inset")).toBe("120px");
    expect(left.getAttribute("aria-valuenow")).toBe("120");

    // Dragging the right edge left by more than the room left over stops at the
    // 360px floor: 920 - 360 - 120 (left inset) = 440.
    fireEvent.pointerDown(right, { button: 0, clientX: 900, pointerId: 2 });
    fireEvent.pointerMove(right, { clientX: 100, pointerId: 2 });
    fireEvent.pointerUp(right, { clientX: 100, pointerId: 2 });
    expect(dock.style.getPropertyValue("--timeline-dock-right-inset")).toBe("440px");
    expect(dock.style.getPropertyValue("--timeline-dock-left-inset")).toBe("120px");

    // A remount restores what the author dragged, without any drag replaying.
    unmount();
    const remounted = renderDockInContainer(920);
    expect(remounted.dock.style.getPropertyValue("--timeline-dock-left-inset")).toBe("120px");
    expect(remounted.dock.style.getPropertyValue("--timeline-dock-right-inset")).toBe("440px");
  });

  it("refits persisted insets to a narrower container and resets an edge from double click or the keyboard", () => {
    const wide = renderDockInContainer(920);
    const left = screen.getByRole("separator", { name: "Resize timeline from left edge" });
    fireEvent.pointerDown(left, { button: 0, clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(left, { clientX: 400, pointerId: 1 });
    fireEvent.pointerUp(left, { clientX: 400, pointerId: 1 });
    const right = screen.getByRole("separator", { name: "Resize timeline from right edge" });
    fireEvent.keyDown(right, { key: "ArrowLeft" });
    fireEvent.keyDown(right, { key: "ArrowLeft" });
    expect(wide.dock.style.getPropertyValue("--timeline-dock-left-inset")).toBe("400px");
    expect(wide.dock.style.getPropertyValue("--timeline-dock-right-inset")).toBe("32px");
    wide.unmount();

    // 432px of insets do not fit a 600px container above the 360px floor; they
    // shrink proportionally (240 available: 400/432 -> 222, remainder 18).
    const narrow = renderDockInContainer(600);
    expect(narrow.dock.style.getPropertyValue("--timeline-dock-left-inset")).toBe("222px");
    expect(narrow.dock.style.getPropertyValue("--timeline-dock-right-inset")).toBe("18px");

    fireEvent.doubleClick(screen.getByRole("separator", { name: "Resize timeline from left edge" }));
    expect(narrow.dock.style.getPropertyValue("--timeline-dock-left-inset")).toBe("0px");
    fireEvent.keyDown(screen.getByRole("separator", { name: "Resize timeline from right edge" }), { key: "ArrowRight" });
    expect(narrow.dock.style.getPropertyValue("--timeline-dock-right-inset")).toBe("2px");
  });

  // The divider redistributes one row's width between the name column and the
  // time track, so the track keeps a floor no drag can cross: a name column wide
  // enough to hide every clip would make the timeline useless.
  it("redistributes the split without collapsing the time track", () => {
    expect(clampTimelineIdentityWidthPx(200, 920)).toBe(200);
    expect(clampTimelineIdentityWidthPx(10, 920)).toBe(72);
    expect(clampTimelineIdentityWidthPx(5000, 920)).toBe(420);
    // A narrow rail yields to the track floor before the absolute maximum.
    expect(clampTimelineIdentityWidthPx(400, 400)).toBe(180);
    // Even an impossibly narrow rail keeps the column usable rather than zero.
    expect(clampTimelineIdentityWidthPx(120, 200)).toBe(72);
    expect(clampTimelineIdentityWidthPx(114.6, 920)).toBe(115);
  });

  // The column's resting width is whatever shows every label and its row icons
  // in full, so a long actor name is never clipped and a short one never leaves
  // the icons crowded against the divider.
  it("fits the name column to the widest identity row", () => {
    const rows = (...widths: number[]) => widths.map((width) => ({
      getBoundingClientRect: () => ({ width }),
    }));

    // The widest row wins, plus the slack that keeps text off the divider.
    expect(fittedTimelineIdentityWidthPx(rows(96, 143, 88), 920)).toBe(152);
    // Sub-pixel text widths round up: rounding down is what clips a glyph.
    expect(fittedTimelineIdentityWidthPx(rows(120.2), 920)).toBe(130);
    // Narrow content still leaves a usable column rather than a sliver.
    expect(fittedTimelineIdentityWidthPx(rows(12), 920)).toBe(72);
    // A pathological name yields to the time track floor, and the cell clips
    // rather than the timeline becoming unusable.
    expect(fittedTimelineIdentityWidthPx(rows(4000), 920)).toBe(420);
    expect(fittedTimelineIdentityWidthPx(rows(4000), 500)).toBe(280);
    // Nothing mounted, or nothing laid out yet: the caller keeps its width.
    expect(fittedTimelineIdentityWidthPx([], 920)).toBeNull();
    expect(fittedTimelineIdentityWidthPx(rows(0, 0), 920)).toBeNull();
  });

  it("fills the canvas bar, retains stable selectors, and omits sidebar resize chrome", () => {
    const document = fixture();
    render(
      <ScenarioTimelineDock
        document={document as never}
        state={{ selection: ["camera-car"] } as never}
      />,
    );

    const dock = screen.getByTestId("scenario-timeline-dock");
    expect(dock.getAttribute("data-presentation")).toBe("floating");
    expect(dock.getAttribute("data-floating")).toBe("true");
    expect(dock.style.width).toBe("100%");
    expect(dock.style.borderRadius).toBe("24px 24px 0 0");
    expect(dock.style.clipPath).toBe("inset(0 round 24px 24px 0 0)");
    expect(dock.style.backdropFilter).toBe("blur(72px) saturate(1.85) contrast(1.05)");
    expect(dock.style.maxHeight).toBe("min(65vh, 520px)");
    expect(Number.parseInt(dock.style.height, 10)).toBeGreaterThanOrEqual(168);
    expect(screen.getByTestId("timeline-glass-backdrop")).not.toBeNull();
    expect(screen.queryByTestId("timeline-width-divider")).toBeNull();
    expect(screen.queryByTestId("timeline-collapse-rail")).toBeNull();
    const topbar = screen.getByTestId("timeline-topbar");
    // The split is one authored value published on the rail, so the header, the
    // lanes, and the playhead offset all read the same custom property.
    const rail = screen.getByTestId("scenario-timeline-dock");
    expect(rail.style.getPropertyValue("--timeline-identity-width")).toBe("114px");
    expect(screen.getByTestId("timeline-split-resize-handle").getAttribute("aria-orientation")).toBe("vertical");
    expect(within(topbar).queryByTestId("timeline-transport-play")).toBeNull();
    expect(within(topbar).getByTestId("timeline-transport-controls")).not.toBeNull();
    expect(within(topbar).getByText("Timeline")).not.toBeNull();
    expect(within(topbar).getByText("Timeline").parentElement)
      .toBe(within(topbar).getByTestId("timeline-transport-controls").parentElement);
    expect(within(topbar).queryByTestId("timeline-authoring-scrubber")).toBeNull();
    expect(within(topbar).queryByTestId("timeline-time-readout")).toBeNull();
    expect(within(topbar).getByTestId("timeline-ruler")).not.toBeNull();
    expect(within(topbar).getByTestId("timeline-inline-ruler")).not.toBeNull();
    expect(within(topbar).queryByText("Lanes")).toBeNull();
    expect(within(topbar).queryByText("Space play/pause · Esc reset")).toBeNull();
    expect(within(topbar).queryByText("20s clip")).toBeNull();
    expect(screen.getByTestId("semantic-timeline")).not.toBeNull();
    expect(screen.getByTestId("timeline-ruler")).not.toBeNull();
    expect(screen.getByTestId("timeline-tick-label-2000")).toBeTruthy();
    expect(screen.getByTestId("timeline-playhead").parentElement).toBe(dock);
    expect(screen.getByTestId("timeline-playhead").style.left)
      .toBe("calc(var(--timeline-identity-width) + (100% - var(--timeline-identity-width)) * 0)");
    expect(screen.getByTestId("interaction-row-exact-speed")).not.toBeNull();
    expect(screen.getByTestId("interaction-expand-exact-speed").getAttribute("aria-controls")).toBe(
      "scenario-interaction-exact-speed",
    );
  });

  it("expands upward from the top resize handle and resets on double click", () => {
    const document = fixture([]);
    render(
      <ScenarioTimelineDock
        document={document as never}
        state={{ selection: [] } as never}
      />,
    );

    const dock = screen.getByTestId("scenario-timeline-dock");
    const handle = screen.getByTestId("timeline-height-resize-handle");
    expect(dock.style.height).toBe("168px");
    fireEvent.pointerDown(handle, { button: 0, clientY: 300, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientY: 240, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientY: 240, pointerId: 1 });
    expect(dock.style.height).toBe("228px");
    fireEvent.doubleClick(handle);
    expect(dock.style.height).toBe("168px");
  });

  it("uses catalog silhouettes and clean numbered catalog names for actor identities", () => {
    const document = fixture([]);
    document.data.roles[0]!.actor.catalogId = "vehicle.ambulance";
    document.data.roles.push({
      id: "walker-debug-37",
      label: "pedestrian_adult_walking_01JDEBUG",
      actor: {
        class: "pedestrian",
        catalogId: "pedestrian.adult",
        static: false,
        sensors: [],
      },
      kind: "scene_absolute",
      pose: { position: { x: 8, y: 0, z: 0 }, headingRad: 0 },
    } as never);

    render(<ScenarioTimelineDock document={document as never} state={{ selection: [] } as never} />);

    expect(within(screen.getByTestId("timeline-actor-identity-camera-car")).getByText("Ambulance 1")).not.toBeNull();
    expect(within(screen.getByTestId("timeline-actor-identity-npc")).getByText("Sedan 1")).not.toBeNull();
    expect(within(screen.getByTestId("timeline-actor-identity-walker-debug-37")).getByText("Pedestrian 1")).not.toBeNull();
    expect(within(screen.getByTestId("timeline-actor-identity-cone")).getByText("Traffic cone 1")).not.toBeNull();
    expect(screen.getByTestId("timeline-actor-icon-camera-car").querySelector('[data-catalog-icon="vehicle.ambulance"]')).not.toBeNull();
    expect(screen.getByTestId("timeline-actor-icon-npc").querySelector('[data-catalog-icon="vehicle.sedan"]')).not.toBeNull();
    expect(screen.getByTestId("timeline-actor-icon-walker-debug-37").querySelector('[data-catalog-icon="pedestrian.adult"]')).not.toBeNull();
    expect(screen.getByTestId("timeline-actor-icon-cone").querySelector('[data-catalog-icon="construction.traffic_cone"]')).not.toBeNull();
  });

  it("adds and edits observation/action clips only for the sensor-carrying vehicle", () => {
    const document = fixture([]);
    document.data.metricSubject = "npc";
    document.data.reasoningTrace = [{
      id: "trace-one",
      actor: "camera-car",
      startS: 2,
      endS: 4,
      observation: "A cyclist enters the lane.",
      action: "Slow and leave space.",
    }];
    render(<ScenarioTimelineDock document={document as never} state={{ selection: [] } as never} />);

    expect(screen.getByTestId("timeline-reasoning-trace-lane")).not.toBeNull();
    fireEvent.click(screen.getByTestId("reasoning-trace-clip-trace-one"));
    expect((screen.getByLabelText("Observation") as HTMLTextAreaElement).value).toBe("A cyclist enters the lane.");
    expect((screen.getByLabelText("Action") as HTMLTextAreaElement).value).toBe("Slow and leave space.");
    expect(screen.getByPlaceholderText("What is happening around the camera vehicle?")).not.toBeNull();
    expect(screen.getByPlaceholderText("What should the camera vehicle do next?")).not.toBeNull();
    fireEvent.change(screen.getByLabelText("Action"), { target: { value: "Brake smoothly." } });
    fireEvent.click(screen.getByRole("button", { name: "Save trace" }));
    expect(document.replaceReasoningTraceSegment).toHaveBeenCalledWith(
      "trace-one",
      expect.objectContaining({ action: "Brake smoothly." }),
    );
  });

  it("routes Delete to the reasoning clip open in details", () => {
    const document = fixture([]);
    const onClearSelection = vi.fn();
    document.data.metricSubject = "camera-car";
    document.data.reasoningTrace = [{
      id: "trace-one",
      actor: "camera-car",
      startS: 2,
      endS: 4,
      observation: "A cyclist enters the lane.",
      action: "Slow and leave space.",
    }];
    render(
      <ScenarioTimelineDock
        document={document as never}
        onClearSelection={onClearSelection}
        state={{ selection: ["camera-car"] } as never}
      />,
    );

    fireEvent.click(screen.getByTestId("reasoning-trace-clip-trace-one"));
    expect(onClearSelection).toHaveBeenCalledOnce();
    fireEvent.keyDown(window, { key: "Delete" });

    expect(document.removeReasoningTraceSegment).toHaveBeenCalledExactlyOnceWith("trace-one");
  });

  it("renders one persisted reasoning trace row without duplicating its global add action", () => {
    const document = fixture([]);
    document.data.metricSubject = "camera-car";
    document.data.extensions = { "studio.presentation.reasoningTraceLane": true };
    render(
      <ScenarioTimelineDock document={document as never} state={{ selection: [] } as never} />,
    );

    document.addReasoningTraceSegment.mockImplementation((segment: ReasoningTraceSegment) => {
      document.data.reasoningTrace.push(segment);
    });
    expect(screen.getAllByTestId("timeline-reasoning-trace-lane")).toHaveLength(1);
    expect(within(screen.getByTestId("timeline-topbar")).queryByRole("button", { name: "Add reasoning trace" })).toBeNull();
    fireEvent.contextMenu(screen.getByTestId("timeline-reasoning-trace-lane").lastElementChild!, { clientX: 200 });
    expect(document.addReasoningTraceSegment).toHaveBeenCalledOnce();
    const panel = screen.getByTestId("scenario-reasoning-trace-panel");
    expect(panel.getAttribute("data-placement")).toBe("right-centered");
    expect(panel.getAttribute("data-size")).toBe("compact");
    expect(screen.getByLabelText("Observation")).not.toBeNull();
    expect(screen.getByLabelText("Action")).not.toBeNull();
  });

  it("focuses from the actor name while empty row space remains selection-only", () => {
    const document = fixture([]);
    const onSelectActor = vi.fn();
    const onFocusActor = vi.fn();
    render(
      <ScenarioTimelineDock
        document={document as never}
        onFocusActor={onFocusActor}
        onSelectActor={onSelectActor}
        state={{ selection: [] } as never}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Focus actor Sedan 1" }));
    fireEvent.click(screen.getByTestId("timeline-interaction-gap-camera-car"));
    expect(onFocusActor).toHaveBeenCalledOnce();
    expect(onFocusActor).toHaveBeenCalledWith("camera-car");
    expect(onSelectActor).toHaveBeenCalledOnce();
    expect(onSelectActor).toHaveBeenCalledWith("camera-car");
  });

  it("draws supplied signals first, omits route baselines, and keeps identity-only static actors", () => {
    const document = fixture();
    render(
      <ScenarioTimelineDock
        document={document as never}
        signalLanes={[
          {
            junctionId: "j-1",
            controllerId: "c-1",
            headIds: ["head-north"],
            referenceHeadId: "head-north",
            bands: [
              { startS: 0, endS: 4, indication: "green", source: "authored", clipId: "phase-1" },
              { startS: 4, endS: 8, indication: "red", source: "baseline", clipId: null },
            ],
          },
        ]}
        state={{ selection: [] } as never}
      />,
    );

    const signal = screen.getByTestId("timeline-signal-lane-j-1-c-1");
    const actor = screen.getByTestId("timeline-actor-lane-camera-car");
    expect(signal.compareDocumentPosition(actor) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(screen.queryByTestId("timeline-initial-route-camera-car")).toBeNull();
    expect(screen.queryByTestId("timeline-initial-route-npc")).toBeNull();
    expect(screen.getByTestId("timeline-static-identity-only-cone")).not.toBeNull();
    expect(screen.queryByTestId("timeline-initial-route-cone")).toBeNull();
    expect(screen.getByTestId("timeline-signal-band-j-1-c-1-4").getAttribute("data-source")).toBe("baseline");
  });

  it("routes action selection through the shared editor overlay authority and keeps unselected signals read only", () => {
    const document = fixture();
    const onSelectInteraction = vi.fn();
    render(
      <ScenarioTimelineDock
        document={document as never}
        onSelectInteraction={onSelectInteraction}
        signalLanes={[
          {
            junctionId: "j-1",
            controllerId: "c-1",
            headIds: ["head-north"],
            referenceHeadId: "head-north",
            bands: [
              { startS: 0, endS: 4, indication: "green", source: "authored", clipId: "phase-1" },
            ],
          },
        ]}
        state={{ selection: [] } as never}
      />,
    );

    fireEvent.click(screen.getByTestId("interaction-expand-exact-speed"));
    expect(onSelectInteraction).toHaveBeenCalledWith("exact-speed", "camera-car");
    expect(screen.queryByTestId("interaction-inspector-exact-speed")).toBeNull();

    const signal = screen.getByTestId("timeline-signal-band-j-1-c-1-0");
    expect(signal.getAttribute("data-timeline-signal-phase-id")).toBeNull();
    expect(signal.hasAttribute("disabled")).toBe(true);
    fireEvent.click(signal);
    expect(screen.queryByTestId("scenario-traffic-light-details-panel")).toBeNull();
  });

  it("focuses a planned light from its lane label and reopens control from cycle clips", () => {
    const document = fixture();
    const onFocusSignal = vi.fn();
    const onSelectSignal = vi.fn();
    const onRemoveControl = vi.fn();
    render(
      <ScenarioTimelineDock
        document={document as never}
        onFocusSignal={onFocusSignal}
        onSelectSignal={onSelectSignal}
        signalLanes={[
          {
            junctionId: "j-1",
            controllerId: "c-1",
            headIds: ["head-north"],
            referenceHeadId: "head-north",
            onRemoveControl,
            bands: [
              { startS: 0, endS: 4, indication: "green", source: "authored", clipId: "phase-1" },
              { startS: 4, endS: 8, indication: "red", source: "baseline", clipId: null },
            ],
          },
        ]}
        state={{ selection: [] } as never}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Focus traffic light head-north" }));
    expect(onFocusSignal).toHaveBeenCalledOnce();
    expect(onFocusSignal).toHaveBeenCalledWith("head-north");
    fireEvent.click(screen.getByTestId("timeline-signal-band-j-1-c-1-0"));
    const baseline = screen.getByTestId("timeline-signal-band-j-1-c-1-4");
    expect(baseline.getAttribute("aria-label")).toMatch(/click to take control/i);
    expect(baseline.querySelector("svg")).toBeNull();
    fireEvent.click(baseline);
    expect(onSelectSignal).toHaveBeenCalledTimes(2);
    expect(onSelectSignal).toHaveBeenNthCalledWith(1, "head-north");
    expect(onSelectSignal).toHaveBeenNthCalledWith(2, "head-north");
    fireEvent.click(screen.getByRole("button", { name: "Remove control from traffic light head-north" }));
    expect(onRemoveControl).toHaveBeenCalledOnce();
  });

  it("authors one selected light as a three-value junction cycle in the universal details panel", async () => {
    const onTimingChange = vi.fn();
    const onPhaseOrderChange = vi.fn();
    const onReset = vi.fn();
    const onRemoveControl = vi.fn();
    const onClose = vi.fn();
    render(
      <TrafficLightDetailsPanel
        authoring={{
          junctionId: "j-1",
          headId: "head-north",
          label: "Northbound light",
          timing: { greenS: 10, yellowS: 3, redS: 12 },
          phaseOrder: ["green", "yellow", "red"],
          generated: true,
          crossingStageCount: 2,
          hasPlan: true,
          onTimingChange,
          onPhaseOrderChange,
          onReset,
          onRemoveControl,
        }}
        onClose={onClose}
      />,
    );

    expect(await screen.findByTestId("scenario-traffic-light-details-panel")).not.toBeNull();
    expect(screen.getByTestId("scenario-traffic-light-details-panel").textContent).toMatch(
      /Every other light in junction j-1\s*is aligned automatically/i,
    );
    expect(screen.queryByLabelText(/controller/i)).toBeNull();
    expect(screen.queryByLabelText(/reference head/i)).toBeNull();
    expect(screen.getAllByTestId(/traffic-light-phase-row-/).map((row) => row.getAttribute("data-testid"))).toEqual([
      "traffic-light-phase-row-green",
      "traffic-light-phase-row-yellow",
      "traffic-light-phase-row-red",
    ]);

    fireEvent.change(screen.getByLabelText("Green"), { target: { value: "14" } });
    fireEvent.blur(screen.getByLabelText("Green"));
    expect(onTimingChange).toHaveBeenCalledWith({ greenS: 14 });

    fireEvent.click(screen.getByRole("button", { name: "Move Green down" }));
    expect(onPhaseOrderChange).toHaveBeenCalledWith(["yellow", "green", "red"]);

    fireEvent.click(screen.getByTestId("traffic-light-details-reset"));
    expect(onReset).toHaveBeenCalledWith({
      timing: { greenS: 10, yellowS: 3, redS: 12 },
      phaseOrder: ["green", "yellow", "red"],
    });
    fireEvent.click(screen.getByTestId("traffic-light-remove-control"));
    expect(onRemoveControl).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("editor-details-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps world signal and environment interactions in a scene lane after supplied signals", () => {
    const document = fixture([exact, worldSignal, worldEnvironment]);
    const onSelectInteraction = vi.fn();
    render(
      <ScenarioTimelineDock
        document={document as never}
        onSelectInteraction={onSelectInteraction}
        signalLanes={[
          {
            junctionId: "j-1",
            controllerId: "c-1",
            headIds: ["head-north"],
            referenceHeadId: "head-north",
            bands: [
              { startS: 0, endS: 4, indication: "green", source: "authored", clipId: "phase-1" },
            ],
          },
        ]}
        state={{ selection: [] } as never}
      />,
    );

    const signal = screen.getByTestId("timeline-signal-lane-j-1-c-1");
    const world = screen.getByTestId("timeline-world-lane");
    const actor = screen.getByTestId("timeline-actor-lane-camera-car");
    expect(signal.compareDocumentPosition(world) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(world.compareDocumentPosition(actor) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(screen.getByTestId("timeline-interaction-clip-world-signal")).not.toBeNull();
    expect(screen.getByTestId("timeline-interaction-clip-world-weather")).not.toBeNull();
    fireEvent.click(screen.getByTestId("interaction-expand-world-weather"));
    expect(onSelectInteraction).toHaveBeenCalledWith("world-weather", "@world");
  });

  it("does not relabel an unknown actor reference as a world interaction", () => {
    const invalidActor = { ...exact, id: "unknown-actor-action", actor: "missing-role" } as Interaction;
    const document = fixture([invalidActor]);
    render(<ScenarioTimelineDock document={document as never} state={{ selection: [] } as never} />);

    expect(screen.queryByTestId("timeline-world-lane")).toBeNull();
    expect(screen.queryByTestId("timeline-interaction-clip-unknown-actor-action")).toBeNull();
  });

  it("uses the shared browser simulation transport and can return safely to authoring", () => {
    const document = fixture([]);
    const onPlayPause = vi.fn();
    const onExitInspection = vi.fn();
    const { rerender } = render(
      <ScenarioTimelineDock document={document as never} state={{ selection: [] } as never} />,
    );

    expect(screen.queryByTestId("timeline-transport-play")).toBeNull();
    expect(screen.getAllByTestId("timeline-playhead")).toHaveLength(1);
    expect(screen.queryByTestId("timeline-authoring-scrubber")).toBeNull();
    expect(screen.queryByTestId("timeline-time-readout")).toBeNull();

    const focusedButton = window.document.createElement("button");
    window.document.body.append(focusedButton);
    focusedButton.focus();
    const unavailableSpace = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "Space",
      key: " ",
    });
    focusedButton.dispatchEvent(unavailableSpace);
    expect(unavailableSpace.defaultPrevented).toBe(true);

    rerender(
      <ScenarioTimelineDock
        document={document as never}
        playback={{
          sessionId: "browser-simulation-1",
          playing: false,
          inspecting: true,
          time: 2.5,
          onPlay: vi.fn(),
          onStop: vi.fn(),
          onReset: vi.fn(),
          onPlayPause,
          onSeek: vi.fn(),
          onExitInspection,
        }}
        state={{ selection: [] } as never}
      />,
    );
    expect(screen.queryByTestId("timeline-transport-play")).toBeNull();
    expect(screen.queryByTestId("timeline-exit-playback")).toBeNull();

    fireEvent.keyDown(window, { code: "Space", key: " " });
    expect(onPlayPause).toHaveBeenCalledOnce();

    fireEvent.keyDown(window, { code: "Space", key: " ", repeat: true });
    expect(onPlayPause).toHaveBeenCalledOnce();

    const focusedSpace = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "Space",
      key: " ",
    });
    focusedButton.dispatchEvent(focusedSpace);
    expect(focusedSpace.defaultPrevented).toBe(true);
    expect(onPlayPause).toHaveBeenCalledTimes(2);

    const textInput = window.document.createElement("input");
    window.document.body.append(textInput);
    textInput.focus();
    const typedSpace = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "Space",
      key: " ",
    });
    textInput.dispatchEvent(typedSpace);
    expect(typedSpace.defaultPrevented).toBe(false);
    expect(onPlayPause).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(window, { code: "Escape", key: "Escape" });
    expect(onExitInspection).toHaveBeenCalledOnce();
  });

  it("seeks playback from empty timeline space without stealing interaction clip clicks", () => {
    const document = fixture([exact]);
    const onSeek = vi.fn();
    const onSelectInteraction = vi.fn();
    render(
      <ScenarioTimelineDock
        document={document as never}
        onSelectInteraction={onSelectInteraction}
        playback={{
          sessionId: "seekable-preview",
          playing: true,
          inspecting: true,
          time: 1,
          onPlay: vi.fn(),
          onStop: vi.fn(),
          onReset: vi.fn(),
          onPlayPause: vi.fn(),
          onSeek,
          onExitInspection: vi.fn(),
        }}
        state={{ selection: [] } as never}
      />,
    );

    const emptyTrack = screen.getByTestId("timeline-interaction-gap-npc");
    vi.spyOn(emptyTrack, "getBoundingClientRect").mockReturnValue({ left: 100, width: 400 } as DOMRect);
    fireEvent.pointerDown(emptyTrack, { button: 0, clientX: 300, pointerId: 12 });
    expect(onSeek).toHaveBeenLastCalledWith(10);
    fireEvent.pointerMove(emptyTrack, { clientX: 380, pointerId: 12 });
    expect(onSeek).toHaveBeenLastCalledWith(14);
    fireEvent.pointerUp(emptyTrack, { clientX: 420, pointerId: 12 });
    expect(onSeek).toHaveBeenLastCalledWith(16);

    const occupiedTrack = screen.getByTestId("interaction-row-exact-speed");
    vi.spyOn(occupiedTrack, "getBoundingClientRect").mockReturnValue({ left: 100, width: 400 } as DOMRect);
    const seekCountBeforeClipClick = onSeek.mock.calls.length;
    const interactionClip = screen.getByTestId("interaction-expand-exact-speed");
    fireEvent.pointerDown(interactionClip, { button: 0, clientX: 340, pointerId: 13 });
    fireEvent.pointerUp(interactionClip, { button: 0, clientX: 340, pointerId: 13 });
    fireEvent.click(interactionClip, { button: 0, clientX: 340 });
    expect(onSeek).toHaveBeenCalledTimes(seekCountBeforeClipClick);
    expect(onSelectInteraction).toHaveBeenCalledWith("exact-speed", "camera-car");
  });

  it("drags the playhead to seek continuously without treating it as a track click", () => {
    const document = fixture([exact]);
    const onSeek = vi.fn();
    render(
      <ScenarioTimelineDock
        document={document as never}
        playback={{
          sessionId: "drag-preview",
          playing: true,
          inspecting: true,
          time: 2,
          onPlay: vi.fn(),
          onStop: vi.fn(),
          onReset: vi.fn(),
          onPlayPause: vi.fn(),
          onSeek,
          onExitInspection: vi.fn(),
        }}
        state={{ selection: [] } as never}
      />,
    );

    const dock = screen.getByTestId("scenario-timeline-dock");
    vi.spyOn(dock, "getBoundingClientRect").mockReturnValue({ left: 0, width: 514 } as DOMRect);
    const handle = screen.getByRole("slider", { name: "Drag timeline playhead" });
    fireEvent.pointerDown(handle, { button: 0, clientX: 154, pointerId: 7 });
    fireEvent.pointerMove(handle, { clientX: 314, pointerId: 7 });
    expect(onSeek).toHaveBeenNthCalledWith(1, 2);
    expect(onSeek).toHaveBeenNthCalledWith(2, 10);
    expect(handle.getAttribute("aria-valuenow")).toBe("10");
    fireEvent.pointerUp(handle, { clientX: 314, pointerId: 7 });
    expect(onSeek).toHaveBeenLastCalledWith(10);
  });

  it("keeps list playback transport while removing every authoring affordance", () => {
    const document = fixture([]);
    const onSeek = vi.fn();
    render(
      <ScenarioTimelineDock
        document={document as never}
        playback={{
          sessionId: "saved-preview",
          playing: false,
          inspecting: true,
          time: 1,
          onPlay: vi.fn(),
          onStop: vi.fn(),
          onReset: vi.fn(),
          onPlayPause: vi.fn(),
          onSeek,
          onExitInspection: vi.fn(),
        }}
        readOnly
        state={{ selection: [] } as never}
      />,
    );

    expect(screen.queryByTestId("timeline-add-camera-car-actions")).toBeNull();
    expect(screen.queryByTestId("timeline-delete-camera-car")).toBeNull();
    expect(screen.getAllByText("No authored actions")).toHaveLength(2);
    fireEvent.contextMenu(screen.getByTestId("timeline-interaction-gap-camera-car"));
    expect(screen.queryByTestId("timeline-context-menu")).toBeNull();
    expect(screen.queryByTestId("timeline-transport-play")).toBeNull();
    expect(screen.queryByLabelText("Playback time")).toBeNull();
    const readOnlyGap = screen.getByTestId("timeline-interaction-gap-camera-car");
    vi.spyOn(readOnlyGap, "getBoundingClientRect").mockReturnValue({ left: 100, width: 400 } as DOMRect);
    fireEvent.pointerDown(readOnlyGap, { button: 0, clientX: 300, pointerId: 21 });
    fireEvent.pointerUp(readOnlyGap, { button: 0, clientX: 300, pointerId: 21 });
    expect(onSeek).toHaveBeenCalledWith(10);
    expect(document.addInteraction).not.toHaveBeenCalled();
  });

  it("exposes directly grabbable handles for literal ranges and locks conditional timing", () => {
    const document = fixture();
    const { rerender } = render(
      <ScenarioTimelineDock
        document={document as never}
        state={{ selection: [] } as never}
      />,
    );

    expect(screen.getByTestId("timeline-interaction-clip-exact-speed").getAttribute("data-editable")).toBe("true");
    expect(screen.getByTestId("timeline-interaction-clip-conditional-brake").getAttribute("data-editable")).toBe("false");
    expect(screen.getByTestId("timeline-resize-start-exact-speed")).not.toBeNull();
    expect(screen.getByTestId("timeline-resize-end-exact-speed")).not.toBeNull();
    expect(screen.queryByTestId("interaction-inspector-exact-speed")).toBeNull();

    rerender(
      <ScenarioTimelineDock
        document={document as never}
        state={{ selection: [] } as never}
      />,
    );
    expect((screen.getByTestId("timeline-resize-start-conditional-brake") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("timeline-resize-end-conditional-brake") as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows compact cause, deadline, and same-control conflict cues", () => {
    const conflicting = {
      ...exact,
      id: "conflicting-speed",
      label: "Hold speed",
      trigger: { kind: "at", t: 2 },
      until: { kind: "at", t: 4 },
    } as Interaction;
    const document = fixture([exact, conditional, conflicting]);
    render(
      <ScenarioTimelineDock
        document={document as never}
        state={{ selection: [] } as never}
      />,
    );

    expect(screen.getByTestId("timeline-cause-exact-speed").getAttribute("data-cause")).toBe("time");
    expect(screen.getByTestId("timeline-cause-conditional-brake").getAttribute("data-cause")).toBe("event");
    expect(screen.getByTestId("timeline-trigger-deadline-conditional-brake").getAttribute("aria-label")).toBe(
      "Trigger deadline by 8s",
    );
    expect(screen.getByTestId("timeline-interaction-clip-exact-speed").getAttribute("data-conflict")).toBe("conflict");
    expect(screen.getByTestId("timeline-interaction-clip-conflicting-speed").getAttribute("data-conflict")).toBe("conflict");
    expect(screen.getByTestId("timeline-conflict-exact-speed").getAttribute("aria-label")).toContain(
      "controls speed at the same time",
    );
  });

  it("resizes either clip edge on the first drag without requiring a selection click", () => {
    const document = fixture();
    const onSelectInteraction = vi.fn();
    render(
      <ScenarioTimelineDock
        document={document as never}
        onSelectInteraction={onSelectInteraction}
        state={{ selection: [] } as never}
      />,
    );
    vi.spyOn(
      screen.getByTestId("interaction-row-exact-speed"),
      "getBoundingClientRect",
    ).mockReturnValue({ left: 0, width: 1_000 } as DOMRect);

    fireEvent.pointerDown(screen.getByTestId("timeline-resize-start-exact-speed"), {
      button: 0,
      clientX: 50,
      pointerId: 1,
    });
    fireEvent.pointerMove(window, { clientX: 100, pointerId: 1 });
    fireEvent.pointerUp(window, { clientX: 100, pointerId: 1 });
    expect(document.replaceInteraction).toHaveBeenNthCalledWith(1, "exact-speed", {
      ...exact,
      trigger: { kind: "at", t: 2 },
      until: { kind: "at", t: 3 },
    });

    fireEvent.pointerDown(screen.getByTestId("timeline-resize-end-exact-speed"), {
      button: 0,
      clientX: 150,
      pointerId: 2,
    });
    fireEvent.pointerMove(window, { clientX: 250, pointerId: 2 });
    fireEvent.pointerUp(window, { clientX: 250, pointerId: 2 });
    expect(document.replaceInteraction).toHaveBeenNthCalledWith(2, "exact-speed", {
      ...exact,
      trigger: { kind: "at", t: 1 },
      until: { kind: "at", t: 5 },
    });
    expect(onSelectInteraction).toHaveBeenCalledWith("exact-speed", "camera-car");
  });

  it("opens a grouped action panel above the right-click and writes through the document authority", () => {
    const document = fixture([]);
    render(<ScenarioTimelineDock document={document as never} state={{ selection: [] } as never} />);

    fireEvent.contextMenu(screen.getByTestId("timeline-interaction-gap-camera-car"), { clientX: 180, clientY: 180 });
    const menu = screen.getByTestId("timeline-context-menu");
    expect(menu.parentElement).toBe(globalThis.document.body);
    expect(menu.getAttribute("data-placement")).toBe("above");
    expect(menu.style.bottom).not.toBe("");
    expect(within(menu).getByText(/Add at/)).not.toBeNull();
    expect(within(menu).getByRole("group", { name: "Speed" })).not.toBeNull();
    expect(within(menu).getByRole("group", { name: "Direction" })).not.toBeNull();
    expect(within(menu).getByRole("group", { name: "Signals" })).not.toBeNull();
    expect(within(menu).getByRole("group", { name: "Actor behavior" })).not.toBeNull();
    expect(screen.getByTestId("timeline-context-canonical-composer")).not.toBeNull();
    fireEvent.click(screen.getByTestId("timeline-context-add-accelerate"));
    expect(document.addInteraction).toHaveBeenCalledOnce();
    expect(document.addInteraction.mock.calls[0]?.[0]).toMatchObject({
      actor: "camera-car",
      trigger: { kind: "at" },
      until: { kind: "at" },
    });
  });

  it("dismisses the interaction panel with Escape or an outside click", () => {
    const document = fixture([]);
    render(<ScenarioTimelineDock document={document as never} state={{ selection: [] } as never} />);

    fireEvent.contextMenu(screen.getByTestId("timeline-interaction-gap-camera-car"), { clientX: 180, clientY: 180 });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("timeline-context-menu")).toBeNull();

    fireEvent.contextMenu(screen.getByTestId("timeline-interaction-gap-camera-car"), { clientX: 180, clientY: 180 });
    fireEvent.pointerDown(globalThis.document.body);
    expect(screen.queryByTestId("timeline-context-menu")).toBeNull();
  });

  it("deletes an actor immediately from the inline timeline action", () => {
    const document = fixture([]);
    render(<ScenarioTimelineDock document={document as never} state={{ selection: [] } as never} />);

    expect(screen.queryByTestId("timeline-add-camera-car-actions")).toBeNull();
    fireEvent.contextMenu(screen.getByTestId("timeline-actor-identity-camera-car"));
    expect(screen.queryByTestId("timeline-context-menu")).toBeNull();
    const deleteButton = screen.getByTestId("timeline-delete-camera-car");
    // The action is always on the identity row, so deleting never needs the
    // context menu that the same right click used to open.
    expect(screen.getByTestId("timeline-actor-identity-camera-car").contains(deleteButton)).toBe(true);
    expect(deleteButton.getAttribute("aria-label")).toBe("Delete actor Sedan 1");
    fireEvent.click(deleteButton);
    expect(document.remove).toHaveBeenCalledWith(["camera-car"]);
  });

  it("preserves direct Follow gap and Become absent context actions with compatible selectors", () => {
    const document = fixture([]);
    render(<ScenarioTimelineDock document={document as never} state={{ selection: [] } as never} />);

    fireEvent.contextMenu(screen.getByTestId("timeline-interaction-gap-camera-car"), { clientX: 180, clientY: 180 });
    fireEvent.click(screen.getByTestId("action-palette-follow-gap"));
    expect(document.addInteraction.mock.calls[0]?.[0]).toMatchObject({
      actor: "camera-car",
      label: "Follow gap",
      verb: "gap",
      target: { role: "npc", value: 2, unit: "time" },
    });

    fireEvent.contextMenu(screen.getByTestId("timeline-interaction-gap-camera-car"), { clientX: 180, clientY: 180 });
    fireEvent.click(screen.getByTestId("action-palette-become-absent"));
    expect(document.addInteraction.mock.calls[1]?.[0]).toMatchObject({
      actor: "camera-car",
      label: "Become absent",
      verb: "exist",
      target: { state: "absent" },
    });
  });

  it("allocates an unused action id after imports or deletion leave the preferred ordinal occupied", () => {
    const collision = { ...exact, id: "accelerate_camera-car_3" } as Interaction;
    const document = fixture([collision, conditional]);
    render(<ScenarioTimelineDock document={document as never} state={{ selection: [] } as never} />);

    fireEvent.contextMenu(screen.getByTestId("interaction-row-accelerate_camera-car_3"), { clientX: 180, clientY: 180 });
    fireEvent.click(screen.getByTestId("timeline-context-add-accelerate"));
    expect(document.addInteraction.mock.calls[0]?.[0]).toMatchObject({ id: "accelerate_camera-car_4" });
  });

  it("does not write a no-movement drag into undo/autosave history", () => {
    const document = fixture([exact]);
    render(<ScenarioTimelineDock document={document as never} state={{ selection: [] } as never} />);
    const body = screen.getByTestId("interaction-expand-exact-speed");
    fireEvent.click(body);
    fireEvent.pointerDown(body, { button: 0, clientX: 100 });
    fireEvent.pointerUp(window, { clientX: 100 });
    expect(document.replaceInteraction).not.toHaveBeenCalled();
  });

  it("routes locked conditional clips to the shared overlay authority", () => {
    const document = fixture([conditional]);
    const onSelectInteraction = vi.fn();
    render(
      <ScenarioTimelineDock
        document={document as never}
        onSelectInteraction={onSelectInteraction}
        state={{ selection: [] } as never}
      />,
    );
    fireEvent.click(screen.getByTestId("interaction-expand-conditional-brake"));
    expect(onSelectInteraction).toHaveBeenCalledWith("conditional-brake", "camera-car");
    expect(screen.queryByTestId("interaction-inspector-conditional-brake")).toBeNull();
  });

  it("clears transient context state when the document instance changes", () => {
    const first = fixture([exact]);
    const second = fixture([exact]);
    const { rerender } = render(
      <ScenarioTimelineDock document={first as never} state={{ selection: [] } as never} />,
    );
    fireEvent.contextMenu(screen.getByTestId("interaction-row-exact-speed"), { clientX: 180, clientY: 180 });
    expect(screen.getByTestId("timeline-context-menu")).not.toBeNull();

    rerender(<ScenarioTimelineDock document={second as never} state={{ selection: [] } as never} />);
    expect(screen.queryByTestId("timeline-context-menu")).toBeNull();
  });
});

describe("existing semantic geometry", () => {
  it("keeps exact/armed/open-ended semantics while using the V1 visual lane", () => {
    const { rerender } = render(
      <InteractionTrack
        resolved={{ range: { startMs: 1000, endMs: 3000 }, armed: false, openEnded: false } as never}
        window={{ startMs: 0, endMs: 10000 }}
      />,
    );
    expect(screen.getByTestId("interaction-track").lastElementChild?.getAttribute("data-armed")).toBe("false");

    rerender(
      <InteractionTrack
        resolved={{ range: { startMs: 1000, endMs: 3000 }, armed: true, openEnded: true } as never}
        window={{ startMs: 0, endMs: 10000 }}
      />,
    );
    expect(screen.getByTestId("interaction-track").lastElementChild?.getAttribute("data-armed")).toBe("true");
    expect(screen.getByTestId("interaction-track").lastElementChild?.getAttribute("data-open-ended")).toBe("true");

    render(<TimelineRuler choreography={{ warmupSeconds: 2, clipSeconds: 10, interactions: [] } as never} />);
    expect(screen.getByTestId("timeline-ruler")).not.toBeNull();
  });
});
