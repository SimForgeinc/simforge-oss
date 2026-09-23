"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ScenarioVersionsDto } from "@simforge-oss/studio-host";

import { useStudioHost } from "../../../host";
import { onVersionsChanged } from "./versions-events";

export type DocumentVersionsState =
  | { readonly status: "idle" }
  | { readonly status: "loading"; readonly previous: ScenarioVersionsDto | null }
  | { readonly status: "ready"; readonly versions: ScenarioVersionsDto }
  | { readonly status: "error"; readonly message: string };

/** The document's versions while `enabled`, reloaded whenever they change. */
export function useDocumentVersions(documentId: string | null, enabled: boolean) {
  const studioHost = useStudioHost();
  const [state, setState] = useState<DocumentVersionsState>({ status: "idle" });
  const generation = useRef(0);
  const latest = useRef<ScenarioVersionsDto | null>(null);

  const reload = useCallback(() => {
    if (!documentId) return;
    const current = ++generation.current;
    setState({ status: "loading", previous: latest.current });
    studioHost.projects.listVersions(documentId).then((versions) => {
      if (current !== generation.current) return;
      latest.current = versions;
      setState({ status: "ready", versions });
    }).catch((reason: unknown) => {
      if (current !== generation.current) return;
      setState({ status: "error", message: reason instanceof Error ? reason.message : String(reason) });
    });
  }, [documentId, studioHost]);

  useEffect(() => {
    if (!enabled || !documentId) return;
    reload();
    return onVersionsChanged((changed) => {
      if (changed === documentId) reload();
    });
  }, [documentId, enabled, reload]);

  return { state, reload };
}
