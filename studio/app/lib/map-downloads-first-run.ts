"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { StudioHostCapabilities } from "@simforge-oss/studio-host";
import {
  isMapDownloadsFirstRunPending,
  markMapDownloadsFirstRunSeen,
  subscribeMapDownloadsFirstRun,
} from "@simforge-oss/studio-ui/map-downloads";

/**
 * Whether this signed-in person has yet to be shown Map Downloads, and the
 * call that records they have been.
 *
 * Only an account session has a first sign-in: a local installation has one
 * fixed owner and its own first-run onboarding. The record is per browser and
 * per user id (see `first-run.ts` in studio-ui for why there is no server-side
 * copy), and it is written as soon as the view is shown, not when a download
 * starts, so a reload never brings it back.
 *
 * Every caller reads one store: the top bar and the switcher page both ask,
 * and the moment either shows the view the other's answer turns false.
 */
export function useMapDownloadsFirstRun(capabilities: StudioHostCapabilities | null): {
  pending: boolean;
  markSeen: () => void;
} {
  const userId = capabilities?.identity.mode === "account" ? capabilities.identity.userId : null;
  const pending = useSyncExternalStore(
    subscribeMapDownloadsFirstRun,
    () => isMapDownloadsFirstRunPending(userId),
    // The server never knows this browser's record.
    () => false,
  );
  const markSeen = useCallback(() => markMapDownloadsFirstRunSeen(userId), [userId]);
  return { pending, markSeen };
}
