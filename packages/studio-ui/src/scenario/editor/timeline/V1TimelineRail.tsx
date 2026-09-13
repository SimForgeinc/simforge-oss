"use client";

import {
  AlertTriangle,
  Box,
  BrainCircuit,
  CarFront,
  Clock3,
  Globe2,
  Lock,
  PersonStanding,
  Plus,
  Route as RouteIcon,
  Trash2,
  TrafficCone,
  Zap,
} from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { newTemplateId, type Interaction, type ReasoningTraceSegment } from "@simforge-oss/scenario";

import {
  actionsForActor,
  interactionForAction,
  setExclusiveCustomTimedRoute,
  type ActionDefinition,
  type EditorDocument,
  type EditorState,
} from "@simforge-oss/editor";
import {
  getEntry,
  isCatalogId,
  type CatalogId,
} from "@simforge-oss/asset-catalog";
import {
  carlaCompatibilityFor,
  loadCarlaCompatibility,
  type CarlaCompatibility,
  type CarlaCompatibilityTable,
} from "../../../lib/scenario/carla-compatibility";
import type { SignalTimelineBand } from "../../../lib/scenario/signals";
import {
  choreographyWindow,
  rangePercent,
  resolveInteractionLayout,
  snapToTimeGrid,
  type ResolvedInteraction,
  type TimelineRange,
} from "../../../lib/scenario/timeline";
import { indicationLabel, indicationSwatch } from "../signals/indication-style";
import {
  OBJECT_CATALOG_IDS,
  ObjectCatalogIcon,
  type ObjectCatalogId,
} from "../regions/ObjectCatalogIcon";
import {
  PEDESTRIAN_CATALOG_IDS,
  PedestrianCatalogIcon,
  type PedestrianCatalogId,
} from "../regions/PedestrianCatalogIcon";
import {
  VEHICLE_CATALOG_IDS,
  VehicleCatalogIcon,
  type VehicleCatalogId,
} from "../regions/VehicleCatalogIcon";
import { DynamicActorCatalogIcon, isDynamicActorCatalogId } from '../regions/DynamicActorCatalogIcon';
import { cn } from "../../../lib/utils";
import { isUnconfiguredSimpleTimedRoute } from "../simple-route-status";
import { isCustomTimedRoute } from "../simple-timed-routes";
import { TimelineCarlaCompatibilityMarker } from "./TimelineCarlaCompatibilityMarker";
import { TimelineRuler } from "./TimelineRuler";
import { TimelineTransportControls } from "./TimelineTransportControls";
import {
  buildTimelineCues,
  timelineCauseLabel,
  timelineConflictMessage,
  type TimelineCue,
} from "./timeline-cues";
import {
  authoredTimelineRange,
  authoredTimelineRangesEqual,
  editAuthoredTimelineRange,
  interactionWithAuthoredTimelineRange,
  packTimelineInteractionRows,
  timelineTimeFromClientX,
  uniqueTimelineInteractionId,
  type AuthoredTimelineRange,
  type TimelineClipEditMode,
} from "./v1-timeline-model";
import {
  TIMELINE_GLASS_SURFACE_STYLE,
  TimelineGlassBackdrop,
} from "./TimelineGlassSurface";
import {
  type TrafficLightAuthoring,
} from "../inspector/TrafficLightDetailsPanel";
import { EditorDetailsPanel } from "../inspector/EditorDetailsPanel";
import { CanonicalInteractionComposer } from "./CanonicalInteractionComposer";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./V1TimelineRail.stylex";
import { motionStyles } from "../../../stylex/motion.stylex";

type Role = EditorDocument["data"]["roles"][number];

/** One stable controller-stage lane. Selection may highlight it, never redefine it. */
export type V1TimelineSignalLane = {
  readonly junctionId: string;
  readonly controllerId: string;
  readonly headIds: readonly string[];
  readonly bands: readonly SignalTimelineBand[];
  readonly referenceHeadId: string;
  readonly onRemoveControl?: () => void;
};

export type V1TimelineSignalAuthoring = TrafficLightAuthoring;

/** Canonical browser simulation transport shared with the scenario list. */
export type V1TimelineBrowserPlayback = {
  readonly sessionId: string;
  readonly playing: boolean;
  readonly inspecting: boolean;
  readonly time: number;
  readonly crashes?: readonly V1TimelineCrashMarker[];
  readonly onPlay: () => void;
  readonly onStop: () => void;
  readonly onReset: () => void;
  readonly onPlayPause: () => void;
  readonly onSeek: (time: number) => void;
  readonly onExitInspection: () => void;
};

export type V1TimelineCrashMarker = {
  readonly timeS: number;
  readonly actorLabels: readonly string[];
};

export type V1TimelineRailProps = {
  document: EditorDocument;
  state?: Pick<EditorState, "selection" | "mode"> | null;
  signalLanes?: readonly V1TimelineSignalLane[];
  signalAuthoring?: V1TimelineSignalAuthoring | null;
  playback?: V1TimelineBrowserPlayback | null;
  selectedInteractionId?: string | null;
  onSelectActor?: (actorId: string) => void;
  onFocusActor?: (actorId: string) => void;
  onFocusSignal?: (headId: string) => void;
  onSelectInteraction?: (interactionId: string, actorId: string) => void;
  onClearSelection?: () => void;
  onSelectSignal?: (headId: string) => void;
  disableInteractionCreation?: boolean;
  lockSimpleTimedRoutes?: boolean;
  readOnly?: boolean;
};

type ContextMenuState = {
  actorId: string;
  timeS: number;
  anchorX: number;
  anchorY: number;
};

type ClipPreview = { interactionId: string; range: AuthoredTimelineRange };


const TIMELINE_HEADER_HEIGHT_PX = 48;
const TIMELINE_LANE_HEIGHT_PX = 40;
const TIMELINE_EMPTY_BODY_HEIGHT_PX = 120;
const TIMELINE_MIN_HEIGHT_PX = 168;
const TIMELINE_DEFAULT_MAX_HEIGHT_PX = 300;
const TIMELINE_RESIZE_MAX_HEIGHT_PX = 520;

export function timelineContentHeightPx(visibleLaneRows: number): number {
  return TIMELINE_HEADER_HEIGHT_PX + Math.max(
    TIMELINE_EMPTY_BODY_HEIGHT_PX,
    Math.max(0, visibleLaneRows) * TIMELINE_LANE_HEIGHT_PX,
  );
}

export function timelineDefaultHeightPx(visibleLaneRows: number): number {
  return Math.min(
    TIMELINE_DEFAULT_MAX_HEIGHT_PX,
    Math.max(
      TIMELINE_MIN_HEIGHT_PX,
      timelineContentHeightPx(visibleLaneRows),
    ),
  );
}

export function clampTimelineHeightPx(height: number, viewportHeight: number): number {
  const maxHeight = Math.max(
    TIMELINE_MIN_HEIGHT_PX,
    Math.min(TIMELINE_RESIZE_MAX_HEIGHT_PX, Math.round(viewportHeight * 0.65)),
  );
  return Math.max(TIMELINE_MIN_HEIGHT_PX, Math.min(maxHeight, Math.round(height)));
}

/**
 * The name column and the time track share one row.
 *
 * The column sizes itself to its own contents — the widest lane's icon, label
 * and row actions — so a name is never clipped and the icons never crowd it. A
 * drag on the divider overrides that with an explicit width; double-pressing the
 * divider drops the override and returns to fitting.
 *
 * Fitting is measured in JS rather than expressed as a `max-content` grid track
 * because each lane is its own grid. Per-grid `max-content` would give every
 * lane a different column width and the lanes would no longer line up. One
 * measured value published through `--timeline-identity-width` on the rail is
 * what keeps the header, every lane, the divider and the playhead offset in
 * agreement.
 */
const IDENTITY_DEFAULT_WIDTH_PX = 114;
const IDENTITY_MIN_WIDTH_PX = 72;
const IDENTITY_MAX_WIDTH_PX = 420;
/** Time track floor: a name column may never squeeze the clips out of view. */
const TRACK_MIN_WIDTH_PX = 220;
const IDENTITY_WIDTH_VAR = "--timeline-identity-width";
/** Two presses inside this window are a reset, not a drag. */
const SPLIT_RESET_WINDOW_MS = 350;
const IDENTITY_GRID_COLUMNS = `var(${IDENTITY_WIDTH_VAR}) minmax(0, 1fr)`;
/** Marks the unshrinkable content row inside each identity cell. */
const IDENTITY_CONTENT_ATTR = "data-timeline-identity-content";
/**
 * Breathing room added to the widest measured content row.
 *
 * The content rows carry their own `px-2` gutters, so this is not padding — it
 * is the margin that keeps a label from ending flush against the divider, plus
 * a pixel of slack for sub-pixel text measurement rounding down.
 */
const IDENTITY_CONTENT_SLACK_PX = 9;

export function clampTimelineIdentityWidthPx(width: number, railWidth: number): number {
  const trackAllowance = Math.max(0, Math.round(railWidth) - TRACK_MIN_WIDTH_PX);
  const maxWidth = Math.max(
    IDENTITY_MIN_WIDTH_PX,
    Math.min(IDENTITY_MAX_WIDTH_PX, trackAllowance),
  );
  return Math.max(IDENTITY_MIN_WIDTH_PX, Math.min(maxWidth, Math.round(width)));
}

/** Anything whose laid-out width can be read. */
export type MeasurableRow = { getBoundingClientRect(): { width: number } };

/**
 * The width that shows every identity cell's content in full.
 *
 * Each cell's content row is laid out at `max-content` and therefore overflows
 * its cell while the column is too narrow, which is exactly what makes it
 * measurable: the reported width is what the content wants, not what the column
 * currently allows. Returns `null` when nothing is mounted or nothing has been
 * laid out yet, so a caller keeps its previous width instead of collapsing to
 * the minimum for a frame.
 */
export function fittedTimelineIdentityWidthPx(
  rows: Iterable<MeasurableRow>,
  railWidth: number,
): number | null {
  let widest = 0;
  for (const row of rows) {
    widest = Math.max(widest, row.getBoundingClientRect().width);
  }
  if (widest <= 0) return null;
  return clampTimelineIdentityWidthPx(Math.ceil(widest) + IDENTITY_CONTENT_SLACK_PX, railWidth);
}

const REASONING_TRACE_LANE_EXTENSION = "studio.presentation.reasoningTraceLane";

export function V1TimelineRail({
  document,
  state,
  signalLanes = [],
  playback = null,
  selectedInteractionId = null,
  onSelectActor,
  onFocusActor,
  onFocusSignal,
  onSelectInteraction,
  onClearSelection,
  onSelectSignal,
  disableInteractionCreation = false,
  lockSimpleTimedRoutes = false,
  readOnly = false,
}: V1TimelineRailProps) {
  const railRef = useRef<HTMLElement>(null);
  const [authoringTime, setAuthoringTime] = useState(0);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [preview, setPreview] = useState<ClipPreview | null>(null);
  const [manualHeight, setManualHeight] = useState<number | null>(null);
  // `null` means "fit the content"; a number is an explicit width the user dragged.
  const [manualIdentityWidth, setManualIdentityWidth] = useState<number | null>(null);
  const [fittedIdentityWidth, setFittedIdentityWidth] = useState(IDENTITY_DEFAULT_WIDTH_PX);
  const identityWidth = manualIdentityWidth ?? fittedIdentityWidth;
  const splitDragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const splitResetRef = useRef(0);
  const [draggedPlayheadTime, setDraggedPlayheadTime] = useState<number | null>(null);
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const resizeDragRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const playheadDragRef = useRef<number | null>(null);
  const trackScrubRef = useRef<{ pointerId: number; track: HTMLElement } | null>(null);
  const [carlaTable, setCarlaTable] = useState<CarlaCompatibilityTable | null>(null);

  const { choreography } = document.data;
  const windowRange = useMemo(() => choreographyWindow(choreography), [choreography]);
  const layout = useMemo(() => resolveInteractionLayout(document.data), [document.data]);
  const timelineCues = useMemo(() => buildTimelineCues(document.data), [document.data]);
  const rowsByActor = useMemo(() => {
    const byActor = new Map<string, ResolvedInteraction[]>();
    for (const item of layout) {
      const actorItems = byActor.get(item.actor) ?? [];
      actorItems.push(item);
      byActor.set(item.actor, actorItems);
    }
    return new Map([...byActor].map(([actorId, items]) => [actorId, packTimelineInteractionRows(items)]));
  }, [layout]);
  const worldRows = useMemo(
    () => packTimelineInteractionRows(layout.filter((item) => item.actor === "@world")),
    [layout],
  );
  const hasWorldInteractions = worldRows.some((row) => row.length > 0);
  const sensorSubjectId = document.data.roles.find(
    (role) => role.actor.sensors.length > 0,
  )?.id;
  const reasoningTraceEnabled = Boolean(
    sensorSubjectId && (
      document.data.reasoningTrace.length > 0 ||
      document.data.extensions?.[REASONING_TRACE_LANE_EXTENSION] === true
    ),
  );
  const actorLabels = timelineActorLabels(document.data.roles);
  const carlaCompatibilityByActor = useMemo(() => {
    if (!carlaTable) return null;
    const compatibilityByActor = new Map<string, CarlaCompatibility>();
    for (const role of document.data.roles) {
      if (!role.actor.catalogId) continue;
      compatibilityByActor.set(
        role.id,
        carlaCompatibilityFor(role.actor.catalogId, carlaTable),
      );
    }
    return compatibilityByActor;
  }, [carlaTable, document.data.roles]);
  const visibleLaneRows = signalLanes.length
    + (hasWorldInteractions ? Math.max(1, worldRows.length) : 0)
    + document.data.roles.reduce(
      (count, role) => count + Math.max(1, rowsByActor.get(role.id)?.length ?? 0),
      0,
    ) + (reasoningTraceEnabled ? 1 : 0);
  const timelineHeight = manualHeight ?? timelineDefaultHeightPx(visibleLaneRows);

  /**
   * What the identity cells actually render, as one string.
   *
   * Measuring on every render would reflow the rail 60 times a second during a
   * scrub, and enumerating "the labels, plus the icons, plus whether the delete
   * button exists" as effect dependencies is the kind of list that silently goes
   * stale. A signature over the same inputs re-measures exactly when the content
   * can have changed.
   */
  const identityContentSignature = [
    readOnly ? "ro" : "rw",
    reasoningTraceEnabled ? "reason" : "",
    hasWorldInteractions ? "world" : "",
    carlaCompatibilityByActor ? [...carlaCompatibilityByActor].map(([id, value]) => `${id}:${value}`).join(",") : "",
    document.data.roles.map((role) => `${role.id}:${actorLabels.get(role.id) ?? ""}:${role.actor.catalogId ?? ""}`).join(","),
    signalLanes.map((lane) => `${lane.referenceHeadId}:${lane.headIds.join("/")}`).join(","),
  ].join("|");

  useLayoutEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const fit = () => {
      const next = fittedTimelineIdentityWidthPx(
        rail.querySelectorAll<HTMLElement>(`[${IDENTITY_CONTENT_ATTR}]`),
        rail.getBoundingClientRect().width,
      );
      if (next === null) return;
      setFittedIdentityWidth((current) => (current === next ? current : next));
    };
    fit();
    // A narrower rail lowers the cap, and a late webfont changes every label's
    // width after the first measurement has already been taken. Both are
    // refinements of a width that is already correct, so an environment without
    // either API keeps the measurement above.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    observer?.observe(rail);
    let cancelled = false;
    void globalThis.document?.fonts?.ready.then(() => {
      if (!cancelled) fit();
    }).catch(() => undefined);
    return () => {
      cancelled = true;
      observer?.disconnect();
    };
  }, [identityContentSignature]);
  const selectInteraction = useCallback((interactionId: string, actorId: string) => {
    onSelectInteraction?.(interactionId, actorId);
  }, [onSelectInteraction]);
  const clearInteraction = useCallback(() => {
    onClearSelection?.();
  }, [onClearSelection]);
  const routeAuthoring = state?.mode === "drawingRoute";
  const playAvailable = Boolean(playback?.sessionId && playback.onPlayPause) && !routeAuthoring;
  const displayedTime = draggedPlayheadTime ?? (playback?.inspecting ? playback.time : authoringTime);
  const playheadPercent = rangePercent(displayedTime * 1000, windowRange);
  const playPauseRef = useRef<(() => void) | null>(null);
  playPauseRef.current = playAvailable ? playback?.onPlayPause ?? null : null;
  const exitPlaybackRef = useRef<(() => void) | null>(null);
  exitPlaybackRef.current = playback?.inspecting ? playback.onExitInspection : null;

  useEffect(() => {
    let active = true;
    void loadCarlaCompatibility()
      .then((table) => {
        if (active) setCarlaTable(table);
      })
      .catch(() => {
        // Compatibility metadata is advisory and must never break the editor.
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const onPlaybackShortcut = (event: KeyboardEvent) => {
      if (event.key === "Escape" && exitPlaybackRef.current) {
        event.preventDefault();
        event.stopImmediatePropagation();
        exitPlaybackRef.current();
        return;
      }
      const space = event.code === "Space" || event.key === " " || event.key === "Spacebar";
      if (!space || event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
      if (isTextEntryKeyboardTarget(event.target)) return;
      // Capture before CityCameraControls records Space as fly-mode elevation.
      // This also prevents a focused button from interpreting Space as a click
      // and opening actor or interaction details.
      event.preventDefault();
      event.stopImmediatePropagation();
      playPauseRef.current?.();
    };
    window.addEventListener("keydown", onPlaybackShortcut, true);
    return () => window.removeEventListener("keydown", onPlaybackShortcut, true);
  }, []);

  useEffect(() => {
    setAuthoringTime((current) => clampTime(current, windowRange));
  }, [windowRange]);

  useEffect(() => {
    if (
      selectedInteractionId &&
      !choreography.interactions.some((item) => item.id === selectedInteractionId)
    ) {
      clearInteraction();
    }
  }, [choreography.interactions, clearInteraction, selectedInteractionId]);

  useEffect(() => {
    setPreview(null);
    setContextMenu(null);
    setSelectedTraceId(null);
  }, [document]);

  const addReasoningTrace = (event: React.MouseEvent<HTMLElement>) => {
    if (readOnly || !sensorSubjectId) return;
    event.preventDefault();
    const timeS = timelineTimeFromClientX(event.clientX, event.currentTarget.getBoundingClientRect(), windowRange);
    const startS = Math.min(snapToTimeGrid(timeS), Math.max(0, choreography.clipSeconds - 0.1));
    const segment: ReasoningTraceSegment = {
      id: newTemplateId('trace'),
      actor: sensorSubjectId,
      startS,
      endS: Math.min(choreography.clipSeconds, Math.max(startS + 0.1, snapToTimeGrid(startS + 2))),
      observation: '',
      action: '',
    };
    document.addReasoningTraceSegment(segment);
    onClearSelection?.();
    setSelectedTraceId(segment.id);
  };

  const selectReasoningTrace = (id: string) => {
    onClearSelection?.();
    setSelectedTraceId(id);
  };

  const openContextMenu = (
    event: React.MouseEvent<HTMLElement>,
    actorId: string,
  ) => {
    if (readOnly || disableInteractionCreation) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    const track = event.currentTarget.matches("[data-timeline-track]")
      ? event.currentTarget
      : event.currentTarget.querySelector<HTMLElement>("[data-timeline-track]");
    if (!track) return;
    const timeS = timelineTimeFromClientX(event.clientX, track.getBoundingClientRect(), windowRange);
    setAuthoringTime(timeS);
    setContextMenu({
      actorId,
      timeS,
      anchorX: event.clientX,
      anchorY: event.clientY,
    });
  };

  const addAction = (role: Role, definitionId: string, timeS: number) => {
    if (readOnly || disableInteractionCreation) return;
    const definition = actionsForActor(role.actor.class, role.actor.catalogId).find(
      (candidate) => candidate.id === definitionId,
    );
    if (!definition) return;
    const interaction = interactionForAction(
      definition,
      role.id,
      timeS,
      choreography.interactions.length + 1,
    );
    const id = uniqueTimelineInteractionId(
      `${definition.id}_${role.id}`,
      choreography.interactions.map((item) => item.id),
    );
    const next = definition.id === 'custom_route'
      ? {
          ...interaction,
          id,
          until: { kind: 'at', t: choreography.clipSeconds },
        }
      : { ...interaction, id };
    if (!setExclusiveCustomTimedRoute(document, next as Interaction)) {
      document.addInteraction(next as Interaction);
    }
    selectInteraction(id, role.id);
    setContextMenu(null);
  };

  const addDirectAction = (role: Role, verb: "gap" | "exist", timeS: number) => {
    if (readOnly || disableInteractionCreation) return;
    const otherRole = gapPeerFor(role, document.data.roles);
    if (verb === "gap" && !otherRole) return;
    const startS = snapToTimeGrid(timeS);
    const id = uniqueTimelineInteractionId(
      `${verb}_${role.id}`,
      choreography.interactions.map((item) => item.id),
    );
    const interaction = {
      id,
      actor: role.id,
      label: verb === "gap" ? "Follow gap" : "Become absent",
      trigger: { kind: "at", t: startS },
      until: { kind: "at", t: snapToTimeGrid(startS + 1) },
      verb,
      target:
        verb === "gap"
          ? { role: otherRole!.id, value: 2, unit: "time" }
          : { state: "absent" },
      ...(verb === "gap"
        ? { dynamics: { shape: "linear", constraint: "time", value: 1 } }
        : {}),
    } as Interaction;
    document.addInteraction(interaction);
    selectInteraction(id, role.id);
    setContextMenu(null);
  };

  const finishCanonicalAdd = (interaction: Interaction) => {
    selectInteraction(interaction.id, interaction.actor);
    setContextMenu(null);
  };

  const commitRange = (interaction: Interaction, range: AuthoredTimelineRange) => {
    if (readOnly || isCustomTimedRoute(interaction)) return;
    const ranged = interactionWithAuthoredTimelineRange(interaction, range);
    document.replaceInteraction(
      interaction.id,
      interaction.verb === 'route' && (interaction.target.mode === 'customRoute' || interaction.target.mode === 'customTimedRoute')
        ? { ...ranged, until: { kind: 'at', t: choreography.clipSeconds } }
        : ranged,
    );
    setPreview(null);
  };

  const seekTimelineToTime = (timeS: number) => {
    const nextTimeS = clampTime(timeS, windowRange);
    setContextMenu(null);
    setAuthoringTime(nextTimeS);
    if (playback?.sessionId) playback.onSeek(nextTimeS);
    return nextTimeS;
  };

  const scrubTrackToClientX = (track: HTMLElement, clientX: number) => {
    const timeS = timelineTimeFromClientX(clientX, track.getBoundingClientRect(), windowRange);
    setDraggedPlayheadTime(seekTimelineToTime(timeS));
  };

  const beginTrackScrub = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const target = event.target;
    if (!(target instanceof Element) || target.closest(
      "[data-timeline-seek-ignore], [data-timeline-interaction-id], input, textarea, select, button, a",
    )) return;
    const track = target.closest<HTMLElement>("[data-timeline-track]");
    if (!track) return;
    event.preventDefault();
    trackScrubRef.current = { pointerId: event.pointerId, track };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    scrubTrackToClientX(track, event.clientX);
  };

  const moveTrackScrub = (event: ReactPointerEvent<HTMLElement>) => {
    const scrub = trackScrubRef.current;
    if (!scrub || scrub.pointerId !== event.pointerId) return;
    scrubTrackToClientX(scrub.track, event.clientX);
  };

  const endTrackScrub = (event: ReactPointerEvent<HTMLElement>) => {
    const scrub = trackScrubRef.current;
    if (!scrub || scrub.pointerId !== event.pointerId) return;
    scrubTrackToClientX(scrub.track, event.clientX);
    trackScrubRef.current = null;
    setDraggedPlayheadTime(null);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const cancelTrackScrub = (event: ReactPointerEvent<HTMLElement>) => {
    if (trackScrubRef.current?.pointerId !== event.pointerId) return;
    trackScrubRef.current = null;
    setDraggedPlayheadTime(null);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const dragPlayheadToClientX = (clientX: number) => {
    const rail = railRef.current?.getBoundingClientRect();
    if (!rail) return;
    const timeS = timelineTimeFromClientX(clientX, {
      left: rail.left + identityWidth,
      width: Math.max(1, rail.width - identityWidth),
    }, windowRange);
    setDraggedPlayheadTime(seekTimelineToTime(timeS));
  };

  const beginPlayheadDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    playheadDragRef.current = event.pointerId;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragPlayheadToClientX(event.clientX);
  };

  const movePlayheadDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (playheadDragRef.current !== event.pointerId) return;
    dragPlayheadToClientX(event.clientX);
  };

  const endPlayheadDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (playheadDragRef.current !== event.pointerId) return;
    dragPlayheadToClientX(event.clientX);
    playheadDragRef.current = null;
    setDraggedPlayheadTime(null);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const cancelPlayheadDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (playheadDragRef.current !== event.pointerId) return;
    playheadDragRef.current = null;
    setDraggedPlayheadTime(null);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const beginTimelineResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    resizeDragRef.current = { startY: event.clientY, startHeight: timelineHeight };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const resizeTimeline = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = resizeDragRef.current;
    if (!drag) return;
    setManualHeight(
      clampTimelineHeightPx(
        drag.startHeight + drag.startY - event.clientY,
        window.innerHeight,
      ),
    );
  };

  const endTimelineResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizeDragRef.current) return;
    resizeDragRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const railWidth = () => railRef.current?.getBoundingClientRect().width ?? 0;

  const beginSplitResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    // Capturing the pointer keeps a drag alive outside this 12px strip, but it
    // also stops Chromium from synthesizing the `dblclick` that would carry a
    // reset, so the second press is recognized here instead.
    if (event.timeStamp - splitResetRef.current < SPLIT_RESET_WINDOW_MS) {
      splitResetRef.current = 0;
      splitDragRef.current = null;
      // Reset means "go back to fitting the content", not "go back to 114px".
      setManualIdentityWidth(null);
      return;
    }
    splitResetRef.current = event.timeStamp;
    splitDragRef.current = { startX: event.clientX, startWidth: identityWidth };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const resizeSplit = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = splitDragRef.current;
    if (!drag) return;
    event.stopPropagation();
    setManualIdentityWidth(clampTimelineIdentityWidthPx(
      drag.startWidth + (event.clientX - drag.startX),
      railWidth(),
    ));
  };

  const endSplitResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!splitDragRef.current) return;
    splitDragRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <section
      ref={railRef}
      {...stylex.props(styles.flexColTight, TIMELINE_GLASS_SURFACE_STYLE)}
      data-floating="true"
      data-interaction-authoring={readOnly || disableInteractionCreation ? "disabled" : "enabled"}
      data-presentation="floating"
      data-testid="scenario-timeline-dock"
      data-tutorial="timeline"
      aria-readonly={readOnly}
      onPointerCancelCapture={cancelTrackScrub}
      onPointerDownCapture={beginTrackScrub}
      onPointerMoveCapture={moveTrackScrub}
      onPointerUpCapture={endTrackScrub}
      style={{
        width: "100%",
        maxWidth: "none",
        borderRadius: "24px 24px 0 0",
        clipPath: "inset(0 round 24px 24px 0 0)",
        backdropFilter: "blur(72px) saturate(1.85) contrast(1.05)",
        WebkitBackdropFilter: "blur(72px) saturate(1.85) contrast(1.05)",
        height: `${timelineHeight}px`,
        maxHeight: "min(65vh, 520px)",
        [IDENTITY_WIDTH_VAR]: `${identityWidth}px`,
      } as CSSProperties}
    >
      <>
          <TimelineGlassBackdrop />
          <div
            aria-label="Resize timeline"
            aria-orientation="horizontal"
            {...stylex.props(styles.absFlexMid)}
            data-testid="timeline-height-resize-handle"
            onDoubleClick={() => setManualHeight(null)}
            onKeyDown={(event) => {
              if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
              event.preventDefault();
              setManualHeight(clampTimelineHeightPx(
                timelineHeight + (event.key === "ArrowUp" ? 24 : -24),
                window.innerHeight,
              ));
            }}
            onPointerCancel={endTimelineResize}
            onPointerDown={beginTimelineResize}
            onPointerMove={resizeTimeline}
            onPointerUp={endTimelineResize}
            role="separator"
            tabIndex={0}
          >
            <span {...stylex.props(styles.round)} />
          </div>
          <div
            aria-label="Resize name column"
            aria-orientation="vertical"
            aria-valuemax={IDENTITY_MAX_WIDTH_PX}
            aria-valuemin={IDENTITY_MIN_WIDTH_PX}
            aria-valuenow={identityWidth}
            aria-valuetext={
              manualIdentityWidth === null
                ? `Name column fits its contents, ${identityWidth} pixels`
                : `Name column ${identityWidth} pixels`
            }
            className={stylex.props(styles.abs).className}
            data-testid="timeline-split-resize-handle"
            data-timeline-seek-ignore="true"
            // Two press/release pairs — a human double click — are caught in
            // `beginSplitResize`, because pointer capture suppresses `dblclick`
            // there. A single press carrying `clickCount: 2` arrives only as
            // `dblclick` instead. Resetting is idempotent, so honouring both
            // shapes costs nothing and leaves no way to double click without a
            // reset.
            onDoubleClick={() => setManualIdentityWidth(null)}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              setManualIdentityWidth(clampTimelineIdentityWidthPx(
                identityWidth + (event.key === "ArrowRight" ? 16 : -16),
                railWidth(),
              ));
            }}
            onPointerCancel={endSplitResize}
            onPointerDown={beginSplitResize}
            onPointerMove={resizeSplit}
            onPointerUp={endSplitResize}
            role="separator"
            style={{ left: `var(${IDENTITY_WIDTH_VAR})` }}
            tabIndex={0}
          >
            <span {...stylex.props(styles.absInert)} />
          </div>
          <header
            {...stylex.props(styles.relGridTight)}
            data-testid="timeline-topbar"
          >
            <div {...stylex.props(styles.flexCenterMid)}>
              <div
                {...stylex.props(styles.flexColCenter)}
                {...{ [IDENTITY_CONTENT_ATTR]: "" }}
              >
                <strong {...stylex.props(styles.capsBoldNowrap)}>
                  Timeline
                </strong>
                <TimelineTransportControls playback={playback} playDisabled={routeAuthoring} />
              </div>
            </div>
            <div
              {...stylex.props(styles.relNarrowableSelfStretch)}
              data-testid="timeline-inline-ruler"
              data-timeline-track="ruler"
            >
              <TimelineRuler
                choreography={choreography}
                crashes={playback?.crashes}
                xstyle={styles.tall}
              />
            </div>
          </header>

          <div
            {...stylex.props(styles.absInertRaised)}
            data-testid="timeline-playhead"
            style={{
              left: `calc(var(${IDENTITY_WIDTH_VAR}) + (100% - var(${IDENTITY_WIDTH_VAR})) * ${playheadPercent / 100})`,
            }}
          >
            <button
              aria-label="Drag timeline playhead"
              aria-valuemax={windowRange.endMs / 1000}
              aria-valuemin={windowRange.startMs / 1000}
              aria-valuenow={displayedTime}
              aria-valuetext={`${displayedTime.toFixed(1)} seconds`}
              className={stylex.props(styles.absLivePad0).className}
              data-testid="timeline-playhead-drag-handle"
              data-timeline-seek-ignore="true"
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                event.preventDefault();
                const step = event.shiftKey ? 1 : 0.1;
                seekTimelineToTime(displayedTime + (event.key === "ArrowRight" ? step : -step));
              }}
              onPointerCancel={cancelPlayheadDrag}
              onPointerDown={beginPlayheadDrag}
              onPointerMove={movePlayheadDrag}
              onPointerUp={endPlayheadDrag}
              role="slider"
              type="button"
            >
              <span {...stylex.props(styles.absRound)} />
            </button>
          </div>

          <div {...stylex.props(styles.relFillClip)} data-testid="semantic-timeline">
            <div {...stylex.props(styles.absScrollYInset0)} onScroll={() => setContextMenu(null)}>
              <div {...stylex.props(styles.minHFullPb12)}>
                {signalLanes.map((lane) => (
                  <SignalRailLane
                    key={`${lane.junctionId}:${lane.controllerId}`}
                    lane={lane}
                    window={windowRange}
                    onFocus={
                      !readOnly && onFocusSignal
                        ? () => onFocusSignal(lane.referenceHeadId)
                        : undefined
                    }
                    onConfigure={
                      !readOnly && onSelectSignal
                        ? () => onSelectSignal(lane.referenceHeadId)
                        : undefined
                    }
                    onRemoveControl={!readOnly ? lane.onRemoveControl : undefined}
                  />
                ))}
                {hasWorldInteractions ? (
                  <WorldRailLane
                    cues={timelineCues}
                    rows={worldRows}
                    preview={preview}
                    selectedInteractionId={selectedInteractionId}
                    window={windowRange}
                    onCommitRange={commitRange}
                    onPreview={setPreview}
                    onSelectInteraction={(id) => selectInteraction(id, "@world")}
                    lockSimpleTimedRoutes={lockSimpleTimedRoutes}
                    readOnly={readOnly}
                  />
                ) : null}
                {document.data.roles.map((role) => (
                  <Fragment key={role.id}>
                  <ActorRailLane
                    cues={timelineCues}
                    displayLabel={actorLabels.get(role.id) ?? "Actor"}
                    rows={rowsByActor.get(role.id) ?? [[]]}
                    preview={preview}
                    role={role}
                    carlaCompatibility={carlaCompatibilityByActor?.get(role.id) ?? null}
                    selected={state?.selection.includes(role.id) ?? false}
                    selectedInteractionId={selectedInteractionId}
                    window={windowRange}
                    onCommitRange={commitRange}
                    onContextMenu={openContextMenu}
                    onPreview={setPreview}
                    onRemoveActor={(actor) => {
                      setContextMenu(null);
                      document.remove([actor.id]);
                    }}
                    onFocusActor={onFocusActor}
                    onSelectActor={onSelectActor}
                    onSelectInteraction={(id) => selectInteraction(id, role.id)}
                    interactionCreationDisabled={disableInteractionCreation}
                    lockSimpleTimedRoutes={lockSimpleTimedRoutes}
                    readOnly={readOnly}
                  />
                  {reasoningTraceEnabled && sensorSubjectId === role.id ? (
                    <ReasoningTraceLane
                      segments={document.data.reasoningTrace.filter((segment) => segment.actor === role.id)}
                      selectedId={selectedTraceId}
                      window={windowRange}
                      readOnly={readOnly}
                      onAdd={addReasoningTrace}
                      onSelect={selectReasoningTrace}
                    />
                  ) : null}
                  </Fragment>
                ))}
                {document.data.roles.length === 0 && signalLanes.length === 0 && !hasWorldInteractions ? (
                  <p {...stylex.props(styles.gridCenteredXs)}>
                    {readOnly ? "No authored timeline content." : "Place an actor to start authoring the timeline."}
                  </p>
                ) : null}
              </div>
            </div>
          </div>

          {contextMenu && !readOnly && !disableInteractionCreation ? (
            <ContextActionMenu
              document={document}
              state={contextMenu}
              onAdd={addAction}
              onAddCanonical={finishCanonicalAdd}
              onAddDirect={addDirectAction}
              onClose={() => setContextMenu(null)}
            />
          ) : null}
          {selectedTraceId ? (
            <ReasoningTraceEditor
              segment={document.data.reasoningTrace.find((item) => item.id === selectedTraceId) ?? null}
              clipSeconds={choreography.clipSeconds}
              readOnly={readOnly}
              onClose={() => setSelectedTraceId(null)}
              onDelete={(id) => { document.removeReasoningTraceSegment(id); setSelectedTraceId(null); }}
              onSave={(segment) => document.replaceReasoningTraceSegment(segment.id, segment)}
            />
          ) : null}
      </>
    </section>
  );
}

function isTextEntryKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest('textarea, [contenteditable="true"], [role="textbox"]')) return true;
  const input = target.closest("input");
  if (!input) return false;
  return ![
    "button",
    "checkbox",
    "color",
    "file",
    "image",
    "radio",
    "range",
    "reset",
    "submit",
  ].includes(input.type);
}

function SignalRailLane({
  lane,
  window,
  onConfigure,
  onFocus,
  onRemoveControl,
}: {
  lane: V1TimelineSignalLane;
  window: TimelineRange;
  onFocus?: () => void;
  onConfigure?: () => void;
  onRemoveControl?: () => void;
}) {
  const laneId = `${lane.junctionId}-${lane.controllerId}`;
  return (
    <div
      {...stylex.props(styles.gridRuleB)}
      data-testid={`timeline-signal-lane-${laneId}`}
    >
      <div {...stylex.props(styles.flexStretchRuleR)}>
        <div
          {...stylex.props(styles.flexStretchSelfStretch)}
          {...{ [IDENTITY_CONTENT_ATTR]: "" }}
        >
          {onFocus || onConfigure ? (
            <button
              aria-label={`${onFocus ? "Focus" : "Configure"} traffic light ${lane.referenceHeadId}`}
              className={stylex.props(styles.flexCenterGap15, motionStyles.editorMotion).className}
              data-testid={`timeline-focus-signal-${laneId}`}
              type="button"
              onClick={onFocus ?? onConfigure}
            >
              <TrafficCone aria-hidden="true" className={stylex.props(styles.tight).className} />
              <span {...stylex.props(styles.nowrap)}>Light {lane.referenceHeadId}</span>
            </button>
          ) : (
            <div {...stylex.props(styles.flexCenterGap152)}>
              <TrafficCone aria-hidden="true" className={stylex.props(styles.tight).className} />
              <span {...stylex.props(styles.nowrap)}>Lights {lane.headIds.join(", ")}</span>
            </div>
          )}
          {onRemoveControl ? (
            <button
              aria-label={`Remove control from traffic light ${lane.referenceHeadId}`}
              className={stylex.props(styles.gridCenteredTight, motionStyles.editorMotion).className}
              data-testid={`timeline-remove-signal-control-${laneId}`}
              onClick={onRemoveControl}
              title="Remove control"
              type="button"
            >
              <Trash2 aria-hidden="true" className={stylex.props(styles.size3).className} />
            </button>
          ) : null}
        </div>
      </div>
      <div {...stylex.props(styles.relClipPointer)} data-timeline-track="signal">
        {lane.bands.map((band) => {
          const classes = indicationSwatch(band.indication);
          const authored = band.source === "authored";
          const selectable = Boolean(onConfigure);
          return (
            <button
              aria-label={`${indicationLabel(band.indication)}, ${band.startS.toFixed(1)} to ${band.endS.toFixed(1)} seconds, ${authored ? "authored" : selectable ? "map timing; click to take control" : "map timing"}`}
              {...stylex.props(
                styles.signalBand,
                authored ? classes.fill : classes.ghost,
                authored ? classes.border : styles.signalBandBaseline,
                selectable ? styles.signalBandSelectable : styles.signalBandInert,
              )}
              data-source={band.source}
              data-testid={`timeline-signal-band-${laneId}-${band.startS}`}
              disabled={!selectable}
              key={`${band.startS}:${band.endS}:${band.indication}:${band.source}`}
              onClick={() => {
                if (onConfigure) {
                  onConfigure();
                }
              }}
              style={{
                left: `${rangePercent(band.startS * 1000, window)}%`,
                width: `${Math.max(0, rangePercent(band.endS * 1000, window) - rangePercent(band.startS * 1000, window))}%`,
              }}
              type="button"
            />
          );
        })}
      </div>
    </div>
  );
}

function WorldRailLane({
  cues,
  rows,
  window,
  selectedInteractionId,
  preview,
  onSelectInteraction,
  onPreview,
  onCommitRange,
  lockSimpleTimedRoutes,
  readOnly,
}: {
  cues: ReadonlyMap<string, TimelineCue>;
  rows: readonly (readonly ResolvedInteraction[])[];
  window: TimelineRange;
  selectedInteractionId: string | null;
  preview: ClipPreview | null;
  onSelectInteraction: (id: string) => void;
  onPreview: (preview: ClipPreview | null) => void;
  onCommitRange: (interaction: Interaction, range: AuthoredTimelineRange) => void;
  lockSimpleTimedRoutes: boolean;
  readOnly: boolean;
}) {
  const rowCount = Math.max(1, rows.length);
  return (
    <article
      {...stylex.props(styles.gridRuleB2)}
      data-testid="timeline-world-lane"
      style={{
        gridTemplateColumns: IDENTITY_GRID_COLUMNS,
        gridTemplateRows: `repeat(${rowCount}, 28px)`,
      }}
    >
      <div
        {...stylex.props(styles.relFlexStart)}
        data-testid="timeline-world-identity"
        style={{ gridColumn: 1, gridRow: `1 / span ${rowCount}` }}
      >
        <div
          {...stylex.props(styles.flexStartGap15)}
          {...{ [IDENTITY_CONTENT_ATTR]: "" }}
        >
          <Globe2 aria-hidden="true" className={stylex.props(styles.tight2).className} />
          <span {...stylex.props(styles.mediumNowrap)}>Scene / world</span>
        </div>
      </div>
      {rows.flatMap((row, rowIndex) => row.map((resolved) => (
        <InteractionBand
          cue={cues.get(resolved.interaction.id)}
          key={resolved.interaction.id}
          preview={preview?.interactionId === resolved.interaction.id ? preview.range : null}
          resolved={resolved}
          selected={selectedInteractionId === resolved.interaction.id}
          window={window}
          onCommitRange={onCommitRange}
          onPreview={onPreview}
          onSelect={() => onSelectInteraction(resolved.interaction.id)}
          lockSimpleTimedRoutes={lockSimpleTimedRoutes}
          readOnly={readOnly}
          row={rowIndex + 1}
        />
      )))}
    </article>
  );
}

function ActorRailLane({
  cues,
  carlaCompatibility,
  role,
  displayLabel,
  rows,
  window,
  selected,
  selectedInteractionId,
  preview,
  onContextMenu,
  onRemoveActor,
  onFocusActor,
  onSelectActor,
  onSelectInteraction,
  onPreview,
  onCommitRange,
  interactionCreationDisabled,
  lockSimpleTimedRoutes,
  readOnly,
}: {
  carlaCompatibility: CarlaCompatibility | null;
  cues: ReadonlyMap<string, TimelineCue>;
  role: Role;
  displayLabel: string;
  rows: readonly (readonly ResolvedInteraction[])[];
  window: TimelineRange;
  selected: boolean;
  selectedInteractionId: string | null;
  preview: ClipPreview | null;
  onContextMenu: (event: React.MouseEvent<HTMLElement>, actorId: string) => void;
  onRemoveActor: (role: Role) => void;
  onFocusActor?: (actorId: string) => void;
  onSelectActor?: (actorId: string) => void;
  onSelectInteraction: (id: string) => void;
  onPreview: (preview: ClipPreview | null) => void;
  onCommitRange: (interaction: Interaction, range: AuthoredTimelineRange) => void;
  interactionCreationDisabled: boolean;
  lockSimpleTimedRoutes: boolean;
  readOnly: boolean;
}) {
  // `Static / parked` is the only immovability switch. An object's catalog class
  // never vetoes motion: a custom gallery upload — a pedestrian model, an animal,
  // a delivery robot — is placed as `static_object` and must still accept a route.
  const staticActor = Boolean(role.actor.static);
  const interactions = rows.flat();
  const rowCount = Math.max(1, rows.length);
  const rowTemplate = `repeat(${rowCount}, 28px)`;
  const actorLabel = displayLabel;

  return (
    <article
      {...stylex.props(styles.gridRuleB2)}
      data-static={staticActor ? "true" : "false"}
      data-testid={`timeline-actor-lane-${role.id}`}
      onClick={readOnly ? undefined : (event) => {
        const target = event.target;
        if (target instanceof Element && target.closest("[data-timeline-interaction-id]")) return;
        onSelectActor?.(role.id);
      }}
      style={{ gridTemplateColumns: IDENTITY_GRID_COLUMNS, gridTemplateRows: rowTemplate }}
    >
      <div
        {...stylex.props(styles.identityColumn, selected ? styles.identityColumnSelected : styles.identityColumnIdle)}
        data-testid={`timeline-actor-identity-${role.id}`}
        style={{ gridColumn: 1, gridRow: `1 / span ${rowCount}` }}
      >
        <div
          {...stylex.props(styles.flexStartGap15)}
          {...{ [IDENTITY_CONTENT_ATTR]: "" }}
        >
          <button
            aria-label={`Focus actor ${actorLabel}`}
            {...stylex.props(styles.flexCenterGap153)}
            disabled={readOnly || (!onFocusActor && !onSelectActor)}
            onClick={(event) => {
              event.stopPropagation();
              (onFocusActor ?? onSelectActor)?.(role.id);
            }}
            type="button"
          >
            <TimelineActorCatalogIcon role={role} />
            <span {...stylex.props(styles.mediumNowrap)} title={actorLabel}>
              {actorLabel}
            </span>
          </button>
          {carlaCompatibility ? (
            <TimelineCarlaCompatibilityMarker
              actorLabel={actorLabel}
              compatibility={carlaCompatibility}
            />
          ) : null}
          {!readOnly ? (
            <button
              aria-label={`Delete actor ${actorLabel}`}
              {...stylex.props(styles.inlineFlexCenterMid)}
              data-testid={`timeline-delete-${role.id}`}
              onClick={(event) => {
                event.stopPropagation();
                onRemoveActor(role);
              }}
              type="button"
            >
              <Trash2 aria-hidden="true" className={stylex.props(styles.size35).className} />
            </button>
          ) : null}
        </div>
      </div>

      {staticActor && interactions.length === 0 ? (
        <div
          {...stylex.props(styles.flexCenterCaps, styles.styleGridColumn2)}
          data-testid={`timeline-static-identity-only-${role.id}`}
          data-timeline-track="interaction"
        >
          Static · no authored actions
        </div>
      ) : (
        <>
          {!staticActor && interactions.length === 0 ? (
            <div
              {...stylex.props(styles.relPointer, styles.styleGridColumn2)}
              data-testid={`timeline-interaction-gap-${role.id}`}
              data-timeline-track="interaction"
              onContextMenu={readOnly ? undefined : (event) => onContextMenu(event, role.id)}
            >
              <span {...stylex.props(styles.absGridCentered)}>
                {readOnly || interactionCreationDisabled
                  ? "No authored actions"
                  : "Right-click a gap to add an action"}
              </span>
            </div>
          ) : (
            rows.flatMap((row, rowIndex) => row.map((resolved) => (
              <InteractionBand
                cue={cues.get(resolved.interaction.id)}
                key={resolved.interaction.id}
                preview={preview?.interactionId === resolved.interaction.id ? preview.range : null}
                resolved={resolved}
                selected={selectedInteractionId === resolved.interaction.id}
                window={window}
                onCommitRange={onCommitRange}
                onPreview={onPreview}
                onSelect={() => onSelectInteraction(resolved.interaction.id)}
                onOpenContextMenu={readOnly ? undefined : (event) => onContextMenu(event, role.id)}
                lockSimpleTimedRoutes={lockSimpleTimedRoutes}
                readOnly={readOnly}
                row={rowIndex + 1}
              />
            )))
          )}
        </>
      )}
    </article>
  );
}

function ReasoningTraceLane({
  segments,
  selectedId,
  window,
  readOnly,
  onAdd,
  onSelect,
}: {
  segments: readonly ReasoningTraceSegment[];
  selectedId: string | null;
  window: TimelineRange;
  readOnly: boolean;
  onAdd: (event: React.MouseEvent<HTMLElement>) => void;
  onSelect: (id: string) => void;
}) {
  return (
    <article {...stylex.props(styles.gridRuleB3)} data-testid="timeline-reasoning-trace-lane">
      <div {...stylex.props(styles.flexCenterRuleR)}>
        <div
          {...stylex.props(styles.flexCenterGap154)}
          {...{ [IDENTITY_CONTENT_ATTR]: "" }}
        >
          <BrainCircuit aria-hidden="true" className={stylex.props(styles.tight).className} />
          <span {...stylex.props(styles.capsSemiboldNowrap)}>Reasoning</span>
        </div>
      </div>
      <div
        {...stylex.props(styles.relPointer)}
        data-timeline-track="reasoning"
        onContextMenu={readOnly ? undefined : onAdd}
      >
        {segments.length === 0 ? (
          <span {...stylex.props(styles.absGridCentered)}>
            {readOnly ? 'No reasoning trace' : 'Right-click to add observation + action'}
          </span>
        ) : null}
        {segments.map((segment) => {
          const start = rangePercent(segment.startS * 1000, window);
          const end = rangePercent(segment.endS * 1000, window);
          const label = segment.observation || segment.action || 'New reasoning note';
          return (
            <button
              aria-label={`Edit reasoning trace from ${segment.startS.toFixed(1)} to ${segment.endS.toFixed(1)} seconds`}
              {...stylex.props(styles.reasoningClip, selectedId === segment.id ? styles.reasoningClipSelected : styles.reasoningClipIdle)}
              data-timeline-seek-ignore="true"
              data-testid={`reasoning-trace-clip-${segment.id}`}
              key={segment.id}
              onClick={(event) => { event.stopPropagation(); onSelect(segment.id); }}
              onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); onSelect(segment.id); }}
              style={{ left: `${start}%`, width: `${Math.max(1, end - start)}%` }}
              title={label}
              type="button"
            >
              <span {...stylex.props(styles.blockTruncate)}>{label}</span>
            </button>
          );
        })}
      </div>
    </article>
  );
}

function ReasoningTraceEditor({
  segment,
  clipSeconds,
  readOnly,
  onClose,
  onDelete,
  onSave,
}: {
  segment: ReasoningTraceSegment | null;
  clipSeconds: number;
  readOnly: boolean;
  onClose: () => void;
  onDelete: (id: string) => void;
  onSave: (segment: ReasoningTraceSegment) => void;
}) {
  const [draft, setDraft] = useState(segment);
  useEffect(() => setDraft(segment), [segment]);
  if (!draft) return null;
  return (
    <EditorDetailsPanel
      ariaLabel="Reasoning trace details"
      closeLabel="Close reasoning trace"
      closeTestId="reasoning-trace-close"
      maxHeight="min(620px, calc(100vh - 96px))"
      onClose={onClose}
      onDelete={readOnly ? undefined : () => onDelete(draft.id)}
      preview={(
        <div {...stylex.props(styles.flexColCenter2)}>
          <BrainCircuit aria-hidden="true" className={stylex.props(styles.size8Text).className} />
          <strong {...stylex.props(styles.whiteSemibold)}>Reasoning trace</strong>
          <span {...stylex.props(styles.textTextWhite40)}>Observation and action</span>
        </div>
      )}
      previewXstyle={styles.preview}
      testId="scenario-reasoning-trace-panel"
    >
      <div {...stylex.props(styles.gridCols2Gap2)}>
        {(['startS', 'endS'] as const).map((field) => (
          <label {...stylex.props(styles.capsNarrowable)} key={field}>{field === 'startS' ? 'Start' : 'End'}
            <input {...stylex.props(styles.whiteBorderedWide)} disabled={readOnly} max={clipSeconds} min={field === 'startS' ? 0 : 0.1} onChange={(event) => setDraft({ ...draft, [field]: Number(event.target.value) })} step="0.1" type="number" value={draft[field]} />
          </label>
        ))}
      </div>
      <label {...stylex.props(styles.blockCaps)}>Observation
        <textarea {...stylex.props(styles.whiteBorderedWide2)} disabled={readOnly} onChange={(event) => setDraft({ ...draft, observation: event.target.value })} placeholder="What is happening around the camera vehicle?" value={draft.observation} />
      </label>
      <label {...stylex.props(styles.blockCaps)}>Action
        <textarea {...stylex.props(styles.whiteBorderedWide2)} disabled={readOnly} onChange={(event) => setDraft({ ...draft, action: event.target.value })} placeholder="What should the camera vehicle do next?" value={draft.action} />
      </label>
      {!readOnly ? <div {...stylex.props(styles.gridRuleTCols1)}><button {...stylex.props(styles.semibold)} disabled={!Number.isFinite(draft.startS) || !Number.isFinite(draft.endS) || draft.startS < 0 || draft.endS <= draft.startS || draft.endS > clipSeconds} onClick={() => onSave(draft)} type="button">Save trace</button><button {...stylex.props(styles.flexCenterMid2)} onClick={() => onDelete(draft.id)} type="button"><Trash2 aria-hidden="true" className={stylex.props(styles.size3).className} />Delete trace</button></div> : null}
    </EditorDetailsPanel>
  );
}

function InteractionBand({
  cue,
  resolved,
  selected,
  preview,
  window,
  row,
  onSelect,
  onPreview,
  onCommitRange,
  onOpenContextMenu,
  lockSimpleTimedRoutes,
  readOnly,
}: {
  cue: TimelineCue | undefined;
  resolved: ResolvedInteraction;
  selected: boolean;
  preview: AuthoredTimelineRange | null;
  window: TimelineRange;
  row: number;
  onSelect: () => void;
  onPreview: (preview: ClipPreview | null) => void;
  onCommitRange: (interaction: Interaction, range: AuthoredTimelineRange) => void;
  onOpenContextMenu?: (event: React.MouseEvent<HTMLElement>) => void;
  lockSimpleTimedRoutes: boolean;
  readOnly: boolean;
}) {
  const interaction = resolved.interaction;
  const customTimedRoute = isCustomTimedRoute(interaction);
  const simpleTimedRoute = lockSimpleTimedRoutes && customTimedRoute;
  const routeNeedsSetup = simpleTimedRoute && isUnconfiguredSimpleTimedRoute(interaction);
  const timingLocked = readOnly || customTimedRoute;
  const endsWithScenario = interaction.verb === 'route' && (interaction.target.mode === 'customRoute' || customTimedRoute);
  const editable = authoredTimelineRange(interaction);
  const shownRange = preview
    ? { startMs: preview.startS * 1000, endMs: preview.endS * 1000 }
    : resolved.range;
  const start = rangePercent(shownRange.startMs, window);
  const end = rangePercent(shownRange.endMs, window);
  const label = simpleTimedRoute
    ? routeNeedsSetup
      ? "Click to configure route"
      : "Edit route"
    : interaction.label ?? interaction.verb;
  const conflictMessage = cue ? timelineConflictMessage(cue) : null;
  const deadlinePercent = cue?.deadlineS === null || cue?.deadlineS === undefined
    ? null
    : rangePercent(cue.deadlineS * 1000, window);
  const timingHelp = cue?.cause === "time"
    ? "Starts at a set time"
    : "Starts when something happens";

  const beginEdit =
    (editMode: TimelineClipEditMode) => (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (timingLocked) return;
      onSelect();
      // Selection is controlled by the editor shell and therefore cannot be
      // reflected until the next render. Do not make the first edge press a
      // selection-only click: an editable clip must resize immediately.
      if (!editable || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const track = event.currentTarget.closest<HTMLElement>("[data-timeline-track]");
      if (!track) return;
      const bounds = track.getBoundingClientRect();
      const startX = event.clientX;
      let latest = editable;
      const rangeAt = (pointer: PointerEvent) => {
        const deltaS = ((pointer.clientX - startX) / Math.max(1, bounds.width)) *
          ((window.endMs - window.startMs) / 1000);
        return editAuthoredTimelineRange(editable, editMode, deltaS, window);
      };
      const move = (pointer: PointerEvent) => {
        latest = rangeAt(pointer);
        onPreview({ interactionId: interaction.id, range: latest });
      };
      const finish = (pointer: PointerEvent) => {
        windowThis().removeEventListener("pointermove", move);
        latest = rangeAt(pointer);
        if (authoredTimelineRangesEqual(editable, latest)) {
          onPreview(null);
          return;
        }
        onCommitRange(interaction, latest);
      };
      windowThis().addEventListener("pointermove", move);
      windowThis().addEventListener("pointerup", finish, { once: true });
    };

  const keyboardEdit = (editMode: TimelineClipEditMode) => (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (timingLocked || !selected || !editable || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
    event.preventDefault();
    const delta = (event.shiftKey ? 1 : 0.1) * (event.key === "ArrowRight" ? 1 : -1);
    onCommitRange(interaction, editAuthoredTimelineRange(editable, editMode, delta, window));
  };

  return (
    <div
      {...stylex.props(styles.relClipPointer2)}
      data-testid={`interaction-row-${interaction.id}`}
      data-timeline-track="interaction"
      onContextMenu={onOpenContextMenu}
      style={{ gridColumn: 2, gridRow: row }}
    >
      <div {...stylex.props(styles.contents)} data-testid="interaction-track">
        <div {...stylex.props(styles.abs2)} />
        {deadlinePercent !== null ? (
          <span
            aria-label={`Trigger deadline by ${cue?.deadlineS}s`}
            {...stylex.props(styles.absInert2)}
            data-testid={`timeline-trigger-deadline-${interaction.id}`}
            role="img"
            style={{ left: `${deadlinePercent}%` }}
            title={`Trigger deadline: by ${cue?.deadlineS}s`}
          />
        ) : null}
        <div
          className={stylex.props(
            styles.clip,
            routeNeedsSetup
              ? styles.clipNeedsSetup
              : cue?.conflict === "conflict"
              ? styles.clipConflict
              : cue?.conflict === "possible"
                ? styles.clipPossible
                : resolved.armed || !editable
              ? styles.clipArmed
              : styles.clipAuthored,
            selected && styles.clipSelected,
          ).className}
          data-conflict={cue?.conflict ?? "none"}
          data-editable={editable && !timingLocked ? "true" : "false"}
          data-locked={timingLocked ? "true" : "false"}
          data-route-status={routeNeedsSetup ? "needs-setup" : simpleTimedRoute ? "configured" : undefined}
          data-timeline-interaction-id={interaction.id}
          data-testid={`timeline-interaction-clip-${interaction.id}`}
          style={{ left: `${start}%`, width: `${Math.max(0.6, end - start)}%` }}
          title={[
            label,
            timingHelp,
            conflictMessage,
            simpleTimedRoute
              ? routeNeedsSetup
                ? "Route setup required"
                : "Route timing is managed by Simple mode"
              : timingLocked
                ? "Timing is locked"
                : editable
                  ? endsWithScenario
                    ? "Drag its start; route continues to scenario end"
                    : "Drag or resize authored times"
                  : "Conditional or open timing is locked",
          ].filter(Boolean).join(" · ")}
        >
          {!timingLocked ? (
            <button
              aria-label={`Resize start of ${label}`}
              className={stylex.props(styles.absTallRaised).className}
              data-testid={`timeline-resize-start-${interaction.id}`}
              data-timeline-seek-ignore="true"
              disabled={!editable}
              onKeyDown={keyboardEdit("resize-start")}
              onPointerDown={beginEdit("resize-start")}
              type="button"
            />
          ) : null}
          <button
            aria-controls={`scenario-interaction-${interaction.id}`}
            aria-expanded={selected}
            aria-label={simpleTimedRoute
              ? routeNeedsSetup
                ? "Configure route; setup required"
                : "Edit route"
              : timingLocked || !editable
                ? `Select ${label}; timing is locked`
                : `Select and move ${label}`}
            {...stylex.props(styles.flexCenterFill)}
            data-testid={`interaction-expand-${interaction.id}`}
            disabled={readOnly}
            onClick={readOnly ? undefined : onSelect}
            onKeyDown={keyboardEdit("move")}
            onPointerDown={beginEdit("move")}
            type="button"
          >
            {cue ? (
              <span
                {...stylex.props(styles.inlineFlexCenterTight)}
                data-cause={cue.cause}
                data-testid={`timeline-cause-${interaction.id}`}
                title={timingHelp}
              >
                {cue.cause === "time" ? (
                  <Clock3 aria-hidden="true" className={stylex.props(styles.size15).className} />
                ) : (
                  <Zap aria-hidden="true" className={stylex.props(styles.size15).className} />
                )}
                {timelineCauseLabel(cue.cause)}
              </span>
            ) : null}
            {(!editable || timingLocked) && !simpleTimedRoute ? (
              <Lock aria-hidden="true" className={stylex.props(styles.tight3).className} />
            ) : null}
            <span {...stylex.props(styles.truncate)}>{label}</span>
            {conflictMessage ? (
              <AlertTriangle
                aria-label={conflictMessage}
                className={stylex.props(styles.tightPushRight).className}
                data-testid={`timeline-conflict-${interaction.id}`}
                role="img"
              />
            ) : null}
          </button>
          {!timingLocked && !endsWithScenario ? (
            <button
              aria-label={`Resize end of ${label}`}
              className={stylex.props(styles.absTallRaised2).className}
              data-testid={`timeline-resize-end-${interaction.id}`}
              data-timeline-seek-ignore="true"
              disabled={!editable}
              onKeyDown={keyboardEdit("resize-end")}
              onPointerDown={beginEdit("resize-end")}
              type="button"
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ContextActionMenu({
  document,
  state,
  onAdd,
  onAddCanonical,
  onAddDirect,
  onClose,
}: {
  document: EditorDocument;
  state: ContextMenuState;
  onAdd: (role: Role, definitionId: string, timeS: number) => void;
  onAddCanonical: (interaction: Interaction) => void;
  onAddDirect: (role: Role, verb: "gap" | "exist", timeS: number) => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const role = document.data.roles.find((item) => item.id === state.actorId);
  const actions = role ? actionsForActor(role.actor.class, role.actor.catalogId) : [];
  const groups = groupContextActions(actions);
  const actorLabel = role
    ? timelineActorLabels(document.data.roles).get(role.id) ?? "Actor"
    : "Actor";
  const viewportWidth = windowThis().innerWidth;
  const viewportHeight = windowThis().innerHeight;
  const panelWidth = Math.min(520, Math.max(280, viewportWidth - 24));
  const left = Math.max(12, Math.min(state.anchorX - 24, viewportWidth - panelWidth - 12));
  const bottom = Math.max(12, viewportHeight - state.anchorY + 10);
  const maxHeight = Math.max(180, Math.min(460, state.anchorY - 24));

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    const closeOutside = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      onClose();
    };
    windowThis().addEventListener("keydown", closeOnEscape, true);
    globalThis.document.addEventListener("pointerdown", closeOutside, true);
    return () => {
      windowThis().removeEventListener("keydown", closeOnEscape, true);
      globalThis.document.removeEventListener("pointerdown", closeOutside, true);
    };
  }, [onClose]);

  if (!role) return null;
  return createPortal(
    <div
      ref={menuRef}
      aria-label={`Add interaction for ${actorLabel}`}
      {...stylex.props(styles.fixedWhiteBordered)}
      data-placement="above"
      data-testid="timeline-context-menu"
      id="timeline-context-menu"
      role="menu"
      style={{ bottom, left, maxHeight, width: panelWidth }}
    >
      <header {...stylex.props(styles.flexStartRuleB)}>
        <span {...stylex.props(styles.gridCenteredTight2)}>
          <Plus aria-hidden="true" className={stylex.props(styles.size4).className} />
        </span>
        <div {...stylex.props(styles.fillNarrowable)}>
          <p {...stylex.props(styles.capsSemibold)}>
            Add at {state.timeS.toFixed(1)}s
          </p>
          <p {...stylex.props(styles.xsTruncate)}>{actorLabel}</p>
        </div>
        <button
          aria-label="Close action menu"
          {...stylex.props(styles.gridCenteredLg)}
          onClick={onClose}
          type="button"
        >
          ×
        </button>
      </header>
      <div {...stylex.props(styles.gridGap2)}>
        {groups.map((group) => (
          <ActionMenuGroup key={group.label} label={group.label}>
            {group.actions.map((action) => (
              <ActionMenuButton
                key={action.id}
                testId={`timeline-context-add-${action.id}`}
                onClick={() => onAdd(role, action.id, state.timeS)}
              >
                <span {...stylex.props(styles.flexCenterGap155)}>
                  {action.id === 'custom_route' ? <RouteIcon aria-hidden="true" className={stylex.props(styles.tight4).className} /> : null}
                  <span>{action.label}</span>
                </span>
              </ActionMenuButton>
            ))}
          </ActionMenuGroup>
        ))}
        <ActionMenuGroup label="Actor behavior">
          {gapPeerFor(role, document.data.roles) ? (
            <ActionMenuButton
              testId="action-palette-follow-gap"
              timelineAction="gap"
              onClick={() => onAddDirect(role, "gap", state.timeS)}
            >
              Follow gap
            </ActionMenuButton>
          ) : null}
          <ActionMenuButton
            testId="action-palette-become-absent"
            timelineAction="exist"
            onClick={() => onAddDirect(role, "exist", state.timeS)}
          >
            Become absent
          </ActionMenuButton>
        </ActionMenuGroup>
        <div {...stylex.props(styles.smColSpan2)}>
          <CanonicalInteractionComposer
            document={document}
            interactions={document.data.choreography.interactions}
            otherRole={gapPeerFor(role, document.data.roles)}
            role={role}
            testIdPrefix="timeline-context-canonical"
            time={state.timeS}
            onAdded={(interaction) => {
              onAddCanonical(interaction);
              onClose();
            }}
          />
        </div>
      </div>
    </div>,
    globalThis.document.body,
  );
}

function groupContextActions(actions: readonly ActionDefinition[]) {
  const order = ["Speed", "Direction", "Routes", "Signals"];
  const labels = [
    ...order.filter((label) => actions.some((action) => action.group === label)),
    ...new Set(actions.map((action) => action.group).filter((label) => !order.includes(label))),
  ];
  return labels.map((label) => ({
    label,
    actions: actions.filter((action) => action.group === label),
  }));
}

function ActionMenuGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section
      aria-label={label}
      {...stylex.props(styles.borderedPad2)}
      data-testid={`timeline-context-group-${label.toLowerCase().replaceAll(" ", "-")}`}
      role="group"
    >
      <h3 {...stylex.props(styles.capsSemibold2)}>
        {label}
      </h3>
      <div {...stylex.props(styles.gridCols2Gap1)}>{children}</div>
    </section>
  );
}

function ActionMenuButton({
  children,
  onClick,
  testId,
  timelineAction,
}: {
  children: React.ReactNode;
  onClick: () => void;
  testId?: string;
  timelineAction?: string;
}) {
  return (
    <button
      {...stylex.props(styles.borderedLeftText)}
      data-testid={testId}
      data-timeline-action={timelineAction}
      onClick={onClick}
      role="menuitem"
      type="button"
    >
      {children}
    </button>
  );
}

function TimelineActorCatalogIcon({ role }: { role: Role }) {
  const catalogId = catalogIdForRole(role);
  const iconProps = stylex.props(styles.catalogIcon);
  if (catalogId && isVehicleTimelineCatalogId(catalogId)) {
    return (
      <span aria-hidden="true" {...iconProps} data-testid={`timeline-actor-icon-${role.id}`}>
        <VehicleCatalogIcon id={catalogId} />
      </span>
    );
  }
  if (catalogId && isPedestrianTimelineCatalogId(catalogId)) {
    return (
      <span aria-hidden="true" {...stylex.props(styles.tight5)} data-testid={`timeline-actor-icon-${role.id}`}>
        <PedestrianCatalogIcon id={catalogId} />
      </span>
    );
  }
  if (catalogId && isObjectTimelineCatalogId(catalogId)) {
    return (
      <span aria-hidden="true" {...iconProps} data-testid={`timeline-actor-icon-${role.id}`}>
        <ObjectCatalogIcon id={catalogId} />
      </span>
    );
  }
  if (catalogId && isDynamicActorCatalogId(catalogId)) {
    return (
      <span aria-hidden="true" {...iconProps} data-testid={`timeline-actor-icon-${role.id}`}>
        <DynamicActorCatalogIcon id={catalogId} />
      </span>
    );
  }
  if (role.actor.class === "pedestrian") {
    return <PersonStanding aria-hidden="true" className={stylex.props(styles.tight2).className} data-testid={`timeline-actor-icon-${role.id}`} />;
  }
  if (role.actor.class === "static_object") {
    return <Box aria-hidden="true" className={stylex.props(styles.tight2).className} data-testid={`timeline-actor-icon-${role.id}`} />;
  }
  return <CarFront aria-hidden="true" className={stylex.props(styles.tight2).className} data-testid={`timeline-actor-icon-${role.id}`} />;
}

/** Display names shown on the timeline: catalog label plus a per-label ordinal. */
export function timelineActorLabels(roles: readonly Role[]): ReadonlyMap<string, string> {
  const counts = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const role of roles) {
    const base = timelineActorBaseLabel(role);
    const ordinal = (counts.get(base) ?? 0) + 1;
    counts.set(base, ordinal);
    labels.set(role.id, `${base} ${ordinal}`);
  }
  return labels;
}

function timelineActorBaseLabel(role: Role): string {
  const catalogId = catalogIdForRole(role);
  if (catalogId) {
    const entry = getEntry(catalogId);
    return entry.class === "pedestrian" ? "Pedestrian" : entry.label;
  }
  const semanticLabels: Partial<Record<Role["actor"]["class"], string>> = {
    bicycle: "Cyclist",
    bus: "Bus",
    car: "Car",
    motorcycle: "Motorcycle",
    pedestrian: "Pedestrian",
    scooter: "Scooter",
    static_object: "Object",
    truck: "Truck",
    van: "Van",
  };
  return semanticLabels[role.actor.class] ?? "Actor";
}

function catalogIdForRole(role: Role): CatalogId | null {
  const catalogId = role.actor.catalogId;
  return typeof catalogId === "string" && isCatalogId(catalogId) ? catalogId : null;
}

function isVehicleTimelineCatalogId(id: CatalogId): id is VehicleCatalogId {
  return (VEHICLE_CATALOG_IDS as readonly string[]).includes(id);
}

function isPedestrianTimelineCatalogId(id: CatalogId): id is PedestrianCatalogId {
  return (PEDESTRIAN_CATALOG_IDS as readonly string[]).includes(id);
}

function isObjectTimelineCatalogId(id: CatalogId): id is ObjectCatalogId {
  return (OBJECT_CATALOG_IDS as readonly string[]).includes(id);
}

function clampTime(timeS: number, window: TimelineRange): number {
  return Math.min(window.endMs / 1000, Math.max(window.startMs / 1000, timeS));
}

function gapPeerFor(role: Role, roles: readonly Role[]): Role | null {
  return (
    roles.find(
      (candidate) =>
        candidate.id !== role.id &&
        !candidate.actor.static,
    ) ?? null
  );
}

/** Indirection keeps the prop named `window` from shadowing the browser global in clip helpers. */
function windowThis(): Window {
  return globalThis.window;
}
