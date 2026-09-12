"use client";

import { ArrowLeft, Play } from "lucide-react";
import * as stylex from "@stylexjs/stylex";
import type { CatalogId } from "@simforge-oss/asset-catalog";

import { DriveButton, driveChrome } from "./chrome";
import { driveColors, driveRadius, driveText } from "./drive.stylex";
import { VehicleModelPreview } from "./VehicleModelPreview";

/** One drivable catalog vehicle. */
export interface DriveVehicleOption {
  catalogId: CatalogId;
  label: string;
  description: string;
  dims: { l: number; w: number; h: number };
  /**
   * The catalog entry carries a scanned vehicle model (the CARLA pack) rather
   * than only the procedural builder. Worth showing: the two look nothing
   * alike from the cockpit, and a player picking a car is choosing what they
   * will be looking at for the next hour.
   */
  modelled: boolean;
}

/** Paint choices offered for the body. Five is enough to feel like a choice and fit one row. */
export const DRIVE_PAINT_COLORS: readonly string[] = [
  "#d8dee6",
  "#1c1f24",
  "#b3121f",
  "#1b4f9c",
  "#e0a21a",
];

const styles = stylex.create({
  screen: {
    paddingInline: { default: "1.5rem", "@media (min-width: 640px)": "2.5rem" },
    paddingBlock: "2.5rem",
  },
  /**
   * List beside stage.
   *
   * One column until there is room for both: below the breakpoint the car list
   * and the turntable stacked is still a usable pick, and a 22rem list squeezed
   * next to a preview is not.
   */
  layout: {
    marginInline: "auto",
    display: "grid",
    width: "100%",
    maxWidth: "72rem",
    gap: "2rem",
    gridTemplateColumns: {
      default: null,
      "@media (min-width: 1024px)": "minmax(0, 22rem) minmax(0, 1fr)",
    },
  },
  pane: {
    display: "flex",
    minHeight: 0,
    flexDirection: "column",
  },

  /** Back to the map, labelled with the map you would be leaving. */
  back: {
    display: "flex",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: "0.375rem",
    borderStyle: "none",
    backgroundColor: "transparent",
    paddingInline: 0,
    paddingBlock: 0,
    fontSize: driveText.sizeMeta,
    textTransform: "uppercase",
    letterSpacing: driveText.trackLabel,
    color: {
      default: driveColors.textCaption,
      ":hover": driveColors.textVehicle,
    },
    cursor: "pointer",
    transitionProperty: "color",
    transitionDuration: "150ms",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
  },
  backIcon: {
    width: "0.875rem",
    height: "0.875rem",
    flexShrink: 0,
  },
  title: {
    marginTop: "0.75rem",
    fontFamily: driveText.fontDisplay,
    fontSize: "1.875rem",
    lineHeight: 1.1,
    fontWeight: 600,
    letterSpacing: "-0.025em",
  },
  /** How many cars are on offer: the list is long, so say so before scrolling. */
  count: {
    marginTop: "0.25rem",
    fontVariantNumeric: "tabular-nums",
  },

  list: {
    marginBlock: 0,
    marginTop: "1.25rem",
    display: "flex",
    minHeight: 0,
    flex: 1,
    flexDirection: "column",
    gap: "0.375rem",
    listStyle: "none",
    overflowY: "auto",
    paddingInline: 0,
    paddingRight: "0.25rem",
    /** The list is tall on desktop and unbounded when stacked; cap the stack. */
    maxHeight: { default: "22rem", "@media (min-width: 1024px)": "none" },
  },
  /**
   * A car row.
   *
   * Selected is the accent edge and wash the rest of Drive uses for "this one
   * is live"; unselected is a hairline over almost-nothing so 37 rows do not
   * read as 37 buttons.
   */
  row: {
    display: "flex",
    width: "100%",
    alignItems: "baseline",
    gap: "0.5rem",
    borderWidth: "1px",
    borderStyle: "solid",
    borderRadius: driveRadius.row,
    paddingInline: "0.75rem",
    paddingBlock: "0.5rem",
    textAlign: "left",
    cursor: "pointer",
    transitionProperty: "color, background-color, border-color",
    transitionDuration: "150ms",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    outlineStyle: { default: "none", ":focus-visible": "solid" },
    outlineWidth: "2px",
    outlineColor: driveColors.accent,
    outlineOffset: "2px",
  },
  rowActive: {
    borderColor: driveColors.accentBorder,
    backgroundColor: driveColors.accentWashRow,
  },
  rowIdle: {
    borderColor: {
      default: driveColors.lineFaint,
      ":hover": driveColors.lineHoverCard,
    },
    backgroundColor: driveColors.glass,
  },
  rowLabel: {
    minWidth: 0,
    flex: 1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "0.875rem",
    lineHeight: "1.25rem",
    color: driveColors.textStrong,
  },
  rowLabelActive: { color: driveColors.accent },
  /** The scanned-model tag. */
  tag: {
    flexShrink: 0,
    borderRadius: driveRadius.tag,
    backgroundColor: driveColors.glassTag,
    paddingInline: "0.25rem",
    paddingBlock: "1px",
    fontFamily: driveText.fontMono,
    fontSize: driveText.sizeTag,
    textTransform: "uppercase",
    letterSpacing: driveText.trackTag,
    color: driveColors.textCaption,
  },
  /** Vehicle length: the one dimension that decides if it fits a lane. */
  footprint: {
    flexShrink: 0,
    fontFamily: driveText.fontMono,
    fontSize: driveText.sizeMicro,
    fontVariantNumeric: "tabular-nums",
    color: driveColors.textGhost,
  },

  /** The turntable stage. */
  stage: {
    position: "relative",
    flex: 1,
    minHeight: { default: "18rem", "@media (min-width: 1024px)": "24rem" },
    overflow: "hidden",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: driveColors.lineFaint,
    borderRadius: driveRadius.dialog,
    backgroundColor: driveColors.panelStage,
  },
  preview: {
    position: "absolute",
    inset: 0,
  },
  /** Nothing picked yet: say it on the stage rather than leaving a black box. */
  stageEmpty: {
    display: "grid",
    height: "100%",
    placeItems: "center",
    fontSize: driveText.sizeMeta,
    textTransform: "uppercase",
    letterSpacing: driveText.trackLabel,
    color: driveColors.textPlaceholder,
  },

  tray: {
    marginTop: "1rem",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "1rem",
  },
  swatches: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
  },
  swatch: {
    width: "1.75rem",
    height: "1.75rem",
    borderWidth: "2px",
    borderStyle: "solid",
    borderRadius: driveRadius.pill,
    padding: 0,
    cursor: "pointer",
    transitionProperty: "transform, border-color",
    transitionDuration: "150ms",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    outlineStyle: { default: "none", ":focus-visible": "solid" },
    outlineWidth: "2px",
    outlineColor: driveColors.accent,
    outlineOffset: "2px",
  },
  swatchActive: {
    transform: "scale(1.1)",
    borderColor: driveColors.textPrimary,
  },
  swatchIdle: {
    transform: "scale(1)",
    borderColor: {
      default: driveColors.textPlaceholder,
      ":hover": driveColors.lineHover,
    },
  },

  identity: {
    minWidth: 0,
    flex: 1,
  },
  name: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontFamily: driveText.fontDisplay,
    fontSize: "1.125rem",
    lineHeight: "1.75rem",
    color: driveColors.textTitle,
  },
  description: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    color: driveColors.textDim,
  },
  /** Footprint in full, for the car that is actually going to be driven. */
  dims: {
    marginTop: "0.125rem",
    fontFamily: driveText.fontMono,
    fontSize: driveText.sizeTag,
    letterSpacing: driveText.trackTag,
    fontVariantNumeric: "tabular-nums",
    color: driveColors.textPlaceholder,
  },
  playIcon: {
    width: "1rem",
    height: "1rem",
  },
});

/**
 * Second screen: which car, what colour.
 *
 * The grid is text-and-footprint so 37 entries stay scannable; the selected car
 * gets the live model. Props only — the host owns the catalog and the session.
 */
export function CarPickerScreen({
  vehicles,
  selectedId,
  color,
  mapLabel,
  onSelect,
  onColorChange,
  onBack,
  onStart,
}: {
  vehicles: readonly DriveVehicleOption[];
  selectedId: CatalogId | null;
  color: string;
  mapLabel: string;
  onSelect: (catalogId: CatalogId) => void;
  onColorChange: (color: string) => void;
  onBack: () => void;
  onStart: () => void;
}) {
  const selected = vehicles.find((vehicle) => vehicle.catalogId === selectedId) ?? null;
  return (
    <main
      {...stylex.props(driveChrome.screen, styles.screen)}
      data-testid="drive-car-picker"
    >
      <div {...stylex.props(styles.layout)}>
        <section {...stylex.props(styles.pane)}>
          <button {...stylex.props(styles.back)} onClick={onBack} type="button">
            <ArrowLeft {...stylex.props(styles.backIcon)} aria-hidden="true" />
            {mapLabel}
          </button>
          <h1 {...stylex.props(styles.title)}>Pick a car</h1>
          <p {...stylex.props(driveChrome.sectionLabel, styles.count)}>
            {vehicles.length} vehicles
          </p>
          <ul {...stylex.props(styles.list)} data-testid="drive-car-list">
            {vehicles.map((vehicle) => {
              const active = vehicle.catalogId === selectedId;
              return (
                <li key={vehicle.catalogId}>
                  <button
                    {...stylex.props(styles.row, active ? styles.rowActive : styles.rowIdle)}
                    aria-pressed={active}
                    data-catalog-id={vehicle.catalogId}
                    data-selected={active || undefined}
                    data-testid="drive-car-option"
                    onClick={() => onSelect(vehicle.catalogId)}
                    type="button"
                  >
                    <span {...stylex.props(styles.rowLabel, active && styles.rowLabelActive)}>
                      {vehicle.label}
                    </span>
                    {vehicle.modelled ? (
                      <span
                        {...stylex.props(styles.tag)}
                        data-testid="drive-car-modelled"
                        title="Scanned vehicle model"
                      >
                        3D
                      </span>
                    ) : null}
                    <span {...stylex.props(styles.footprint)}>
                      {vehicle.dims.l.toFixed(1)} m
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        <section {...stylex.props(styles.pane)}>
          <div {...stylex.props(styles.stage)}>
            {selected ? (
              <VehicleModelPreview
                catalogId={selected.catalogId}
                color={color}
                key={selected.catalogId}
                xstyle={styles.preview}
              />
            ) : (
              <p {...stylex.props(styles.stageEmpty)}>No car selected</p>
            )}
          </div>
          <div {...stylex.props(styles.tray)}>
            <div {...stylex.props(styles.swatches)} data-testid="drive-paint-swatches">
              {DRIVE_PAINT_COLORS.map((swatch) => (
                <button
                  {...stylex.props(
                    styles.swatch,
                    swatch === color ? styles.swatchActive : styles.swatchIdle,
                  )}
                  aria-label={`Paint ${swatch}`}
                  aria-pressed={swatch === color}
                  data-color={swatch}
                  key={swatch}
                  onClick={() => onColorChange(swatch)}
                  style={{ backgroundColor: swatch }}
                  type="button"
                />
              ))}
            </div>
            <div {...stylex.props(styles.identity)}>
              <p {...stylex.props(styles.name)}>{selected?.label ?? "—"}</p>
              <p {...stylex.props(styles.description)}>{selected?.description ?? ""}</p>
              <p {...stylex.props(styles.dims)}>
                {selected
                  ? `${selected.dims.l.toFixed(2)} × ${selected.dims.w.toFixed(2)} × ${selected.dims.h.toFixed(2)} m`
                  : ""}
              </p>
            </div>
            <DriveButton
              data-testid="drive-start"
              disabled={!selected}
              onClick={onStart}
              tone="primary"
            >
              <Play {...stylex.props(styles.playIcon)} aria-hidden="true" />
              Drive
            </DriveButton>
          </div>
        </section>
      </div>
    </main>
  );
}
