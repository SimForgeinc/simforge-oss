"use client";

import { useStudioHost } from "../../host";
import { Check, Database } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { CloudActivityIndicator } from "../../components/CloudLoadingSurface";
import { readRenderingPreference } from "../../components/rendering-preference"
import { Button } from "../../components/ui/button";
import {
  cacheProfileMapPlan,
  createProfileMapPlan,
  type ProfileMapCacheProgress,
} from "../../lib/scenario/editor/profile-map-cache";

type State = "idle" | "planning" | "downloading" | "complete" | "error";

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function CacheAllMapAssetsButton() {
  const studioHost = useStudioHost();
  const [state, setState] = useState<State>("idle");
  const [progress, setProgress] = useState<ProfileMapCacheProgress | null>(null);
  const [error, setError] = useState("");
  const operation = useRef<AbortController | null>(null);

  useEffect(() => () => operation.current?.abort(), []);

  const start = async () => {
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    const profile = readRenderingPreference() ?? "high";
    setState("planning");
    setError("");
    setProgress(null);
    try {
      const maps = await studioHost.artifacts.listMaps(controller.signal);
      const plan = await createProfileMapPlan(maps, profile, controller.signal);
      if (controller.signal.aborted) return;
      if (plan.remainingAssets === 0) {
        setState("complete");
        return;
      }
      setState("downloading");
      const result = await cacheProfileMapPlan(plan, controller.signal, setProgress);
      if (result.failedAssets > 0) {
        throw new Error(`${result.failedAssets} assets could not be verified and cached.`);
      }
      setState("complete");
    } catch (reason) {
      if (controller.signal.aborted) return;
      setError(reason instanceof Error ? reason.message : "Map caching failed.");
      setState("error");
    }
  };

  const percent = progress?.totalBytes
    ? Math.round((progress.completedBytes / progress.totalBytes) * 100)
    : progress?.totalAssets
      ? Math.round((progress.completedAssets / progress.totalAssets) * 100)
      : 0;

  return (
    <div className="mt-7 border-t border-white/10 pt-4" data-testid="cache-all-map-assets">
      <Button
        className="h-auto min-h-10 w-full justify-start rounded-full border border-[#E8E044] bg-[#E8E044] px-4 py-2 text-left text-xs font-semibold text-neutral-950 shadow-[0_0_24px_rgba(232,224,68,0.16)] hover:bg-[#F3EB4F] hover:text-black focus-visible:ring-[#E8E044] focus-visible:ring-offset-2 focus-visible:ring-offset-black"
        disabled={state === "planning" || state === "downloading" || state === "complete"}
        onClick={() => void start()}
        type="button"
        variant="ghost"
      >
        {state === "planning" || state === "downloading" ? (
          <CloudActivityIndicator iconClassName="size-4 text-neutral-950" />
        ) : state === "complete" ? (
          <Check className="size-4 shrink-0" aria-hidden="true" />
        ) : (
          <Database className="size-4 shrink-0" aria-hidden="true" />
        )}
        <span>
          {state === "idle"
            ? "Tip: Click here to cache all assets."
            : state === "planning"
              ? "Calculating the complete offline map library…"
              : state === "downloading"
                ? `Caching all map assets · ${percent}%${progress ? ` · ${formatBytes(progress.completedBytes)} / ${formatBytes(progress.totalBytes)}` : ""}`
                : state === "complete"
                  ? "Every published map closure is fully cached."
                  : "Caching stopped. Click to retry."}
        </span>
      </Button>
      {error ? <p className="mt-2 px-3 text-xs leading-5 text-red-300" role="alert">{error}</p> : null}
    </div>
  );
}
