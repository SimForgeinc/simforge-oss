"use client";

import { useStudioHost } from "@simforge-oss/studio-ui/host";
import { useStudioHostCapabilities } from "@simforge-oss/studio-host/react";
import type { DatasetHomeHook } from "../contract";

/** Managed datasets already come from the authorized workspace, never a second connector. */
export const useDatasetCloudHome: DatasetHomeHook = () => {
  const result = useStudioHostCapabilities(useStudioHost());
  if (result.status === "loading") return { state: "managed-loading" };
  if (result.status === "error") return { state: "managed-unavailable", message: result.error.message };
  const identity = result.capabilities.identity;
  return {
    state: "managed",
    workspaceId: identity.workspaceId,
    organizationId: identity.organizationId,
    workspaceName: identity.displayName ?? result.capabilities.host.label,
  };
};
