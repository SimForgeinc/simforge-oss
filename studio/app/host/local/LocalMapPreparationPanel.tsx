"use client";

import { Check, Cpu, Download, Globe, LoaderCircle, Lock, LogIn } from "lucide-react";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode, type CSSProperties } from "react";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import { mergeStyleProps } from "@simforge-oss/studio-ui/components/stylex";
import { useStudioCloudStatus } from "@/app/lib/host/cloud";
import type { LocalMapDescriptor, LocalMapInstallState } from "@/app/lib/cloud/maps";
import { followMapInstall, mapInstallErrorMessage, readMapInstall, startMapInstall, type LocalMapInstallProfile } from "@/app/lib/host/map-install";
import { setup } from "@/app/components/setup-preparation.stylex";
import { hairline, motionRecipe, typography } from "@simforge-oss/studio-ui/stylex/recipes.stylex";

const REQUIRES_CONNECTION = "map_requires_cloud_connection";

/**
 * Where these map bytes actually are. This panel is served BY the Studio
 * host and reports the host's filesystem, so "on this computer" is true only
 * when the host is this computer. A shell attached to a host on another
 * machine would otherwise label someone else's disk as the user's, the same
 * mistake the shell menu already avoids ("remote, not managed by this app").
 *
 * The page's own origin is the honest signal: it is the authority this client
 * reached the host on. Read after mount, because the server render cannot
 * know which authority the client used, and presentation only — nothing here
 * authorizes anything.
 * @returns the host's origin when it is not this machine, else null
 */
function useRemoteHostOrigin(): string | null {
  const [origin, setOrigin] = useState<string | null>(null);
  useEffect(() => {
    const local = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(window.location.hostname);
    setOrigin(local ? null : window.location.origin);
  }, []);
  return origin;
}

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
  locked,
  actionLabel,
}: {
  icon: ReactNode;
  label: string;
  detail: string;
  install: MapInstall;
  locked: boolean;
  actionLabel: string;
}) {
  const { status, error, starting, start } = install;
  const remoteHost = useRemoteHostOrigin();
  // `installed` is the service's own verdict on the closure — every member in
  // the map cache — so this row no longer has to guess from the catalog's
  // entry-point flag whether an `idle` profile is actually here.
  const ready = status?.state === "ready" || status?.state === "installed";
  const running = status?.state === "materializing";
  const requiresConnection = status?.state === "error" && status.message === REQUIRES_CONNECTION;
  const progress = status?.progress;
  const percent = progress && progress.bytes > 0
    ? Math.min(100, Math.round((progress.completedBytes / progress.bytes) * 100))
    : progress && progress.members > 0
      ? Math.min(100, Math.round((progress.completedMembers / progress.members) * 100))
      : null;
  return (
    <div {...stylex.props(setup.row)} data-testid={`map-install-${label.toLowerCase().replace(/\s+/g, "-")}`} data-install-state={ready ? "ready" : status?.state ?? "loading"}>
      <span {...stylex.props(setup.rowIcon)}>{icon}</span>
      <div {...stylex.props(setup.rowBody)}>
        <p {...stylex.props(setup.rowTitle)}>
          {label}
          <span {...stylex.props([typography.tag, hairline.all, setup.pill], ready && setup.pillReady)}>
            {status === null ? "Checking" : ready ? (remoteHost ? "On the Studio host" : "On this computer") : running ? percent === null ? "Downloading" : `${percent}%` : locked || requiresConnection ? "Needs account" : status.state === "error" ? "Failed" : "Not downloaded"}
          </span>
        </p>
        <p {...stylex.props(setup.rowDetail)}>
          {running && progress ? progress.members === 0 ? "Working out which files this map needs…" : `${formatBytes(progress.completedBytes)} of ${formatBytes(progress.bytes)} · ${progress.completedMembers} / ${progress.members} files` : ready && status.directory ? status.directory : status?.state === "error" && !requiresConnection ? mapInstallErrorMessage(status.message) : error ?? detail}
        </p>
        {running ? <div {...stylex.props(setup.track)} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined} aria-label={`${label} download`}><div {...stylex.props(setup.fill)} style={{ "--map-install-progress": `${percent ?? 0}%` } as CSSProperties} /></div> : null}
      </div>
      {!ready && !running && !locked && !requiresConnection && status !== null ? (
        <Button xstyle={setup.compactButton} disabled={starting} onClick={() => void start()} type="button" variant="accentOutline">
          {starting ? <LoaderCircle {...stylex.props(setup.iconSmall, motionRecipe.spin)} aria-hidden="true" /> : <Download {...stylex.props(setup.iconSmall)} aria-hidden="true" />}
          {status.state === "error" ? "Retry" : actionLabel}
        </Button>
      ) : ready ? <Check {...stylex.props(setup.iconSmall)} aria-hidden="true" /> : running ? <LoaderCircle {...stylex.props(setup.iconSmall, motionRecipe.spin)} aria-hidden="true" /> : null}
    </div>
  );
}

/**
 * What of this map lives on this computer, and the explicit controls to get
 * the rest.
 *
 * A cloud host has no "this computer": the map is in object storage and every
 * client streams it, so there is nothing to download and nothing to prepare.
 * This module is part of the local host's surface set and is never imported
 * into a cloud build at all — the panel is absent there, not empty, disabled
 * or waiting on a probe to tell it so.
 *
 * The residency rows are the browser closure for the viewport and the semantic
 * closure the local Bevy renderer needs. Every state comes from the local
 * service; nothing here claims a map is ready before its closure is complete
 * and registered.
 */
export function LocalMapPreparationPanel({ map, xstyle }: { map: LocalMapDescriptor; xstyle?: stylex.StyleXStyles }) {
  const cloud = useStudioCloudStatus();
  const router = useRouter();
  const remoteHost = useRemoteHostOrigin();
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
      {...stylex.props(setup.panel, xstyle)}
      data-testid="local-map-preparation"
      data-map-access={map.access}
      data-map-locked={String(locked)}
    >
      <p {...stylex.props([typography.tag, setup.panelLabel])}>{remoteHost ? `On the Studio host (${remoteHost})` : "On this computer"}</p>
      {locked ? (
        <div {...stylex.props([hairline.all, setup.locked])}>
          <Lock {...stylex.props(setup.lockedIcon)} aria-hidden="true" />
          <p {...stylex.props(setup.lockedText)}>
            {cloud.status?.state === "expired" ? "Your SimCloud session ended. Sign in again to use this map on this computer." : cloud.status?.state === "connecting" ? "Finishing the SimCloud sign-in in your browser…" : "This map needs a SimCloud account. Sign in to download and render it on this computer."}
          </p>
          {cloud.status?.state === "connecting" ? <LoaderCircle {...stylex.props(setup.iconSmall, motionRecipe.spin)} aria-hidden="true" /> : (
            <Button xstyle={setup.compactButton} disabled={cloud.status === null} onClick={cloud.openAccountPanel} type="button" variant="accentOutline">
              <LogIn {...stylex.props(setup.iconSmall)} aria-hidden="true" />
              {cloud.status?.state === "expired" ? "Sign in again" : "Sign in to SimCloud"}
            </Button>
          )}
          {cloud.error ? <p {...stylex.props(setup.alert)} role="alert">{cloud.error}</p> : null}
        </div>
      ) : (
        <div {...stylex.props(setup.rows)}>
          <ProfileRow actionLabel="Download for preview" detail="Viewport assets for browsing and authoring on this map." icon={<Globe {...stylex.props(setup.iconSmall)} aria-hidden="true" />} install={browser} label="Browser preview" locked={locked} />
          <ProfileRow actionLabel="Prepare for local render" detail="Full semantic closure the local Bevy renderer reads directly from disk." icon={<Cpu {...stylex.props(setup.iconSmall)} aria-hidden="true" />} install={semantic} label="Local render" locked={locked} />
        </div>
      )}
    </div>
  );
}
