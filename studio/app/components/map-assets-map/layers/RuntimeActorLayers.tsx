import { useEffect, useState } from "react";
import * as stylex from "@stylexjs/stylex";
import { Marker } from "react-map-gl/maplibre";
import { ActorIcon } from "@/app/lib/scenario-editor/actor-svgs";
import {
  resolveMapMarkerScale,
  type MapMarkerSizingMode,
} from "@/app/lib/maps/frontend/map-marker-sizing";
import { styles } from "../map-canvas.stylex";

const HOLD_RING_INSET = 6;
const HOLD_RING_STROKE = 2.5;

export type RuntimeActorMarker = {
  id: string;
  label: string;
  longitude: number;
  latitude: number;
  kind: "vehicle" | "walker" | "prop";
  role: "subject" | "traffic" | "pedestrian" | "prop";
  blueprint?: string | null;
  selected: boolean;
  rotationDeg: number;
  color?: string | null;
  /**
   * Metres per second from the preview frame this marker was built from, or
   * null/absent for an authored actor that no run has driven yet. Present is
   * the signal that there IS a playback to report — see the 3D tag.
   */
  speedMps?: number | null;
  hideLabel?: boolean;
  preview?: boolean;
  dimmed?: boolean;
  comparisonRole?: "reference" | "candidate";
};

type RuntimeActorLayersProps = {
  actors: RuntimeActorMarker[];
  markerScale?: number;
  markerSizingMode?: MapMarkerSizingMode;
  mapZoom?: number | null;
  labelScale?: number;
  onMouseDownActor?: (payload: {
    actorId: string;
    clientX: number;
    clientY: number;
  }) => void;
  onContextMenuActor?: (payload: {
    actorId: string;
    clientX: number;
    clientY: number;
  }) => void;
  interactionMode?: "select" | "move";
};

function markerSize(actor: RuntimeActorMarker): number {
  if (actor.kind === "walker") return 18;
  if (actor.kind === "prop") return 20;
  return 56;
}

function actorWorldSizeMeters(actor: RuntimeActorMarker): number {
  if (actor.kind === "walker") return 0.75;
  if (actor.kind === "prop") return 1.2;

  const blueprint = actor.blueprint?.toLowerCase() ?? "";
  if (
    blueprint.includes("bicycle") ||
    blueprint.includes("bike") ||
    blueprint.includes("crossbike") ||
    blueprint.includes("gazelle")
  ) {
    return 1.8;
  }
  if (
    blueprint.includes("motorcycle") ||
    blueprint.includes("harley") ||
    blueprint.includes("yamaha") ||
    blueprint.includes("kawasaki") ||
    blueprint.includes("vespa")
  ) {
    return 2.3;
  }

  return 4.8;
}

function actorPixelBounds(actor: RuntimeActorMarker) {
  if (actor.kind === "walker") return { minPixelSize: 6, maxPixelSize: 30 };
  if (actor.kind === "prop") return { minPixelSize: 6, maxPixelSize: 40 };
  return { minPixelSize: 8, maxPixelSize: 96 };
}

/**
 * Exported so 3D mode can reuse it verbatim. 3D draws models in GL but keeps
 * the hover card and the hold ring as DOM — re-implementing text and an
 * animated ring in GL would be a rewrite of working chrome, and DOM-over-GL
 * stacking works in our favour here: chrome SHOULD float above the models.
 * The difference is the count: 3D renders one card and one ring at most,
 * instead of one marker per actor.
 */
export function HoverInfoCard({
  actor,
  size,
}: {
  actor: RuntimeActorMarker;
  size: number;
}) {
  return (
    <div
      role="tooltip"
      {...stylex.props(styles.actorCard)}
      // Clears the marker, whose size is the actor's own.
      style={{ bottom: `${size + 8}px` }}
    >
      <div {...stylex.props(styles.actorCardPlate)}>
        <div {...stylex.props(styles.actorCardTitle)}>{actor.label}</div>
        <div {...stylex.props(styles.actorCardHints)}>
          <span>
            <strong {...stylex.props(styles.actorCardKey)}>Right-click</strong>{" "}
            details
          </span>
          <span aria-hidden {...stylex.props(styles.actorCardSeparator)}>
            ·
          </span>
          <span>
            <strong {...stylex.props(styles.actorCardKeyAccent)}>Hold</strong>{" "}
            move
          </span>
        </div>
      </div>
      <span aria-hidden {...stylex.props(styles.actorCardTail)} />
    </div>
  );
}

/** Exported for 3D mode's chrome — see {@link HoverInfoCard}. */
export function HoldProgressRing({ size }: { size: number }) {
  const radius = size / 2 - HOLD_RING_INSET;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg width={size} height={size} {...stylex.props(styles.holdRing)}>
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="#ffffff"
        strokeWidth={HOLD_RING_STROKE}
        strokeLinecap="round"
        strokeDasharray={circumference}
        {...stylex.props(styles.holdRingTrack)}
        // The ring starts open at its own circumference; the animation closes
        // it over HOLD_TO_MOVE_MS and, being an animation, outranks this.
        style={{ strokeDashoffset: circumference }}
      />
    </svg>
  );
}

/** Exported so the opacity and colour rules can be pinned without a map. */
export function ActorMarkerView({
  actor,
  markerScale,
  markerSizingMode,
  mapZoom,
  labelScale: _labelScale,
  onMouseDownActor,
  onContextMenuActor,
}: {
  actor: RuntimeActorMarker;
  markerScale: number;
  markerSizingMode: MapMarkerSizingMode;
  mapZoom: number | null;
  labelScale: number;
  onMouseDownActor?: (payload: {
    actorId: string;
    clientX: number;
    clientY: number;
  }) => void;
  onContextMenuActor?: (payload: {
    actorId: string;
    clientX: number;
    clientY: number;
  }) => void;
}) {
  const size = markerSize(actor);
  const effectiveMarkerScale = resolveMapMarkerScale({
    mode: markerSizingMode,
    basePixelSize: size,
    worldSizeMeters: actorWorldSizeMeters(actor),
    latitude: actor.latitude,
    zoom: mapZoom,
    userScale: markerScale,
    ...actorPixelBounds(actor),
  });
  const [isHolding, setIsHolding] = useState(false);
  const [isHovering, setIsHovering] = useState(false);

  useEffect(() => {
    if (!isHolding) return;
    const stopHolding = () => setIsHolding(false);
    window.addEventListener("mouseup", stopHolding);
    return () => window.removeEventListener("mouseup", stopHolding);
  }, [isHolding]);

  return (
    <div
      data-runtime-actor-id={actor.id}
      /**
       * WHERE the editor thinks this actor is, in world coordinates.
       *
       * A headless check can read a marker's screen position, and gate C did —
       * then asserted the subject "moved" by comparing screen pixels between
       * screenshots. The camera FOLLOWS the subject, so its screen position is
       * pinned to the centre of the map viewport while it drives: C1's subject, a
       * highway car at speed, reported the identical pixel (1114, 595) at 7.5 s,
       * 15 s and 22.5 s. The assertion was measuring camera lag.
       *
       * Six decimals is ~0.1 m, which is finer than anything the gate asserts
       * and coarse enough that a stationary actor's attribute stops changing.
       */
      data-runtime-actor-lng={actor.longitude.toFixed(6)}
      data-runtime-actor-lat={actor.latitude.toFixed(6)}
      onMouseEnter={() => {
        if (!actor.preview) setIsHovering(true);
      }}
      onMouseLeave={() => setIsHovering(false)}
      onPointerEnter={() => {
        if (!actor.preview) setIsHovering(true);
      }}
      onPointerLeave={() => setIsHovering(false)}
      // A DOM marker sits above the map canvas, so MapLibre never sees this
      // right-click and the map's own contextmenu handler cannot route it —
      // 2D has to claim the gesture here. 3D goes through the map handler,
      // where the cars are GL geometry rather than DOM.
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (actor.preview) return;
        setIsHovering(false);
        onContextMenuActor?.({
          actorId: actor.id,
          clientX: event.clientX,
          clientY: event.clientY,
        });
      }}
      {...stylex.props(
        styles.actorMarker,
        actor.preview ? styles.actorPreview : styles.actorInteractive,
        // A parity pair is the one place transparency MEANS something: the
        // candidate is drawn over the reference so the offset between them is
        // readable, and that only works if the top one is see-through.
        //
        // Every traffic actor in a preview used to be 0.3 as well, which is not
        // the same kind of claim — it said "this car is ambient", and it said it
        // by making the car nearly invisible. Ambient traffic is most of what
        // moves in a run; a scenario is judged on how the subject meets it, and you
        // cannot judge what you cannot see. Subordination is the colour's job
        // now — subject yellow is reserved, traffic is hashed — and colour costs no
        // legibility to read.
        actor.comparisonRole === "candidate"
          ? styles.actorTranslucent
          : actor.comparisonRole === "reference"
            ? styles.actorOpaque
            : actor.dimmed
              ? styles.actorTranslucent
              : null,
      )}
      // The marker's footprint, and the zoom-resolved scale it is drawn at.
      style={{
        width: `${size}px`,
        height: `${size}px`,
        transform:
          effectiveMarkerScale !== 1
            ? `scale(${effectiveMarkerScale})`
            : undefined,
      }}
    >
      <button
        type="button"
        aria-label={actor.label}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (actor.preview) return;
          // Left button only: the right button opens details and must not also
          // arm hold-to-move, or a lingering right-click would pick the car up.
          if (event.button !== 0) return;
          setIsHolding(true);
          onMouseDownActor?.({
            actorId: actor.id,
            clientX: event.clientX,
            clientY: event.clientY,
          });
        }}
        {...stylex.props(styles.actorButton, styles.actorDefaultColor)}
        // Size follows the marker; the icon is inked and turned by the actor.
        style={{
          width: `${size}px`,
          height: `${size}px`,
          color: actor.color ?? undefined,
          transform: `rotate(${actor.rotationDeg}deg)`,
        }}
      >
        <ActorIcon
          kind={actor.kind}
          blueprint={actor.blueprint ?? undefined}
          variant={actor.preview ? "live" : "draft"}
          style={{ width: `${size}px`, height: `${size}px` }}
        />
      </button>
      {isHolding ? <HoldProgressRing size={size} /> : null}
      {isHovering && !isHolding ? (
        <HoverInfoCard
          actor={actor}
          size={size}
        />
      ) : null}
    </div>
  );
}

export function RuntimeActorLayers({
  actors,
  markerScale = 1,
  markerSizingMode = "map",
  mapZoom = null,
  labelScale = 1,
  onMouseDownActor,
  onContextMenuActor,
}: RuntimeActorLayersProps) {
  return (
    <>
      {actors.map((actor) => {
        // Keyed by identity, NOT by pose.
        //
        // `Marker` is memoized and already repositions in place — it calls
        // `marker.setLngLat(...)` in an effect when longitude/latitude change.
        // Folding the pose into the React key defeated exactly that: every
        // frame produced a new key, so React unmounted the old marker (which
        // runs `marker.remove()`, tearing down the DOM node and its portal) and
        // mounted a fresh one, re-rendering each actor's inline SVG. During
        // playback that is every marker, ~20 times a second — the pathology
        // `map-3d-scene.ts` already documents as the reason the 3D path does
        // not reuse this one.
        //
        // It also fixes behaviour: `ActorMarkerView` keeps `isHolding` and
        // `isHovering` in component state, which a remount destroyed, so hover
        // cards and press-and-hold could not survive a moving playhead.
        return (
          <Marker
            key={actor.id}
            anchor="center"
            longitude={actor.longitude}
            latitude={actor.latitude}
            pitchAlignment="map"
            rotationAlignment="map"
          >
            <ActorMarkerView
              actor={actor}
              markerScale={markerScale}
              markerSizingMode={markerSizingMode}
              mapZoom={mapZoom}
              labelScale={labelScale}
              onMouseDownActor={onMouseDownActor}
              onContextMenuActor={onContextMenuActor}
            />
          </Marker>
        );
      })}
    </>
  );
}
