"use client";

import { useMemo } from "react";
import { CircleAlert } from "lucide-react";
import {
  useDashboardLoadingSource,
  type DashboardLoadingSource,
} from "../../../components/DashboardLoadingCoordinator";
import { Button } from "../../../components/ui/button";
import { resolveBlockingNotification } from "./notification-model";
import {
  undismissedNotifications,
  useScenarioNotificationStore,
} from "./notification-store";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./ScenarioBootGate.stylex";

/**
 * Publishes editor-blocking work into the dashboard's single viewport loader.
 * The editor stays mounted beneath the cover, so progress changes never replace
 * its WebGL context or compete with the scene loader for a second overlay.
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

  const source = useMemo<DashboardLoadingSource | null>(() => {
    if (!blocking) return null;
    const isError = blocking.severity === "error";
    return {
      kind: "boot",
      title: blocking.message,
      detail: blocking.detail,
      eyebrow: isError ? "Editor interrupted" : "Preparing editor",
      progress: isError ? undefined : (blocking.progress ?? null),
      progressLabel: "Editor workspace",
      severity: isError ? "error" : "loading",
      icon: isError ? <CircleAlert className={stylex.props(styles.size5).className} aria-hidden="true" /> : undefined,
      actions: blocking.action ? (
        <Button
          xstyle={styles.round}
          onClick={blocking.action.run}
        >
          {blocking.action.label}
        </Button>
      ) : undefined,
    };
  }, [blocking]);

  useDashboardLoadingSource(source);
  return null;
}
