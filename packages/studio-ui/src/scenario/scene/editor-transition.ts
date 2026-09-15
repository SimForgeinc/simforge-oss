"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Cross-fade between the coverage map, the loading surface and the 3D world.
 *
 * Short on purpose: it covers the swap of two opaque surfaces, so anything
 * longer reads as a stall rather than as a transition. The camera moves either
 * side of it take much longer — the world's own zoom-in, and the coverage
 * map's ~1.6s ease — and are the parts the eye actually follows.
 */
export const EDITOR_COVER_FADE_MS = 300;

/**
 * Where the datasets workspace is between browsing and editing.
 *
 * - `map` — the coverage map is the surface. No CityViewer exists.
 * - `focusing` — the map is flying to the scenario's map footprint.
 * - `covering` — the loading surface is fading in over the focused map.
 * - `world` — the world and the editor are mounted behind the cover.
 * - `editing` — the cover has lifted; the editor owns the surface.
 * - `releasing` — the loading surface is fading in over the editor.
 * - `defocusing` — the world is released and the map is flying back out.
 */
export type EditorTransitionPhase =
  | "map"
  | "focusing"
  | "covering"
  | "world"
  | "editing"
  | "releasing"
  | "defocusing";

export type EditorTransition = {
  readonly phase: EditorTransitionPhase;
  /** The coverage map's requested camera target. */
  readonly focus: { mapVersionId: string } | null;
  /** Whether the CityViewer world and the editor may be mounted. */
  readonly worldMounted: boolean;
  /** Whether the loading surface is in the tree at all. */
  readonly coverMounted: boolean;
  /** Whether it is opaque; false during its own fade in or out. */
  readonly coverVisible: boolean;
  /** Hand back to the transition when the coverage map's camera settles. */
  readonly onFocusSettled: () => void;
};

/**
 * The enter and exit choreography of the scenario editor.
 *
 * The world is mounted for exactly the phases that show it, which is the whole
 * point: browsing a dataset holds no WebGL context, no streamed city and no
 * actor renderer. Every step waits for the step before it to be observable —
 * the map's camera settling, the cover's fade, the editor reporting its map
 * fully loaded — so nothing pops in over a surface that is still moving.
 *
 * `requestedMapVersionId` is null when the requested document's map is not
 * known yet (a cold reload straight into `?document=`): there is no footprint
 * to fly to and no map on screen to fly it in, so the cover goes up directly.
 */
export function useEditorTransition({
  editing,
  requestedMapVersionId,
  worldReady,
}: {
  /** Whether a document is open for editing. */
  editing: boolean;
  /** The map version the open document authors on, when known. */
  requestedMapVersionId: string | null;
  /** The editor's chrome is up and its map models are fully loaded. */
  worldReady: boolean;
}): EditorTransition {
  const [phase, setPhase] = useState<EditorTransitionPhase>("map");
  const [focusMapVersionId, setFocusMapVersionId] = useState<string | null>(null);
  const [coverMounted, setCoverMounted] = useState(false);
  const coverVisible =
    phase === "covering" || phase === "world" || phase === "releasing" || phase === "defocusing";

  useEffect(() => {
    if (coverVisible) {
      setCoverMounted(true);
      return;
    }
    if (!coverMounted) return;
    // Keep it in the tree for its own fade out, then drop it: an invisible
    // cover left mounted is a surface nothing can see but everything paints.
    const timer = window.setTimeout(() => setCoverMounted(false), EDITOR_COVER_FADE_MS);
    return () => window.clearTimeout(timer);
  }, [coverMounted, coverVisible]);

  const enter = phase === "covering";
  const exit = phase === "releasing";
  useEffect(() => {
    if (!enter && !exit) return;
    const timer = window.setTimeout(() => {
      if (enter) {
        setPhase("world");
        return;
      }
      setFocusMapVersionId(null);
      setPhase("defocusing");
    }, EDITOR_COVER_FADE_MS);
    return () => window.clearTimeout(timer);
  }, [enter, exit]);

  useEffect(() => {
    if (editing) {
      if (phase === "map") {
        setFocusMapVersionId(requestedMapVersionId);
        setPhase(requestedMapVersionId ? "focusing" : "covering");
        return;
      }
      // Re-entering while the exit is still running: the world is already gone,
      // so restart from the map rather than reviving a half-released session.
      if (phase === "defocusing" && focusMapVersionId === null) setPhase("map");
      if (phase === "releasing") setPhase(focusMapVersionId ? "editing" : "covering");
      if (phase === "world" && worldReady) setPhase("editing");
      return;
    }
    if (phase === "world" || phase === "editing") {
      setPhase("releasing");
      return;
    }
    if (phase === "focusing" || phase === "covering") {
      if (focusMapVersionId === null) {
        setPhase("map");
        return;
      }
      setFocusMapVersionId(null);
      setPhase("defocusing");
    }
  }, [editing, focusMapVersionId, phase, requestedMapVersionId, worldReady]);

  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const onFocusSettled = useCallback(() => {
    if (phaseRef.current === "focusing") setPhase("covering");
    else if (phaseRef.current === "defocusing") setPhase("map");
  }, []);

  return {
    phase,
    focus: focusMapVersionId ? { mapVersionId: focusMapVersionId } : null,
    worldMounted: phase === "world" || phase === "editing" || phase === "releasing",
    coverMounted,
    coverVisible,
    onFocusSettled,
  };
}
