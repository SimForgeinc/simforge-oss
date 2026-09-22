"use client";

import { useMemo } from "react";
import { RouteErrorState } from "../../../components/state-frames";
import { CloudLoadingSurface } from "../../../components/CloudLoadingSurface";
import { Button } from "../../../components/ui/button";
import { resolveBlockingNotification } from "./notification-model";
import {
  undismissedNotifications,
  useScenarioNotificationStore,
} from "./notification-store";
import { styles } from "./ScenarioBootGate.stylex";

/**
 * Publishes editor-blocking work into Studio's single viewport loader. The
 * editor stays mounted beneath the cover, so progress changes never replace
 * its WebGL context or compete with the scene loader for a second overlay:
 * the `CloudLoadingHost` above resolves the two into one surface.
 */
export function ScenarioBootGate() {
  const entries = useScenarioNotificationStore((state) => state.entries);
  const dismissedRevisionByKey = useScenarioNotificationStore(
    (state) => state.dismissedRevisionByKey,
  );

  const blocking = useMemo(
    () =>
      resolveBlockingNotification(
        undismissedNotifications(entries, dismissedRevisionByKey),
      ),
    [dismissedRevisionByKey, entries],
  );

  if (!blocking) return null;
  if (blocking.severity === "error") return (
    <RouteErrorState title={blocking.message} description={blocking.detail}
      onRetry={blocking.action?.run ?? (() => window.location.reload())}
      exitHref="/dashboard/scenario" exitLabel="Back to scenarios" xstyle={styles.errorCover} />
  );
  return (
    <CloudLoadingSurface
      detail={blocking.detail}
      kind="boot"
      progress={blocking.progress ?? null}
      role="status"
      scope="screen"
      title={blocking.message}
    >
      {blocking.action ? (
        <Button size="lg"
          xstyle={styles.round}
          onClick={blocking.action.run}
        >
          {blocking.action.label}
        </Button>
      ) : null}
    </CloudLoadingSurface>
  );
}
