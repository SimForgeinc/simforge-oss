"use client";

/**
 * The seam between a `CloudLoadingSurface` and the one host that paints it.
 *
 * Studio has a single loading design — `CloudLoadingSurface` — and a
 * viewport-scoped one may only ever be *painted* once: the backdrop owns a
 * WebGL context, and two of them handing over (a route loader replaced by the
 * scene loader) would tear the cloud field down and build it again mid
 * transition. So a `scope="screen"` surface mounted under a `CloudLoadingHost`
 * publishes itself here instead of rendering, and the host renders the single
 * instance.
 *
 * This module holds no JSX so both sides can import it without a cycle:
 * `CloudLoadingSurface` reads the context, `CloudLoadingHost` provides it.
 */

import { createContext, useContext, useId, useLayoutEffect, useRef } from "react";
import type { ReactNode } from "react";
// Type-only, so it is erased before runtime and no import cycle exists.
import type { CloudLoadingTelemetry } from "./CloudLoadingSurface";

/** Which kind of work is covering the viewport, lowest priority band first. */
export type CloudLoadingKind = "route" | "scene" | "boot";

/** A screen-scoped `CloudLoadingSurface`'s content, as the host receives it. */
export type CloudLoadingSource = {
  kind: CloudLoadingKind;
  title: string;
  detail?: string | null;
  eyebrow?: string;
  progress?: number | null;
  progressLabel?: string;
  progressValueLabel?: string;
  /** Cooperative liveness signal for long stages whose visible progress is coarse. */
  activityToken?: string | number;
  telemetry?: CloudLoadingTelemetry | null;
  phase?: string;
  priority?: number;
  severity?: "loading" | "error";
  icon?: ReactNode;
  actions?: ReactNode;
};

export type CloudLoadingContextValue = {
  setSource: (id: string, source: CloudLoadingSource | null) => void;
};

export const CloudLoadingContext = createContext<CloudLoadingContextValue | null>(null);

/**
 * Publish `source` to the enclosing host for as long as this component is
 * mounted, and report whether a host took it. `false` means nothing above
 * paints loading surfaces, and the caller renders its own.
 */
export function useCloudLoadingSource(source: CloudLoadingSource | null): boolean {
  const host = useContext(CloudLoadingContext);
  const reactId = useId();
  const sourceId = `cloud-loading-${reactId}`;
  const sourceRef = useRef(source);
  sourceRef.current = source;

  useLayoutEffect(() => {
    if (!host) return;
    host.setSource(sourceId, sourceRef.current);
    return () => host.setSource(sourceId, null);
  }, [host, sourceId]);

  useLayoutEffect(() => {
    host?.setSource(sourceId, source);
  }, [host, source, sourceId]);

  return host !== null;
}
