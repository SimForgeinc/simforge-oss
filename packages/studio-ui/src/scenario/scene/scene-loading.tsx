"use client";

import { useMemo } from "react";
import { RotateCcw } from "lucide-react";
import type { CloudLoadingSurfaceProps } from "../../components/CloudLoadingSurface";
import { Button } from "../../components/ui/button";
import { scene } from "../scenario-controls.stylex";
import type { SceneLoadProgress } from "./map-load-progress";
import { CacheAllMapAssetsButton } from "./CacheAllMapAssetsButton";

/**
 * A scene load, expressed as `CloudLoadingSurface` props.
 *
 * The scene cover is the same surface every other loading state is; only its
 * content is scene-specific, so this is a mapper rather than a component. It
 * is memoized because the props carry elements: the host compares published
 * sources field by field and a fresh `icon` every render would republish.
 */
export function useSceneLoadingSurfaceProps(
  progress: SceneLoadProgress,
  onRetry?: (() => void) | null,
): Omit<CloudLoadingSurfaceProps, "scope"> {
  const failed = progress.phase === "error";
  return useMemo(
    () => ({
      kind: "scene",
      title: progress.message,
      detail: progress.detail,
      progress: failed ? undefined : (progress.percent ?? null),
      telemetry: progress.download,
      phase: progress.phase,
      role: failed ? "alert" : "status",
      icon: failed ? <RotateCcw className="size-5" aria-hidden="true" /> : undefined,
      children: (
        <>
          {failed && onRetry ? (
            <Button
              xstyle={scene.retry}
              onClick={onRetry}
            >
              <RotateCcw className="size-4" aria-hidden="true" />
              Try again
            </Button>
          ) : null}
          <CacheAllMapAssetsButton />
        </>
      ),
    }),
    [failed, onRetry, progress],
  );
}
