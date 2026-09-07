"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  createHttpStudioCloudService,
  StudioHostRequestError,
  type StudioCloudService,
  type StudioCloudStatus,
} from "@simforge-oss/studio-host";
import { studioHost } from "@/app/lib/host";

/**
 * The local SimCloud connector: same-origin `/api/simforge/cloud/*` routes on
 * the local service, which holds the credentials. Separate from `studioHost`
 * on purpose — connecting adds cloud maps and storage, it never swaps the host
 * that owns local projects, jobs and renders.
 */
export const studioCloud: StudioCloudService = createHttpStudioCloudService();

/** How long the app keeps asking the local service whether the browser consent finished. */
const CONNECT_POLL_INTERVAL_MS = 2_000;
const CONNECT_POLL_LIMIT_MS = 5 * 60_000;

export type StudioCloudConnection = {
  /** `null` until the first status read resolves. */
  status: StudioCloudStatus | null;
  /** True while a connect/disconnect/refresh request or the consent poll is in flight. */
  loading: boolean;
  /** Product message for the last failed operation; cleared by the next successful one. */
  error: string | null;
  refresh(): Promise<void>;
  /** Starts the system-browser consent flow and polls status until it settles or times out. */
  connect(): Promise<void>;
  disconnect(): Promise<void>;
};

const StudioCloudContext = createContext<StudioCloudConnection | null>(null);

function cloudErrorMessage(reason: unknown, fallback: string): string {
  if (reason instanceof StudioHostRequestError) return reason.message;
  if (reason instanceof Error && reason.name !== "AbortError" && reason.message) return reason.message;
  return fallback;
}

/**
 * One status reader and one consent poller for the whole dashboard. Polling
 * runs only while the service reports `connecting`, and stops on settle,
 * unmount or the bounded limit — a stuck consent tab never keeps the app
 * hitting the local service forever.
 */
export function StudioCloudProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<StudioCloudStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const poll = useRef<AbortController | null>(null);
  const mapScope = status?.state === "connected" ? status.user?.id : status?.state;
  useEffect(() => {
    if (!mapScope || mapScope === "connecting") return;
    const controller = new AbortController();
    void studioHost.artifacts.listMaps(controller.signal, { fresh: true }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(cloudErrorMessage(reason, "The local map library could not be refreshed."));
    });
    return () => controller.abort();
  }, [mapScope]);

  useEffect(() => {
    const controller = new AbortController();
    const readStatus = () => {
      void studioCloud.status(controller.signal)
        .then((next) => {
          if (!controller.signal.aborted) {
            setStatus(next);
            setError(next.state === "error" ? next.message : null);
          }
        })
        .catch((reason: unknown) => {
          if (!controller.signal.aborted) setError(cloudErrorMessage(reason, "SimCloud connection status is unavailable."));
        });
    };
    readStatus();
    // Browser consent can finish after the bounded poll has stopped.
    const onFocus = () => {
      if (!poll.current) readStatus();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      controller.abort();
      poll.current?.abort();
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      setStatus(await studioCloud.status());
      setError(null);
    } catch (reason) {
      setError(cloudErrorMessage(reason, "SimCloud connection status is unavailable."));
    }
  }, []);

  const pollUntilSettled = useCallback(async () => {
    poll.current?.abort();
    const controller = new AbortController();
    poll.current = controller;
    const deadline = Date.now() + CONNECT_POLL_LIMIT_MS;
    setLoading(true);
    try {
      while (!controller.signal.aborted && Date.now() < deadline) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, CONNECT_POLL_INTERVAL_MS);
          controller.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
        });
        if (controller.signal.aborted) return;
        const next = await studioCloud.status(controller.signal);
        setStatus(next);
        if (next.state !== "connecting") {
          setError(next.state === "error" ? next.message : null);
          return;
        }
      }
      if (!controller.signal.aborted) {
        setError("SimCloud did not confirm the connection in time. Try connecting again.");
      }
    } catch (reason) {
      if (!controller.signal.aborted) setError(cloudErrorMessage(reason, "SimCloud connection status is unavailable."));
    } finally {
      if (poll.current === controller) {
        poll.current = null;
        setLoading(false);
      }
    }
  }, []);

  const connect = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { authorizationUrl } = await studioCloud.connect();
      // The consent page belongs to SimCloud and opens in the system browser;
      // the app itself never navigates away from the local origin.
      const opened = window.open(authorizationUrl, "_blank", "noopener,noreferrer");
      if (opened === null && !window.simforgeDesktop) {
        setError("Your browser blocked the SimCloud sign-in window. Allow pop-ups for this app and try again.");
      }
      setStatus((current) =>
        current ? { ...current, state: "connecting", message: null } : current,
      );
      await pollUntilSettled();
    } catch (reason) {
      setError(cloudErrorMessage(reason, "SimCloud sign-in could not be started."));
      setLoading(false);
    }
  }, [pollUntilSettled]);

  const disconnect = useCallback(async () => {
    poll.current?.abort();
    setLoading(true);
    setError(null);
    try {
      setStatus(await studioCloud.disconnect());
    } catch (reason) {
      setError(cloudErrorMessage(reason, "SimCloud could not be disconnected."));
    } finally {
      setLoading(false);
    }
  }, []);

  const value = useMemo<StudioCloudConnection>(
    () => ({ status, loading, error, refresh, connect, disconnect }),
    [status, loading, error, refresh, connect, disconnect],
  );

  return <StudioCloudContext.Provider value={value}>{children}</StudioCloudContext.Provider>;
}

export function useStudioCloudStatus(): StudioCloudConnection {
  const value = useContext(StudioCloudContext);
  if (!value) {
    throw new Error("useStudioCloudStatus() requires a <StudioCloudProvider> above the dashboard tree.");
  }
  return value;
}
