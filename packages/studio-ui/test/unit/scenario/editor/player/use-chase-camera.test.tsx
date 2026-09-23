// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PerspectiveCamera, Vector3 } from "three";
import type { SampledActor } from "@simforge-oss/playback";

import {
  chaseSubjectFor,
  useChaseCamera,
  type ChaseCameraInput,
} from "../../../../../src/scenario/editor/player/use-chase-camera";
import { chaseTrailAngleDeg } from "../../../../../src/scenario/editor/player/chase-camera";

afterEach(cleanup);

const DIMS = { l: 4.6, w: 1.9, h: 1.5 };

function sampled(id: string, overrides: Partial<SampledActor> = {}): SampledActor {
  return {
    id,
    catalogId: "vehicle.sedan" as SampledActor["catalogId"],
    dims: DIMS,
    x: 0,
    z: 0,
    headingRad: 0,
    speedMps: 8,
    present: true,
    static: false,
    motionDirection: 1,
    ...overrides,
  };
}

/** Just enough viewer for the hook: a camera, controls and the per-frame hook slot. */
function fakeViewer() {
  const canvas = document.createElement("canvas");
  canvas.getBoundingClientRect = () => ({
    left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}),
  });
  const camera = new PerspectiveCamera(55, 800 / 600, 0.1, 2000);
  camera.position.set(0, 60, 60);
  camera.lookAt(0, 0, 0);
  const views: Array<{ eye: Vector3; target: Vector3 }> = [];
  const viewer = {
    camera,
    renderer: { domElement: canvas },
    onFrame: null as ((dt: number) => void) | null,
    controls: {
      getView: () => ({ position: [0, 60, 60] as const, target: [0, 0, 0] as const, fov: 55 }),
      setView: vi.fn((eye: Vector3, target: Vector3) => {
        views.push({ eye: eye.clone(), target: target.clone() });
        camera.position.copy(eye);
        camera.lookAt(target);
      }),
      setEnabled: vi.fn(),
    },
  };
  return { viewer, canvas, camera, views };
}

function setup(actors: SampledActor[], overrides: Partial<ChaseCameraInput> = {}) {
  const { viewer, canvas, camera, views } = fakeViewer();
  const playback = { currentActors: actors };
  const hook = renderHook((props: ChaseCameraInput) => useChaseCamera(props), {
    initialProps: {
      viewer: viewer as unknown as ChaseCameraInput["viewer"],
      renderer: null,
      playback,
      enabled: true,
      sampleHeight: () => 0,
      ...overrides,
    },
  });
  return { hook, viewer, canvas, camera, views, playback };
}

/** Where `actor` lands on the fake 800×600 canvas. */
function screenOf(camera: PerspectiveCamera, actor: SampledActor): { x: number; y: number } {
  camera.updateMatrixWorld();
  const projected = new Vector3(actor.x, actor.dims.h * 0.5, actor.z).project(camera);
  return { x: (projected.x + 1) * 400, y: (1 - projected.y) * 300 };
}

function click(canvas: HTMLCanvasElement, x: number, y: number) {
  canvas.dispatchEvent(new PointerEvent("pointerdown", { button: 0, pointerId: 1, clientX: x, clientY: y, bubbles: true }));
  canvas.dispatchEvent(new PointerEvent("pointerup", { button: 0, pointerId: 1, clientX: x, clientY: y, bubbles: true }));
}

describe("chase subject", () => {
  it("prefers the playback sample, then whatever the renderer draws", () => {
    const view = { id: "sumo:0a1b2c3d", catalogId: "vehicle.sedan", x: 7, y: 1, z: -2, headingRad: 1, dims: DIMS, speedMps: 5, reversing: true };
    const renderer = { actorView: (id: string) => (id === view.id ? view : null) };
    const playback = { currentActors: [sampled("ego", { x: 3, headingRad: 0.5 }), sampled("gone", { present: false })] };
    expect(chaseSubjectFor("ego", playback, renderer as never, () => 2)).toMatchObject({ x: 3, y: 2, headingRad: 0.5, speedMps: 8 });
    expect(chaseSubjectFor(view.id, playback, renderer as never, () => 0)).toMatchObject({ x: 7, y: 1, headingRad: 1, motionDirection: -1 });
    expect(chaseSubjectFor("gone", playback, renderer as never, () => 0)).toBeNull();
    expect(chaseSubjectFor("nobody", playback, null, () => 0)).toBeNull();
  });
});

describe("useChaseCamera", () => {
  it("rides behind the chased actor from the viewer's frame hook, with orbit input suspended", () => {
    const actor = sampled("ego", { x: 10, z: -4, headingRad: 0.8 });
    const { hook, viewer, views } = setup([actor]);

    act(() => {
      expect(hook.result.current.chase("ego")).toBe(true);
    });
    expect(hook.result.current.chasedActorId).toBe("ego");
    expect(viewer.controls.setEnabled).toHaveBeenLastCalledWith(false);
    expect(viewer.onFrame).toBeTypeOf("function");

    // Past the ease-in, the camera sits behind the actor's heading.
    for (let frame = 0; frame < 90; frame += 1) viewer.onFrame!(1 / 60);
    const last = views.at(-1)!;
    expect(chaseTrailAngleDeg({ x: last.eye.x, z: last.eye.z }, { x: 10, z: -4, headingRad: 0.8 })).toBeLessThan(0.5);
    expect(last.eye.y).toBeGreaterThan(DIMS.h);
  });

  it("lets go on release: Escape's first press frees the camera, the second finds nothing to free", () => {
    const { hook, viewer } = setup([sampled("ego")]);
    const previousHook = vi.fn();
    viewer.onFrame = previousHook;
    act(() => {
      hook.result.current.chase("ego");
    });
    // The hook chains whatever frame hook was installed before it.
    viewer.onFrame!(1 / 60);
    expect(previousHook).toHaveBeenCalledOnce();

    let released = false;
    act(() => {
      released = hook.result.current.release();
    });
    expect(released).toBe(true);
    expect(hook.result.current.chasedActorId).toBeNull();
    expect(viewer.onFrame).toBe(previousHook);
    expect(viewer.controls.setEnabled).toHaveBeenLastCalledWith(true);
    act(() => {
      released = hook.result.current.release();
    });
    expect(released).toBe(false);
  });

  it("chases the actor under a click and returns to the free camera on empty ground", () => {
    const actors = [sampled("left", { x: -8 }), sampled("right", { x: 8 })];
    const { hook, canvas, camera } = setup(actors);

    const right = screenOf(camera, actors[1]!);
    act(() => click(canvas, right.x + 4, right.y - 3));
    expect(hook.result.current.chasedActorId).toBe("right");

    act(() => click(canvas, 5, 5));
    expect(hook.result.current.chasedActorId).toBeNull();
  });

  it("treats a drag as camera work, not a pick", () => {
    const actors = [sampled("ego")];
    const { hook, canvas, camera } = setup(actors);
    const at = screenOf(camera, actors[0]!);
    act(() => {
      canvas.dispatchEvent(new PointerEvent("pointerdown", { button: 0, pointerId: 1, clientX: at.x, clientY: at.y }));
      canvas.dispatchEvent(new PointerEvent("pointerup", { button: 0, pointerId: 1, clientX: at.x + 40, clientY: at.y }));
    });
    expect(hook.result.current.chasedActorId).toBeNull();
  });

  it("hands the camera back when the player exits", () => {
    const { hook, viewer } = setup([sampled("ego")]);
    act(() => {
      hook.result.current.chase("ego");
    });
    hook.rerender({
      viewer: viewer as never,
      renderer: null,
      playback: { currentActors: [sampled("ego")] },
      enabled: false,
      sampleHeight: () => 0,
    });
    expect(hook.result.current.chasedActorId).toBeNull();
    expect(viewer.onFrame).toBeNull();
    expect(viewer.controls.setEnabled).toHaveBeenLastCalledWith(true);
  });

  it("refuses to chase an actor that has no pose, and holds still while a chased one is absent", () => {
    const actors = [sampled("ego")];
    const { hook, viewer, views, playback } = setup(actors);
    act(() => {
      expect(hook.result.current.chase("ghost")).toBe(false);
    });
    expect(hook.result.current.chasedActorId).toBeNull();

    act(() => {
      hook.result.current.chase("ego");
    });
    viewer.onFrame!(1 / 60);
    const count = views.length;
    playback.currentActors = [sampled("ego", { present: false })];
    viewer.onFrame!(1 / 60);
    expect(views).toHaveLength(count);
  });
});
