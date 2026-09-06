import { describe, expect, it, vi } from "vitest";
import type { EditorController, EditorDocument } from "@simforge-oss/editor"

import { configureCustomRouteAtClipStart } from "../../../../src/scenario/editor/custom-route-configuration"

describe("configureCustomRouteAtClipStart", () => {
  it("resets a stale timed route with missing points instead of entering editor-core with invalid data", () => {
    const beginCustomRouteAuthoring = vi.fn(() => true);
    const document = {
      data: {
        choreography: {
          clipSeconds: 10,
          warmupSeconds: 0,
          interactions: [{
            id: "stale_route",
            actor: "ego",
            trigger: { kind: "at", t: 0 },
            until: { kind: "at", t: 10 },
            verb: "route",
            target: { mode: "customTimedRoute" },
          }],
        },
      },
      actor: vi.fn(() => ({ x: 3, z: 4, headingRad: 0.5 })),
    } as unknown as EditorDocument;
    const playback = {
      pause: vi.fn(),
      seek: vi.fn(),
      currentActors: [],
    };

    const result = configureCustomRouteAtClipStart({
      document,
      controller: {
        setPlaybackInspection: vi.fn(),
        beginCustomRouteAuthoring,
      } as unknown as EditorController,
      playback,
      setInspecting: vi.fn(),
      interactionId: "stale_route",
    });

    expect(result).toEqual({ configured: true, startS: 0 });
    expect(beginCustomRouteAuthoring).toHaveBeenCalledWith("stale_route", {
      reset: true,
      startPose: { x: 3, z: 4, headingRad: 0.5 },
    });
  });

  it("resets the stationary placeholder armed for a newly placed movable actor", () => {
    const beginCustomRouteAuthoring = vi.fn(() => true);
    const document = {
      data: {
        choreography: {
          clipSeconds: 10,
          warmupSeconds: 0,
          interactions: [{
            label: "Simple timed route",
            id: "simple_timed_route_walker",
            actor: "walker",
            trigger: { kind: "at", t: 0 },
            until: { kind: "at", t: 10 },
            verb: "route",
            target: {
              mode: "customTimedRoute",
              points: [
                { timeS: 0, x: 12.5, z: -4 },
                { timeS: 1, x: 12.5, z: -4 },
              ],
            },
          }],
        },
      },
      actor: vi.fn(() => ({ x: 12.5, z: -4, headingRad: 1.25 })),
    } as unknown as EditorDocument;

    configureCustomRouteAtClipStart({
      document,
      controller: {
        setPlaybackInspection: vi.fn(),
        beginCustomRouteAuthoring,
      } as unknown as EditorController,
      playback: {
        pause: vi.fn(),
        seek: vi.fn(),
        currentActors: [],
      },
      setInspecting: vi.fn(),
      interactionId: "simple_timed_route_walker",
    });

    expect(beginCustomRouteAuthoring).toHaveBeenCalledWith("simple_timed_route_walker", {
      reset: true,
      startPose: { x: 12.5, z: -4, headingRad: 1.25 },
    });
  });
});
