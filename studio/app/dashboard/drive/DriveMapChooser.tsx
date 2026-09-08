"use client";

import Image from "next/image";
import { CarFront, Check, Download, LoaderCircle, Lock, MapPin } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import { cn } from "@simforge-oss/studio-ui/lib/utils";
import { LocalMapPreparationPanel } from "@/app/components/LocalMapPreparationPanel";
import type { LocalMapDescriptor } from "@/app/lib/cloud/maps";
import { useStudioCloudStatus } from "@/app/lib/host/cloud";

/**
 * Whether a catalog map can open a Drive world on this computer right now:
 * its browser closure is installed and the current SimCloud authorization
 * still covers it. Same gate the Maps gallery applies to "Create scenario".
 */
export function driveMapUsable(map: LocalMapDescriptor, cloudState: string | undefined): boolean {
  return map.installed.browser && !map.locked && !(map.access === "cloud" && cloudState !== "connected");
}

/**
 * Explicit map choice for Drive. Every catalog map is listed with its local
 * state; the preparation panel (download, SimCloud connect) is the shared one
 * from the Maps app, so Drive never invents a second install flow.
 */
export function DriveMapChooser({
  maps,
  initialMapVersionId,
  opening,
  notice,
  onDrive,
}: {
  maps: LocalMapDescriptor[];
  initialMapVersionId: string | null;
  /** Map version currently being resolved into a drivable entry. */
  opening: string | null;
  notice: string | null;
  onDrive: (map: LocalMapDescriptor) => void;
}) {
  const cloudState = useStudioCloudStatus().status?.state;
  const sorted = useMemo(() => [...maps].sort((left, right) => left.label.localeCompare(right.label)), [maps]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = sorted.find((map) => map.mapVersionId === (selectedId ?? initialMapVersionId)) ?? sorted[0] ?? null;
  const usable = selected ? driveMapUsable(selected, cloudState) : false;

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#07100d] text-white" data-testid="drive-map-chooser">
      <div className="border-b border-white/10 px-6 py-4">
        <p className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.24em] text-[#E8E044]">
          <CarFront aria-hidden="true" className="size-3.5" />
          Choose a map to drive
        </p>
        <p className="mt-1 max-w-2xl text-sm text-white/60">
          Drive opens a live native world on a map prepared on this computer. Pick one, download it if it is not here
          yet, then place a vehicle and take the wheel.
        </p>
        {notice ? (
          <p className="mt-2 rounded-md border border-amber-300/30 bg-amber-300/10 px-3 py-2 text-xs text-amber-200" role="status">
            {notice}
          </p>
        ) : null}
      </div>
      {sorted.length === 0 ? (
        <div className="grid flex-1 place-items-center px-6 text-sm text-white/60" role="status">
          No maps are available on this computer or from SimCloud. Add a map in the Maps app first.
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <ul className="min-h-0 overflow-auto border-b border-white/10 p-3 lg:border-b-0 lg:border-r" aria-label="Available maps">
            {sorted.map((map) => {
              const ready = driveMapUsable(map, cloudState);
              const active = selected?.mapVersionId === map.mapVersionId;
              return (
                <li key={map.mapVersionId}>
                  <button
                    type="button"
                    aria-pressed={active}
                    onClick={() => setSelectedId(map.mapVersionId)}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044]",
                      active ? "border-[#E8E044]/60 bg-[#E8E044]/10" : "border-transparent hover:border-white/15 hover:bg-white/5",
                    )}
                  >
                    <span className="relative size-12 shrink-0 overflow-hidden rounded-md bg-white/10">
                      {map.thumbnailUrl ? (
                        <Image alt="" src={map.thumbnailUrl} fill sizes="48px" className="object-cover" unoptimized />
                      ) : (
                        <MapPin aria-hidden="true" className="absolute inset-0 m-auto size-5 text-white/40" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-white">{map.label}</span>
                      <span className="block truncate text-xs text-white/50">{map.locality || map.sourceMapId}</span>
                    </span>
                    <MapReadiness map={map} ready={ready} />
                  </button>
                </li>
              );
            })}
          </ul>
          {selected ? (
            <div className="flex min-h-0 flex-col overflow-auto p-6">
              <h2 className="text-2xl font-semibold tracking-tight">{selected.label}</h2>
              <p className="mt-1 flex items-center gap-1.5 text-sm text-white/60">
                <MapPin aria-hidden="true" className="size-3.5 text-[#E8E044]" />
                {selected.locality || selected.sourceMapId}
              </p>
              <LocalMapPreparationPanel className="mt-5" map={selected} />
              <div className="mt-6 flex items-center gap-3 border-t border-white/10 pt-4">
                <Button
                  type="button"
                  size="lg"
                  className="h-11 rounded-none bg-[#E8E044] px-5 text-sm font-semibold text-black hover:bg-[#f0e84e]"
                  disabled={!usable || opening !== null}
                  title={usable ? undefined : "Prepare this map on this computer before driving it."}
                  onClick={() => onDrive(selected)}
                >
                  {opening === selected.mapVersionId ? <LoaderCircle className="size-4 animate-spin" /> : <CarFront className="size-4" />}
                  {opening === selected.mapVersionId ? "Opening world…" : "Drive this map"}
                </Button>
                {!usable ? (
                  <span className="text-xs text-white/50">
                    {selected.locked || (selected.access === "cloud" && cloudState !== "connected")
                      ? "This map needs an active SimCloud connection."
                      : "Download the browser preview first."}
                  </span>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function MapReadiness({ map, ready }: { map: LocalMapDescriptor; ready: boolean }) {
  if (ready) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-emerald-300" title="Ready on this computer">
        <Check aria-hidden="true" className="size-3.5" /> Ready
      </span>
    );
  }
  if (map.locked || map.access === "cloud" && !map.installed.browser) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-white/50" title="Needs SimCloud">
        <Lock aria-hidden="true" className="size-3.5" /> SimCloud
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-white/50" title="Download needed">
      <Download aria-hidden="true" className="size-3.5" /> Download
    </span>
  );
}
