"use client";

import { CircleAlert, LoaderCircle, MapPin } from "lucide-react";

/** One installed map offered as a place to drive. */
export interface DriveMapOption {
  mapVersionId: string;
  label: string;
  locality: string | null;
  thumbnailUrl: string | null;
}

/**
 * First screen: where to drive.
 *
 * Only installed maps appear — this is a game, so there is nothing to download
 * here and nothing to explain about closures. Props only; the host owns the
 * catalog fetch.
 */
export function MapPickerScreen({ maps, loading, error, onPick }: {
  maps: readonly DriveMapOption[];
  loading: boolean;
  error: string | null;
  onPick: (mapVersionId: string) => void;
}) {
  return (
    <main
      className="relative min-h-svh overflow-hidden bg-[#050607] bg-[radial-gradient(120%_90%_at_78%_-10%,#153c4e_0%,#0b1a24_45%,#050607_100%)] px-6 py-12 text-white sm:px-10"
      data-testid="drive-map-picker"
    >
      <div className="mx-auto w-full max-w-5xl">
        <p className="font-meta text-[10px] font-bold uppercase tracking-[0.22em] text-[#E8E044]">Drive</p>
        <h1 className="mt-2 font-display text-4xl font-semibold tracking-tight">Pick a map</h1>
        <p className="mt-2 max-w-xl text-sm leading-6 text-white/55">
          Installed maps only. Download more from the map gallery and they show up here.
        </p>

        {error ? (
          <p className="mt-8 flex items-center gap-2 text-sm text-red-300" role="alert">
            <CircleAlert className="size-4" aria-hidden="true" />
            {error}
          </p>
        ) : loading ? (
          <p className="mt-8 flex items-center gap-2 text-sm text-white/45" role="status">
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            Loading installed maps…
          </p>
        ) : maps.length === 0 ? (
          <p className="mt-8 text-sm text-white/55" role="status">
            No maps are installed on this machine yet.
          </p>
        ) : (
          <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {maps.map((map) => (
              <li key={map.mapVersionId}>
                <button
                  className="group flex h-full w-full flex-col overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] text-left transition-colors hover:border-[#E8E044]/70 hover:bg-[#E8E044]/[0.06]"
                  data-map-version-id={map.mapVersionId}
                  data-testid="drive-map-card"
                  onClick={() => onPick(map.mapVersionId)}
                  type="button"
                >
                  <span className="relative block aspect-[16/9] overflow-hidden bg-black/40">
                    {map.thumbnailUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- host-served thumbnail, no loader needed
                      <img alt="" className="size-full object-cover" src={map.thumbnailUrl} />
                    ) : (
                      <span className="grid size-full place-items-center text-white/20">
                        <MapPin className="size-8" aria-hidden="true" />
                      </span>
                    )}
                  </span>
                  <span className="flex flex-col px-4 py-3">
                    <span className="truncate font-display text-base font-medium text-white/90">{map.label}</span>
                    <span className="mt-0.5 truncate text-xs text-white/40">{map.locality ?? "Unknown locality"}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
