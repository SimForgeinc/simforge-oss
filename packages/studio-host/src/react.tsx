"use client";

import { useEffect, useState } from "react";
import type { StudioHostCapabilities } from "./capabilities";
import type { StudioHostServices } from "./services";

export type StudioHostCapabilitiesState =
  | { status: "loading"; capabilities: null; error: null }
  | { status: "ready"; capabilities: StudioHostCapabilities; error: null }
  | { status: "error"; capabilities: null; error: Error };

/** The host's current capability report, shared across callers for a minute by the host client. */
export function useStudioHostCapabilities(host: StudioHostServices): StudioHostCapabilitiesState {
  const [state, setState] = useState<StudioHostCapabilitiesState>({ status: "loading", capabilities: null, error: null });
  useEffect(() => {
    const abort = new AbortController();
    host.runtime.capabilities({ signal: abort.signal }).then(
      (capabilities) => setState({ status: "ready", capabilities, error: null }),
      (error: unknown) => {
        if (abort.signal.aborted) return;
        setState({ status: "error", capabilities: null, error: error instanceof Error ? error : new Error(String(error)) });
      },
    );
    return () => abort.abort();
  }, [host]);
  return state;
}
