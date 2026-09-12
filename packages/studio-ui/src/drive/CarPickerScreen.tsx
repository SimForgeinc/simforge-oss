"use client";

import { ArrowLeft, Play } from "lucide-react";
import type { CatalogId } from "@simforge-oss/asset-catalog";

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
      className="relative min-h-svh overflow-hidden bg-[#050607] bg-[radial-gradient(120%_90%_at_78%_-10%,#153c4e_0%,#0b1a24_45%,#050607_100%)] px-6 py-10 text-white sm:px-10"
      data-testid="drive-car-picker"
    >
      <div className="mx-auto grid w-full max-w-6xl gap-8 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <section className="flex min-h-0 flex-col">
          <button
            className="flex items-center gap-1.5 self-start text-[11px] uppercase tracking-[0.18em] text-white/50 transition-colors hover:text-white/80"
            onClick={onBack}
            type="button"
          >
            <ArrowLeft className="size-3.5" aria-hidden="true" />
            {mapLabel}
          </button>
          <h1 className="mt-3 font-display text-3xl font-semibold tracking-tight">Pick a car</h1>
          <ul
            className="mt-5 min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1"
            data-testid="drive-car-list"
          >
            {vehicles.map((vehicle) => {
              const active = vehicle.catalogId === selectedId;
              return (
                <li key={vehicle.catalogId}>
                  <button
                    className={`flex w-full items-baseline gap-2 rounded-xl border px-3 py-2 text-left transition-colors ${
                      active
                        ? "border-[#E8E044]/70 bg-[#E8E044]/[0.08]"
                        : "border-white/10 bg-white/[0.02] hover:border-white/25"
                    }`}
                    data-catalog-id={vehicle.catalogId}
                    data-selected={active || undefined}
                    data-testid="drive-car-option"
                    onClick={() => onSelect(vehicle.catalogId)}
                    type="button"
                  >
                    <span className="min-w-0 flex-1 truncate text-sm text-white/85">{vehicle.label}</span>
                    {vehicle.modelled ? (
                      <span
                        className="rounded-sm bg-white/10 px-1 py-px font-mono text-[9px] uppercase tracking-[0.12em] text-white/50"
                        data-testid="drive-car-modelled"
                        title="Scanned vehicle model"
                      >
                        3D
                      </span>
                    ) : null}
                    <span className="font-mono text-[10px] tabular-nums text-white/35">
                      {vehicle.dims.l.toFixed(1)} m
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="flex min-h-0 flex-col">
          <div className="relative flex-1 overflow-hidden rounded-3xl border border-white/10 bg-black/30">
            {selected ? (
              <VehicleModelPreview
                catalogId={selected.catalogId}
                className="absolute inset-0"
                color={color}
                key={selected.catalogId}
              />
            ) : null}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2" data-testid="drive-paint-swatches">
              {DRIVE_PAINT_COLORS.map((swatch) => (
                <button
                  aria-label={`Paint ${swatch}`}
                  aria-pressed={swatch === color}
                  className={`size-7 rounded-full border-2 transition-transform ${
                    swatch === color ? "scale-110 border-white" : "border-white/20 hover:border-white/50"
                  }`}
                  data-color={swatch}
                  key={swatch}
                  onClick={() => onColorChange(swatch)}
                  style={{ backgroundColor: swatch }}
                  type="button"
                />
              ))}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate font-display text-lg text-white/90">{selected?.label ?? "—"}</p>
              <p className="truncate text-xs text-white/45">{selected?.description ?? ""}</p>
            </div>
            <button
              className="flex items-center gap-2 rounded-full bg-[#E8E044] px-6 py-2.5 font-display text-sm font-semibold text-black transition-opacity hover:opacity-90 disabled:opacity-40"
              data-testid="drive-start"
              disabled={!selected}
              onClick={onStart}
              type="button"
            >
              <Play className="size-4" aria-hidden="true" />
              Drive
            </button>
          </div>
        </section>
      </div>
    </main>
  );
}
