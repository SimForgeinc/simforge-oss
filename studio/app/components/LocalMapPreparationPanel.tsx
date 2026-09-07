"use client";

import { Check, Cpu, Download, ExternalLink, Globe, LoaderCircle, Lock } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import { cn } from "@simforge-oss/studio-ui/lib/utils";
import { useStudioCloudStatus } from "@/app/lib/host/cloud";
import type { LocalMapDescriptor, LocalMapInstallState } from "@/app/lib/cloud/maps";
import { followMapInstall, readMapInstall, startMapInstall, type LocalMapInstallProfile } from "@/app/lib/host/map-install";

const REQUIRES_CONNECTION = "map_requires_cloud_connection";

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

type MapInstall = {
  status: LocalMapInstallState | null;
  error: string | null;
  starting: boolean;
  start(): Promise<void>;
};

/**
 * Follows one profile's materialization on the local service. Polls only
 * while the service reports `materializing`; stops on settle or unmount, so
 * an idle gallery never keeps asking.
 */
function useMapInstall(mapVersionId: string, profile: LocalMapInstallProfile): MapInstall {
  const [status, setStatus] = useState<LocalMapInstallState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const controller = useRef<AbortController | null>(null);

  const follow = useCallback(
    async (first: Promise<LocalMapInstallState>) => {
      controller.current?.abort();
      const own = new AbortController();
      controller.current = own;
      try {
        await followMapInstall(mapVersionId, profile, first, own.signal, setStatus);
        setError(null);
      } catch (reason) {
        if (own.signal.aborted) return;
        setError(reason instanceof Error ? reason.message : "Map installation status is unavailable.");
      }
    },
    [mapVersionId, profile],
  );

  useEffect(() => {
    setStatus(null);
    setError(null);
    const own = new AbortController();
    void follow(readMapInstall(mapVersionId, profile, own.signal));
    return () => {
      own.abort();
      controller.current?.abort();
    };
  }, [follow, mapVersionId, profile]);

  const start = useCallback(async () => {
    setStarting(true);
    setError(null);
    try {
      await follow(startMapInstall(mapVersionId, profile));
    } finally {
      setStarting(false);
    }
  }, [follow, mapVersionId, profile]);

  return { status, error, starting, start };
}

function ProfileRow({
  icon,
  label,
  detail,
  install,
  installed,
  locked,
  actionLabel,
}: {
  icon: ReactNode;
  label: string;
  detail: string;
  install: MapInstall;
  installed: boolean;
  locked: boolean;
  actionLabel: string;
}) {
  const { status, error, starting, start } = install;
  const ready = status?.state === "ready" || (status?.state === "idle" && installed);
  const running = status?.state === "materializing";
  const requiresConnection = status?.state === "error" && status.message === REQUIRES_CONNECTION;
  const progress = status?.progress;
  const percent = progress && progress.bytes > 0
    ? Math.min(100, Math.round((progress.completedBytes / progress.bytes) * 100))
    : progress && progress.members > 0
      ? Math.min(100, Math.round((progress.completedMembers / progress.members) * 100))
      : null;

  return (
    <div className="flex flex-wrap items-center gap-3 py-2" data-testid={`map-install-${label.toLowerCase().replace(/\s+/g, "-")}`} data-install-state={ready ? "ready" : status?.state ?? "loading"}>
      <span className="grid size-7 shrink-0 place-items-center text-[#E8E044]">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-xs font-semibold text-white/85">
          {label}
          <span
            className={cn(
              "rounded-full border px-2 py-0.5 font-meta text-[8px] font-bold uppercase tracking-[0.13em]",
              ready ? "border-[#E8E044]/30 bg-[#E8E044]/10 text-[#E8E044]" : "border-white/10 text-white/45",
            )}
          >
            {status === null
              ? "Checking"
              : ready
                ? "On this computer"
                : running
                  ? percent === null ? "Downloading" : `${percent}%`
                  : locked || requiresConnection
                    ? "Needs account"
                    : status.state === "error"
                      ? "Failed"
                      : "Not downloaded"}
          </span>
        </p>
        <p className="mt-0.5 text-[11px] leading-4 text-white/45">
          {running && progress
            ? `${formatBytes(progress.completedBytes)} of ${formatBytes(progress.bytes)} · ${progress.completedMembers} / ${progress.members} files`
            : ready && status.directory
              ? status.directory
              : status?.state === "error" && !requiresConnection
                ? status.message ?? "The local service reported an error."
                : error ?? detail}
        </p>
        {running ? (
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/10" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined} aria-label={`${label} download`}>
            <div className="h-full rounded-full bg-[#E8E044] transition-[width] duration-500" style={{ width: `${percent ?? 0}%` }} />
          </div>
        ) : null}
      </div>
      {!ready && !running && !locked && !requiresConnection && status !== null ? (
        <Button
          className="h-8 gap-1.5 rounded-full border-white/15 bg-transparent px-3 text-[11px] text-white/80 hover:bg-white/5 hover:text-white"
          disabled={starting}
          onClick={() => void start()}
          type="button"
          variant="outline"
        >
          {starting ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" /> : <Download className="size-3.5" aria-hidden="true" />}
          {status.state === "error" ? "Retry" : actionLabel}
        </Button>
      ) : ready ? (
        <Check className="size-4 text-[#E8E044]" aria-hidden="true" />
      ) : running ? (
        <LoaderCircle className="size-4 animate-spin text-white/45" aria-hidden="true" />
      ) : null}
    </div>
  );
}

/**
 * What of this map lives on this computer, and the explicit controls to get
 * the rest: the browser closure for the viewport and the semantic closure the
 * local Bevy renderer needs. Every state comes from the local service; nothing
 * here claims a map is ready before its closure is complete and registered.
 */
export function LocalMapPreparationPanel({ map, className }: { map: LocalMapDescriptor; className?: string }) {
  const cloud = useStudioCloudStatus();
  const router = useRouter();
  const browser = useMapInstall(map.mapVersionId, "browser");
  const semantic = useMapInstall(map.mapVersionId, "semantic");
  const requiresConnection = [browser.status, semantic.status].some(
    (status) => status?.state === "error" && status.message === REQUIRES_CONNECTION,
  );
  const locked = map.locked || (map.access === "cloud" && cloud.status?.state !== "connected") || requiresConnection;
  useEffect(() => {
    if (browser.status?.state === "ready" || semantic.status?.state === "ready") router.refresh();
  }, [browser.status?.state, semantic.status?.state, router]);

  return (
    <div
      className={cn("pointer-events-auto max-w-xl border-t border-white/15 pt-3", className)}
      data-testid="local-map-preparation"
      data-map-access={map.access}
      data-map-locked={String(locked)}
    >
      <p className="font-meta text-[9px] font-bold uppercase tracking-[0.16em] text-white/40">On this computer</p>
      {locked ? (
        <div className="mt-2 flex flex-wrap items-center gap-3 rounded-2xl border border-white/10 bg-black/35 px-4 py-3 backdrop-blur-md">
          <Lock className="size-4 shrink-0 text-[#E8E044]" aria-hidden="true" />
          <p className="min-w-0 flex-1 text-xs leading-5 text-white/65">
            {cloud.status?.state === "expired"
              ? "Your SimCloud session expired. Connect again to use this map on this computer."
              : cloud.status?.state === "connecting"
                ? "Waiting for SimCloud approval in your browser…"
                : "This map needs a SimCloud account. Connect to download and render it on this computer."}
          </p>
          {cloud.status?.state === "connecting" ? (
            <LoaderCircle className="size-4 animate-spin text-white/45" aria-hidden="true" />
          ) : (
            <Button
              className="h-8 gap-1.5 rounded-full border-[#E8E044]/30 bg-[#E8E044]/10 px-3 text-[11px] text-[#E8E044] hover:bg-[#E8E044]/20"
              disabled={cloud.loading || cloud.status === null}
              onClick={() => void cloud.connect()}
              type="button"
              variant="outline"
            >
              <ExternalLink className="size-3.5" aria-hidden="true" />
              {cloud.status?.state === "expired" || cloud.status?.state === "error" ? "Connect again" : "Connect to SimCloud"}
            </Button>
          )}
          {cloud.error ? <p className="w-full text-[11px] text-amber-300/90" role="alert">{cloud.error}</p> : null}
        </div>
      ) : (
        <div className="mt-1 divide-y divide-white/10">
          <ProfileRow
            actionLabel="Download for preview"
            detail="Viewport assets for browsing and authoring on this map."
            icon={<Globe className="size-4" aria-hidden="true" />}
            install={browser}
            installed={map.installed.browser}
            label="Browser preview"
            locked={locked}
          />
          <ProfileRow
            actionLabel="Prepare for local render"
            detail="Full semantic closure the local Bevy renderer reads directly from disk."
            icon={<Cpu className="size-4" aria-hidden="true" />}
            install={semantic}
            installed={map.installed.semantic}
            label="Local render"
            locked={locked}
          />
        </div>
      )}
    </div>
  );
}
