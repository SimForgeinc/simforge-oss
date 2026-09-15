"use client";

/**
 * The desktop side of the shared evaluation surface.
 *
 * Two things the shared components need and cannot work out for themselves:
 * the gateway (which on this host goes through the local service's
 * authenticated cloud proxy, because the renderer holds no credentials) and the
 * host snapshot that decides whether local execution is even offerable.
 */

import { useMemo } from "react";
import {
  createHttpEvaluationGateway,
  DESKTOP_COMPUTE_PROXY_PATH,
  type EvaluationGateway,
} from "@simforge-oss/evaluation/client";
import type { HostExecutionSnapshot } from "@simforge-oss/studio-ui/evaluation";
import { useStudioHostCapabilities } from "@simforge-oss/studio-host/react";
import { studioHost } from "@/app/lib/host";
import { useStudioCloudStatus } from "@/app/lib/host/cloud";

/**
 * Without a selection the call acts in the session's active organization; a
 * picker selection is an explicit override carried by the gateway's
 * organization header.
 */
export function useEvaluationGateway(organizationId: string | null = null): EvaluationGateway {
  return useMemo(
    () =>
      createHttpEvaluationGateway({
        basePath: DESKTOP_COMPUTE_PROXY_PATH,
        organizationId,
      }),
    [organizationId],
  );
}

/**
 * The desktop's capability report, reduced to the two axes the shared UI reads.
 *
 * `nativeRuntime.available === false` is a first-class state with the probe's
 * own reason attached: the model picker prints it instead of silently offering
 * a local run that would fail.
 */
export function useHostExecutionSnapshot(organizationId: string | null): HostExecutionSnapshot {
  const capabilities = useStudioHostCapabilities(studioHost);
  const cloud = useStudioCloudStatus();

  return useMemo(() => {
    const runtime = capabilities.capabilities?.execution.nativeRuntime;
    const status = cloud.status;
    return {
      host: "desktop",
      nativeRuntime:
        runtime === undefined
          ? null
          : runtime.state === "available"
            ? { available: true, reason: null }
            : { available: false, reason: runtime.reason },
      cloud: {
        connected: status?.state === "connected",
        organizationId,
        reason:
          status === null
            ? "Checking the SimCloud connection…"
            : status.state === "connected"
              ? null
              : status.state === "expired"
                ? "Your SimCloud session expired. Sign in again in SimCloud to submit cloud runs."
                : "Connect a SimCloud account in SimCloud to submit cloud runs. Cloud runs do not require downloading any weights.",
      },
    };
  }, [capabilities.capabilities, cloud.status, organizationId]);
}
