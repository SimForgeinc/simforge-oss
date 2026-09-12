"use client";

import { useEffect } from "react";
import * as stylex from "@stylexjs/stylex";
import { Video } from "lucide-react";
import { C } from "./map-layer-constants";
import { styles } from "./map-canvas.stylex";
import {
  useMapViewModeStore,
  useSelectionStore,
  type MapViewMode,
} from "@/app/lib/scenario-editor/stores";

/**
 * The 2D / 3D switch.
 *
 * It lives in the map's own control cluster rather than in the authoring
 * panels, because it answers "how am I looking at this map" rather than "what
 * am I authoring" — the same distinction that put Map/Satellite there.
 *
 * Bottom-RIGHT specifically: bottom-left is the basemap switch and the centre
 * is where the "Loading geometry…" pill appears. The measure button is the only
 * other bottom-right control and the two never appear together (measure is the
 * map detail page, this is the editor).
 *
 * `Shift+D` toggles it. This gets pressed constantly once it exists, and a
 * modifier keeps it clear of the single-letter tool shortcuts.
 */

const MODES: Array<{ mode: MapViewMode; label: string; hint: string }> = [
  { mode: "2d", label: "2D", hint: "Flat top-down authoring view" },
  { mode: "3d", label: "3D", hint: "Orbit the scene with real vehicle and signal models" },
  {
    mode: "twin",
    label: "3D Twin",
    hint: "The streamed 3D digital twin of this map, with authored actors placed in it",
  },
];

export function MapViewModeToggle({
  loading = false,
  disabled = false,
}: {
  /** True while the 3D renderer chunk is still in flight. */
  loading?: boolean;
  disabled?: boolean;
}) {
  const mode = useMapViewModeStore((state) => state.mode);
  const setMode = useMapViewModeStore((state) => state.setMode);
  const toggleMode = useMapViewModeStore((state) => state.toggleMode);
  const hydrateFromStorage = useMapViewModeStore((state) => state.hydrateFromStorage);
  const followSelectedActor = useMapViewModeStore((state) => state.followSelectedActor);
  const twinEnabled = useMapViewModeStore((state) => state.twinEnabled);
  const setFollowSelectedActor = useMapViewModeStore(
    (state) => state.setFollowSelectedActor,
  );
  const selectedActorId = useSelectionStore((state) => state.selectedActorId);

  useEffect(() => {
    hydrateFromStorage();
  }, [hydrateFromStorage]);

  useEffect(() => {
    if (disabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key !== "D" && event.key !== "d") return;
      const target = event.target as HTMLElement | null;
      // Never steal a keystroke from a field the author is typing into.
      if (
        target &&
        (target.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
      ) {
        return;
      }
      event.preventDefault();
      toggleMode();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [disabled, toggleMode]);

  return (
    <div
      data-testid="map-view-mode-toggle"
      data-map-view-mode={mode}
      {...stylex.props(styles.control, styles.modeControl)}
      style={{ border: `1px solid ${C.border}`, opacity: disabled ? 0.5 : 1, pointerEvents: disabled ? "none" : "auto" }}
    >
      {/*
        The twin is opt-in from Settings, and until then it is not drawn at all
        rather than drawn disabled. It is unfinished — a tile stream that most
        often shows an empty scene — and a greyed-out button reads as a broken
        feature, while an absent one reads as a feature that does not exist yet.
      */}
      {MODES.filter((option) => option.mode !== "twin" || twinEnabled).map((option) => {
        const isActive = option.mode === mode;
        const isPending = isActive && option.mode === "3d" && loading;
        return (
          <button
            key={option.mode}
            type="button"
            aria-label={`${option.label} view — ${option.hint}`}
            aria-pressed={isActive}
            data-testid={`map-view-mode-${option.mode}`}
            disabled={disabled}
            onClick={() => setMode(option.mode)}
            title={
              option.mode === "3d"
                ? `${option.hint} (Shift+D)`
                : `${option.hint} (Shift+D)`
            }
            {...stylex.props(styles.modeButton)}
            style={{
              fontWeight: isActive ? 600 : 400,
              cursor: isActive ? "default" : "pointer",
              background: isActive ? C.fg : `${C.bg}f2`,
              color: isActive ? C.bg : C.fg,
            }}
          >
            {option.label}
            {isPending ? (
              <span
                aria-hidden
                data-testid="map-view-mode-loading"
                {...stylex.props(styles.spinner)}
                style={{ border: `1.5px solid ${C.bg}`, borderTopColor: "transparent" }}
              />
            ) : null}
          </button>
        );
      })}
      {/*
        The follow camera, ported from the retired docked 3D panel — the one
        capability the map did not already have. It only exists in 3D (a
        follow camera on a locked flat map is just a pan) and only bites when
        an actor is selected, which is exactly what the panel's own toggle did.
      */}
      {mode === "3d" ? (
        <button
          aria-label={
            selectedActorId
              ? followSelectedActor
                ? "Stop following the selected actor"
                : "Follow the selected actor"
              : "Select an actor to follow it"
          }
          aria-pressed={followSelectedActor}
          data-testid="map-view-follow-toggle"
          disabled={!selectedActorId}
          title={
            selectedActorId
              ? followSelectedActor
                ? "Following selected actor"
                : "Follow selected actor"
              : "Select an actor to follow it"
          }
          type="button"
          onClick={() => setFollowSelectedActor(!followSelectedActor)}
          {...stylex.props(styles.modeFollow)}
          style={{
            borderLeft: `1px solid ${C.border}`,
            background: followSelectedActor ? C.fg : `${C.bg}f2`,
            color: followSelectedActor ? C.bg : C.fg,
            opacity: selectedActorId ? 1 : 0.4,
            cursor: selectedActorId ? "pointer" : "not-allowed",
          }}
        >
          <Video aria-hidden {...stylex.props(styles.icon13)} />
        </button>
      ) : null}
      <style>{`
        @keyframes mapViewModeSpin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}

export default MapViewModeToggle;
