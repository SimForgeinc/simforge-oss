"use client";

import { useMemo } from "react";
import { CircleAlert } from "lucide-react";
import { CloudLoadingSurface } from "../../../components/CloudLoadingSurface";
import { Button } from "../../../components/ui/button";
import { resolveBlockingNotification } from "./notification-model";
import {
  undismissedNotifications,
  useScenarioNotificationStore,
} from "./notification-store";
import * as stylex from "@stylexjs/stylex";
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
  const isError = blocking.severity === "error";
  return (
    <CloudLoadingSurface
      detail={blocking.detail}
      icon={isError ? <CircleAlert className={stylex.props(styles.size5).className} aria-hidden="true" /> : undefined}
      kind="boot"
      progress={isError ? undefined : (blocking.progress ?? null)}
      role={isError ? "alert" : "status"}
      scope="screen"
      title={blocking.message}
    >
      {blocking.action ? (
        <Button
          xstyle={styles.round}
          onClick={blocking.action.run}
        >
          {blocking.action.label}
        </Button>
      ) : null}
    </CloudLoadingSurface>
  );
}
