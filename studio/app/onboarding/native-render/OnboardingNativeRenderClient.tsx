"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { NativeRenderInstall } from "@simforge-oss/studio-host";
import { NativeRenderScreen } from "@simforge-oss/studio-ui/onboarding";
import { readNativeRenderInstall, startNativeRenderInstall } from "@/app/lib/host/native-render";

const MAP_GALLERY_PATH = "/dashboard/map-assets";
const POLL_MS = 1_500;

/**
 * Step 3: offer the native render runtime. Setup itself was completed by the
 * maps step, so leaving here (install or skip) just goes to the dashboard;
 * an install in flight keeps running on the host either way.
 */
export function OnboardingNativeRenderClient() {
  const router = useRouter();
  const [install, setInstall] = useState<NativeRenderInstall | null>(null);
  const [error, setError] = useState<string | null>(null);
  const installing = install?.state === "installing";

  // One read on mount, then a poll while the host reports an install running.
  useEffect(() => {
    const controller = new AbortController();
    const read = () =>
      readNativeRenderInstall(controller.signal)
        .then((next) => {
          setInstall(next);
          setError(null);
        })
        .catch((reason: unknown) => {
          if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "The host could not be reached.");
        });
    void read();
    const timer = installing ? window.setInterval(() => void read(), POLL_MS) : null;
    return () => {
      controller.abort();
      if (timer !== null) window.clearInterval(timer);
    };
  }, [installing]);

  const view = install
    ? { ...install, error: install.error ?? error }
    : error
      ? { state: "failed" as const, reasons: [], steps: [], error }
      : null;

  return (
    <NativeRenderScreen
      install={view}
      loading={view === null}
      onContinue={() => router.replace(MAP_GALLERY_PATH)}
      onInstall={() => {
        void startNativeRenderInstall()
          .then(setInstall)
          .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "The install could not start."));
      }}
    />
  );
}
