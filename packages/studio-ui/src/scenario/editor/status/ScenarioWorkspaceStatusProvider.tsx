"use client";

import type { ReactNode } from "react";
import { ScenarioBootGate } from "./ScenarioBootGate";
import { ScenarioNotificationDock } from "./ScenarioNotificationDock";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./ScenarioWorkspaceStatusProvider.stylex";

/**
 * Mounts the v2 editor's two status renderers: the bottom-right notification
 * dock, and the boot gate for the statuses that mean the page is not usable yet.
 *
 * `useScenarioWorkspaceStatus` and `useScenarioNotification` publish into
 * a store, so a publisher does not have to be inside this subtree to be heard —
 * but nothing is *rendered* unless this is mounted somewhere above. That is the
 * failure mode worth naming: a ported panel that publishes a status with no
 * provider mounted looks exactly like a panel that publishes nothing.
 *
 * Both renderers are `fixed` overlays rather than flow children, so appearing
 * and disappearing never reflows the canvas.
 */
export function ScenarioWorkspaceStatusProvider({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <div {...stylex.props(styles.flexColTall)}>
      <div {...stylex.props(styles.fillShrinkable)}>{children}</div>
      <ScenarioNotificationDock />
      <ScenarioBootGate />
    </div>
  );
}
