"use client";

import Image from "next/image";
import { useEffect, useId, useState } from "react";
import { Box, CarFront, Crosshair, PersonStanding } from "lucide-react";
import {
  DRIVER_PROFILE_IDS,
  DRIVER_PROFILES,
  type DriverProfile,
} from "@simforge-oss/scenario";

import { Input } from "../../../components/ui/input";
import { CarlaCompatibilityPill } from "../../../components/CarlaCompatibilityPill";
import {
  carlaCompatibilityFor,
  loadCarlaCompatibility,
  type CarlaCompatibilityTable,
} from "../../../lib/scenario/carla-compatibility";
import { getEntry, type CatalogId } from "@simforge-oss/asset-catalog";
import type {
  ActorRecord,
  EditorController,
  EditorDocument,
} from "@simforge-oss/editor";
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
import {
  DynamicActorCatalogIcon,
  isDynamicActorCatalogId,
} from "../regions/DynamicActorCatalogIcon";
import { EditorDetailsPanel } from "./EditorDetailsPanel";
import { ActorSensorsSection } from "./ActorSensorsSection";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./ActorDetailsPanel.stylex";

const PAINTS: readonly { value: string; label: string }[] = [
  { value: "#2f4f74", label: "Navy" },
  { value: "#b4b8bd", label: "Silver" },
  { value: "#0d0f12", label: "Black" },
  { value: "#e8e9ea", label: "White" },
  { value: "#8c2f2f", label: "Red" },
  { value: "#2f6b3f", label: "Green" },
  { value: "#c98a2e", label: "Amber" },
  { value: "#4a3f6b", label: "Violet" },
];

const DRIVER_PROFILE_ICONS: Readonly<Record<DriverProfile, string>> = {
  lawful: "/scenario-editor/driver-behaviors/lawful.png",
  cautious: "/scenario-editor/driver-behaviors/cautious.png",
  assertive: "/scenario-editor/driver-behaviors/assertive.png",
  violator: "/scenario-editor/driver-behaviors/violator.png",
};

/** Fixed, viewport-level actor inspector shared by map and timeline selection. */
export function ActorDetailsPanel({
  actor,
  controller,
  document,
  onClose,
  showMotionControls = true,
}: {
  actor: ActorRecord;
  controller: EditorController | null;
  document: EditorDocument;
  onClose: () => void;
  showMotionControls?: boolean;
}) {
  const nameId = useId();
  const rotationId = useId();
  const speedId = useId();
  const entry = getEntry(actor.catalogId);
  const initialSpeedKph = Math.round(actor.initialSpeedKph ?? 0);
  const paint = actor.bodyColor ?? (
    typeof entry.defaultParams.color === "string" ? entry.defaultParams.color : "#E8E044"
  );
  // A vehicle earns its recording status by carrying sensors; there is nothing
  // to designate. `roles` holds the authored sensors, `actor` only a projection.
  const sensorCount = document.data.roles.find((role) => role.id === actor.id)?.actor.sensors.length ?? 0;
  // Whether this actor survives a CARLA render is the question an author asks
  // right before queueing a job, so it belongs on the actor, not only in the
  // Assets compatibility table. The lookup table loads once per session and
  // never blocks the inspector.
  const [carlaTable, setCarlaTable] = useState<CarlaCompatibilityTable | null>(null);
  const [carlaLoadFailed, setCarlaLoadFailed] = useState(false);
  useEffect(() => {
    let active = true;
    void loadCarlaCompatibility()
      .then((table) => { if (active) setCarlaTable(table); })
      .catch(() => { if (active) setCarlaLoadFailed(true); });
    return () => { active = false; };
  }, []);
  const carlaCompatibility = carlaTable
    ? carlaCompatibilityFor(actor.catalogId, carlaTable)
    : null;

  return (
    <EditorDetailsPanel
      ariaLabel={`${entry.label} actor details`}
      closeLabel="Close actor details"
      closeTestId="actor-details-close"
      headerFooter={(
        <fieldset {...stylex.props(styles.ruleT)}>
          <legend {...stylex.props(styles.srOnly)}>Color</legend>
          <div {...stylex.props(styles.flexCenterBetween)}>
            {PAINTS.map((option) => {
              const active = paint.toLowerCase() === option.value.toLowerCase();
              return (
                <button
                  aria-label={option.label}
                  aria-pressed={active}
                  {...stylex.props(styles.paintSwatch, active ? styles.paintSwatchActive : styles.paintSwatchIdle)}
                  key={option.value}
                  onClick={() => controller?.updateActorAppearance(actor.id, { bodyColor: option.value })}
                  style={{ backgroundColor: option.value }}
                  title={option.label}
                  type="button"
                />
              );
            })}
          </div>
        </fieldset>
      )}
      maxHeight="min(560px, calc(100vh - 96px))"
      onClose={onClose}
      preview={(
        <div
          {...stylex.props(styles.gridCenteredWide)}
          data-testid="actor-details-model-preview"
          style={{ color: paint }}
        >
          <ActorModelArtwork actor={actor} />
        </div>
      )}
      previewXstyle={styles.preview}
      testId="scenario-actor-details-panel"
    >
        {sensorCount > 0 ? (
          <div
            {...stylex.props(styles.flexCenterBordered)}
            data-testid="actor-records-scenario"
          >
            <span {...stylex.props(styles.gridCenteredTight)}>
              <Crosshair aria-hidden="true" className={stylex.props(styles.size4).className} />
            </span>
            <span {...stylex.props(styles.narrowable)}>
              <strong {...stylex.props(styles.blockWhiteSemibold)}>Records this scenario</strong>
              <span {...stylex.props(styles.block)}>
                {sensorCount} sensor{sensorCount === 1 ? "" : "s"} fitted
              </span>
            </span>
          </div>
        ) : null}

        <label {...stylex.props(styles.block2)} htmlFor={nameId}>
          <span {...stylex.props(styles.caps)}>Name</span>
          <Input
            id={nameId}
            xstyle={styles.xsWhite}
            placeholder={entry.label}
            value={actor.label ?? ""}
            onChange={(event) => controller?.setLabel(actor.id, event.target.value)}
          />
        </label>

        {carlaCompatibility?.status === "native" ? null : (
          <div data-testid={`actor-carla-compatibility-${actor.id}`}>
            <span {...stylex.props(styles.caps)}>CARLA</span>
            {carlaCompatibility ? (
              <div {...stylex.props(styles.stackedXs)}>
                <CarlaCompatibilityPill compatibility={carlaCompatibility} size="sm" />
                <p {...stylex.props(styles.textLeading3TextWhite35, styles.stackedXs)}>{carlaCompatibility.reason}</p>
              </div>
            ) : (
              <p {...stylex.props(styles.textLeading3TextWhite35, styles.stackedXs)}>
                {carlaLoadFailed ? "CARLA compatibility is unavailable." : "Checking CARLA compatibility…"}
              </p>
            )}
          </div>
        )}

        {actor.kind === "prop" ? (
          <label {...stylex.props(styles.block2)} htmlFor={rotationId}>
            <span {...stylex.props(styles.caps)}>Rotation</span>
            <div {...stylex.props(styles.rel)}>
              <Input
                aria-label="Rotation"
                id={rotationId}
                xstyle={styles.xsWhite2}
                step={5}
                type="number"
                value={roundDegrees(actor.headingRad)}
                onChange={(event) => {
                  const headingDeg = Number(event.target.value);
                  if (Number.isFinite(headingDeg)) {
                    controller?.setWorldPose(actor.id, { headingDeg });
                  }
                }}
              />
              <span {...stylex.props(styles.absInert)}>°</span>
            </div>
          </label>
        ) : null}

        {showMotionControls ? (
          <label {...stylex.props(styles.block2)} htmlFor={speedId}>
            <span {...stylex.props(styles.flexBetweenBaseline)}>
              <span {...stylex.props(styles.caps)}>Initial speed</span>
              <output {...stylex.props(styles.monoNums)} htmlFor={speedId}>
                {initialSpeedKph} <span {...stylex.props(styles.textTextWhite35)}>kph</span>
              </output>
            </span>
            <div {...stylex.props(styles.flexCenterGap2)}>
              <span {...stylex.props(styles.nums)}>0</span>
              <input
                aria-label="Initial speed"
                id={speedId}
                {...stylex.props(styles.fillRoundNarrowable)}
                max={160}
                min={0}
                step={1}
                type="range"
                value={initialSpeedKph}
                onChange={(event) => {
                  const nextSpeedKph = Number(event.target.value);
                  if (Number.isFinite(nextSpeedKph)) {
                    controller?.updateActorAppearance(actor.id, { initialSpeedKph: nextSpeedKph });
                  }
                }}
              />
              <span {...stylex.props(styles.nums)}>160</span>
            </div>
          </label>
        ) : null}

        {showMotionControls && actor.kind === "vehicle" ? (
          <fieldset aria-label="Driver behavior" data-testid="actor-driver-profile">
            <legend {...stylex.props(styles.caps)}>Driver behavior</legend>
            <div aria-label="Driver behavior choices" {...stylex.props(styles.gridCols1Gap15)} role="radiogroup">
              {DRIVER_PROFILE_IDS.map((id) => {
                const active = (actor.driverProfile ?? "lawful") === id;
                return (
                  <button
                    aria-checked={active}
                    aria-label={`${DRIVER_PROFILES[id].label} behavior`}
                    className={stylex.props(styles.profileOption, active ? styles.profileOptionActive : styles.profileOptionIdle).className}
                    key={id}
                    onClick={() => controller?.updateActorAppearance(actor.id, { driverProfile: id })}
                    role="radio"
                    type="button"
                  >
                    <Image
                      alt=""
                      aria-hidden="true"
                      className={stylex.props(styles.profileArt, active ? styles.profileArtActive : styles.profileArtIdle).className}
                      height={32}
                      src={DRIVER_PROFILE_ICONS[id]}
                      unoptimized
                      width={32}
                    />
                    <span {...stylex.props(styles.mediumTruncate)}>{DRIVER_PROFILES[id].label}</span>
                  </button>
                );
              })}
            </div>
            <span {...stylex.props(styles.block3)}>
              {DRIVER_PROFILES[actor.driverProfile ?? "lawful"].description}
            </span>
          </fieldset>
        ) : null}

        <ActorSensorsSection actor={actor} document={document} />

    </EditorDetailsPanel>
  );
}

function ActorModelArtwork({ actor }: { actor: ActorRecord }) {
  const catalogId = actor.catalogId;
  if (isVehicleCatalogId(catalogId)) {
    return <VehicleCatalogIcon id={catalogId} />;
  }
  if (isPedestrianCatalogId(catalogId)) {
    return <div {...stylex.props(styles.h14W14)}><PedestrianCatalogIcon id={catalogId} /></div>;
  }
  if (isObjectCatalogId(catalogId)) {
    return <ObjectCatalogIcon id={catalogId} />;
  }
  if (isDynamicActorCatalogId(catalogId)) {
    return <DynamicActorCatalogIcon id={catalogId} />;
  }
  if (actor.kind === "pedestrian") return <PersonStanding aria-hidden="true" className={stylex.props(styles.size10).className} />;
  if (actor.kind === "prop") return <Box aria-hidden="true" className={stylex.props(styles.size10).className} />;
  return <CarFront aria-hidden="true" className={stylex.props(styles.size10).className} />;
}

function roundDegrees(radians: number) {
  return Math.round((radians * 180 / Math.PI) * 10) / 10;
}

function isVehicleCatalogId(id: CatalogId): id is VehicleCatalogId {
  return (VEHICLE_CATALOG_IDS as readonly string[]).includes(id);
}

function isPedestrianCatalogId(id: CatalogId): id is PedestrianCatalogId {
  return (PEDESTRIAN_CATALOG_IDS as readonly string[]).includes(id);
}

function isObjectCatalogId(id: CatalogId): id is ObjectCatalogId {
  return (OBJECT_CATALOG_IDS as readonly string[]).includes(id);
}
